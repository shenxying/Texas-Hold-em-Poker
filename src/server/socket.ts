import type { Server, Socket } from 'socket.io';
import { applyAction, createHand, getLegalActions } from '../game/engine';
import type { GameEvent, PlayerAction } from '../game/types';
import { botDelayMs, chooseBotAction, type BotInput } from './ai';
import type {
  BotStyle,
  ClientToServerEvents,
  CommandAck,
  CommandError,
  CommandResponse,
  RoomSettings,
  ServerToClientEvents,
  SessionInfo,
} from '../shared/protocol';
import type { Room, RoomPlayer, RoomService } from './room';
import {
  ActionTimerRegistry,
  DisconnectTimerRegistry,
  type Scheduler,
} from './timers';
import { createTableView } from './views';

interface SocketData {
  roomCode?: string;
  sessionToken?: string;
  playerId?: string;
}

type PokerIo = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type PokerSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface PokerSocketOptions {
  rooms: RoomService;
  scheduler: Scheduler;
  randomInt?: (max: number) => number;
  random: () => number;
  chooseBotAction?: (input: BotInput, random: () => number) => PlayerAction;
  onUnexpectedError?: (context: { command: string; roomCode?: string }, error: unknown) => void;
}

class SocketRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SocketRuleError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SocketRuleError('INVALID_COMMAND', 'Invalid command payload');
  }
  return value;
}

function settingsPatch(value: unknown): Partial<RoomSettings> {
  const input = recordInput(value);
  const allowed = new Set(['startingStack', 'smallBlind', 'bigBlind']);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new SocketRuleError('INVALID_COMMAND', 'Invalid settings');
  }
  const patch: Partial<RoomSettings> = {};
  for (const field of allowed as Set<keyof RoomSettings>) {
    const setting = input[field];
    if (setting === undefined) continue;
    if (!Number.isInteger(setting)) {
      throw new SocketRuleError('INVALID_COMMAND', `Invalid ${field}`);
    }
    patch[field] = setting as number;
  }
  return patch;
}
function stringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string') {
    throw new SocketRuleError('INVALID_COMMAND', `Invalid ${field}`);
  }
  return value;
}
function playerAction(value: unknown, playerId: string): PlayerAction {
  const input = recordInput(value);
  const type = stringField(input, 'type');
  if (type === 'bet' || type === 'raise') {
    if (!Number.isInteger(input.amount)) {
      throw new SocketRuleError('INVALID_COMMAND', 'Invalid action amount');
    }
    return { playerId, type, amount: input.amount as number };
  }
  if (type === 'fold' || type === 'check' || type === 'call' || type === 'all-in') {
    return { playerId, type };
  }
  throw new SocketRuleError('INVALID_COMMAND', 'Invalid action type');
}

function toSessionInfo(result: {
  roomCode: string;
  sessionToken: string;
  playerId: string;
  waitingPosition?: number;
}): SessionInfo {
  return {
    roomCode: result.roomCode,
    sessionToken: result.sessionToken,
    playerId: result.playerId,
    ...(result.waitingPosition === undefined ? {} : { waitingPosition: result.waitingPosition }),
  };
}

function roomPlayers(room: Room): RoomPlayer[] {
  return [
    ...room.seats.filter((player): player is RoomPlayer => player !== null),
    ...room.waiting,
  ];
}

function nextDealerIndex(room: Room, seated: readonly RoomPlayer[]): number {
  const eligibleSeatIndexes = new Set(seated.map((player) => player.seatIndex!));
  const start = room.dealerSeatIndex === undefined
    ? 0
    : (room.dealerSeatIndex + 1) % room.seats.length;
  for (let offset = 0; offset < room.seats.length; offset += 1) {
    const seatIndex = (start + offset) % room.seats.length;
    if (!eligibleSeatIndexes.has(seatIndex)) continue;
    room.dealerSeatIndex = seatIndex;
    return seated.findIndex((player) => player.seatIndex === seatIndex);
  }
  throw new SocketRuleError('NOT_ENOUGH_PLAYERS', 'No eligible dealer seat exists');
}

function commandError(error: unknown): CommandError {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as Error & { code?: unknown }).code === 'string'
  ) {
    return {
      code: (error as Error & { code: string }).code,
      message: error.message,
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'Unexpected server error' };
}

export function registerPokerSocketHandlers(io: PokerIo, options: PokerSocketOptions): () => void {
  const { rooms } = options;
  const actionTimers = new ActionTimerRegistry(options.scheduler);
  const disconnectTimers = new DisconnectTimerRegistry(options.scheduler);
  const actionHistories = new Map<string, PlayerAction[]>();
  const scheduledTurns = new Map<string, {
    room: Room;
    hand: NonNullable<Room['hand']>;
    actorId: string;
  }>();
  let disposed = false;

  function broadcast(room: Room): void {
    for (const player of roomPlayers(room)) {
      if (!player.connected || player.connectionId === undefined) continue;
      const target = io.sockets.sockets.get(player.connectionId);
      if (target === undefined) continue;
      target.emit('table:snapshot', createTableView(room, player.id));
    }
  }

  function settlementPayouts(
    room: Room,
    events: readonly GameEvent[],
  ): Array<{ nickname: string; amount: number }> {
    const settled = events.find((event) => event.type === 'hand-settled');
    if (settled?.type === 'hand-settled') {
      return Object.entries(settled.settlement.payouts)
        .filter(([, amount]) => amount > 0)
        .map(([playerId, amount]) => ({
          nickname: roomPlayers(room).find((player) => player.id === playerId)?.nickname ?? playerId,
          amount,
        }));
    }
    const uncontested = events.find((event) => event.type === 'uncontested-awarded');
    if (uncontested?.type === 'uncontested-awarded') {
      return [{
        nickname: roomPlayers(room).find(
          (player) => player.id === uncontested.playerId,
        )?.nickname ?? uncontested.playerId,
        amount: uncontested.amount,
      }];
    }
    return [];
  }

  function finishHandIfNeeded(room: Room, events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.type !== 'hand-settled') continue;
      for (const revealed of event.revealedHands) {
        room.revealedPlayerIds.add(revealed.playerId);
      }
    }
    if (room.hand?.street !== 'complete') return;
    const payouts = settlementPayouts(room, events);
    room.phase = 'between-hands';
    rooms.completeHand(room.code);
    rooms.recordSystemEvent(
      room.code,
      { type: 'hand-settled', payouts },
      options.scheduler.now(),
    );
  }

  function botInput(room: Room, actorId: string): BotInput {
    const hand = room.hand!;
    const handPlayer = hand.players.find((player) => player.id === actorId)!;
    const roomPlayer = roomPlayers(room).find((player) => player.id === actorId)!;
    const actorIndex = hand.players.indexOf(handPlayer);
    const distanceFromDealer =
      (actorIndex - hand.dealerIndex + hand.players.length) % hand.players.length;
    const position = hand.players.length <= 1
      ? 0.5
      : distanceFromDealer / (hand.players.length - 1);
    const largestOpponentStack = Math.max(
      0,
      ...hand.players
        .filter((player) => player.id !== actorId && !player.folded)
        .map((player) => player.stack),
    );

    return {
      playerId: actorId,
      style: roomPlayer.botStyle!,
      holeCards: handPlayer.holeCards.map((card) => ({ ...card })),
      board: hand.board.map((card) => ({ ...card })),
      legalActions: getLegalActions(hand, actorId),
      pot: hand.players.reduce((total, player) => total + player.totalCommitted, 0),
      position,
      actionHistory: (actionHistories.get(room.code) ?? []).map((action) => ({ ...action })),
      effectiveStack: Math.min(handPlayer.stack, largestOpponentStack),
    };
  }

  function scheduleNextAction(room: Room): void {
    const hand = room.hand;
    const actorId = hand?.actorId;
    const existingTurn = scheduledTurns.get(room.code);
    const actor = actorId === undefined || actorId === null
      ? undefined
      : roomPlayers(room).find((player) => player.id === actorId);
    if (
      room.phase === 'playing' &&
      hand !== undefined &&
      actorId !== undefined &&
      actorId !== null &&
      existingTurn?.room === room &&
      existingTurn.hand === hand &&
      existingTurn.actorId === actorId
    ) return;

    actionTimers.clear(room.code);
    scheduledTurns.delete(room.code);
    delete room.actionDeadline;
    if (
      room.phase !== 'playing' ||
      hand === undefined ||
      actorId === undefined ||
      actorId === null
    ) return;

    const scheduledTurn = { room, hand, actorId };
    scheduledTurns.set(room.code, scheduledTurn);
    if (actor?.isBot) {
      actionTimers.replace(room.code, () => {
        const currentRoom = rooms.getRoom(room.code);
        if (
          currentRoom !== room ||
          currentRoom.phase !== 'playing' ||
          currentRoom.hand !== hand ||
          scheduledTurns.get(room.code) !== scheduledTurn ||
          currentRoom.hand.actorId !== actorId
        ) {
          return;
        }
        const policy = options.chooseBotAction ?? chooseBotAction;
        const action = policy(botInput(room, actorId), options.random);
        if (action.playerId !== actorId) {
          throw new SocketRuleError('INVALID_BOT_ACTION', 'Bot returned an action for another player');
        }
        applyRoomAction(room, action);
      }, botDelayMs(options.random));
      return;
    }

    room.actionDeadline = options.scheduler.now() + 30_000;
    actionTimers.replace(room.code, () => {
      const currentRoom = rooms.getRoom(room.code);
      if (
        currentRoom !== room ||
        currentRoom.phase !== 'playing' ||
        currentRoom.hand !== hand ||
        scheduledTurns.get(room.code) !== scheduledTurn ||
        currentRoom.hand.actorId !== actorId
      ) {
        return;
      }
      const legal = getLegalActions(hand, actorId);
      const actionType: 'check' | 'fold' = legal.canCheck ? 'check' : 'fold';
      const action: PlayerAction = {
        playerId: actorId,
        type: actionType,
      };
      const nickname = roomPlayers(room).find((player) => player.id === actorId)?.nickname ?? actorId;
      rooms.recordSystemEvent(
        room.code,
        { type: 'timeout-action', nickname, action: actionType },
        options.scheduler.now(),
      );
      applyRoomAction(room, action);
    }, 30_000);
  }

  function applyRoomAction(room: Room, action: PlayerAction): void {
    const transition = applyAction(room.hand!, action);
    actionTimers.clear(room.code);
    scheduledTurns.delete(room.code);
    delete room.actionDeadline;
    const history = actionHistories.get(room.code) ?? [];
    history.push({ ...action });
    actionHistories.set(room.code, history);
    room.hand = transition.state;
    finishHandIfNeeded(room, transition.events);
    room.version += 1;
    scheduleNextAction(room);
    broadcast(room);
  }

  function assertUnbound(socket: PokerSocket): void {
    if (
      socket.data.roomCode !== undefined ||
      socket.data.sessionToken !== undefined ||
      socket.data.playerId !== undefined
    ) {
      throw new SocketRuleError('SOCKET_ALREADY_BOUND', 'Socket is already bound to a session');
    }
  }

  function bind(socket: PokerSocket, session: SessionInfo): void {
    socket.data.roomCode = session.roomCode;
    socket.data.sessionToken = session.sessionToken;
    socket.data.playerId = session.playerId;
    void socket.join(session.roomCode);
  }

  function current(socket: PokerSocket): { room: Room; player: RoomPlayer; token: string } {
    const { roomCode, playerId, sessionToken } = socket.data;
    if (roomCode === undefined || playerId === undefined || sessionToken === undefined) {
      throw new SocketRuleError('INVALID_SESSION', 'Socket is not bound to a session');
    }
    const room = rooms.getRoom(roomCode);
    const player = room === undefined
      ? undefined
      : roomPlayers(room).find((candidate) => candidate.id === playerId);
    if (room === undefined || player === undefined || player.sessionToken !== sessionToken) {
      throw new SocketRuleError('INVALID_SESSION', 'Session does not exist');
    }
    if (player.connectionId !== socket.id) {
      throw new SocketRuleError('SESSION_REPLACED', 'Session is active on another connection');
    }
    return { room, player, token: sessionToken };
  }

  function scheduleExpiry(
    token: string,
    room: Room,
    player: RoomPlayer,
    disconnectedAt: number,
  ): void {
    disconnectTimers.replace(token, () => {
      const currentRoom = rooms.getRoom(room.code);
      const currentPlayer = currentRoom === undefined
        ? undefined
        : roomPlayers(currentRoom).find((candidate) => candidate === player);
      if (
        currentRoom !== room ||
        currentPlayer === undefined ||
        currentPlayer.connected ||
        currentPlayer.disconnectedAt !== disconnectedAt ||
        options.scheduler.now() - disconnectedAt < 300_000
      ) {
        return;
      }

      const events = rooms.expireDisconnected(options.scheduler.now());
      const changedRoomCodes = new Set(events.map((event) => event.roomCode));
      for (const roomCode of changedRoomCodes) {
        const changedRoom = rooms.getRoom(roomCode);
        if (changedRoom === undefined) {
          actionTimers.clear(roomCode);
          scheduledTurns.delete(roomCode);
          actionHistories.delete(roomCode);
          continue;
        }
        changedRoom.version += 1;
        scheduleNextAction(changedRoom);
        broadcast(changedRoom);
      }
    }, 300_000);
  }

  function respond<T>(
    socket: PokerSocket,
    command: string,
    ack: CommandAck<T>,
    run: () => T,
  ): void {
    let response: CommandResponse<T>;
    try {
      response = { ok: true, data: run() };
    } catch (error) {
      const normalized = commandError(error);
      if (normalized.code === 'INTERNAL_ERROR') {
        options.onUnexpectedError?.(
          {
            command,
            ...(socket.data.roomCode === undefined ? {} : { roomCode: socket.data.roomCode }),
          },
          error,
        );
      }
      socket.emit('command:error', normalized);
      response = { ok: false, error: normalized };
    }
    if (typeof ack === 'function') ack(response);
  }

  io.on('connection', (socket) => {
    socket.on('room:create', (untrustedInput, ack) => {
      respond(socket, 'room:create', ack, () => {
        assertUnbound(socket);
        const input = recordInput(untrustedInput);
        const settings = input.settings === undefined ? undefined : settingsPatch(input.settings);
        const result = rooms.createRoom({
          nickname: stringField(input, 'nickname'),
          ...(settings === undefined ? {} : { settings }),
          connectionId: socket.id,
        });
        const session = toSessionInfo(result);
        bind(socket, session);
        const room = rooms.getRoom(result.roomCode)!;
        room.version += 1;
        broadcast(room);
        return session;
      });
    });

    socket.on('room:join', (untrustedInput, ack) => {
      respond(socket, 'room:join', ack, () => {
        assertUnbound(socket);
        const input = recordInput(untrustedInput);
        const result = rooms.joinRoom({
          roomCode: stringField(input, 'roomCode'),
          nickname: stringField(input, 'nickname'),
          connectionId: socket.id,
        });
        const session = toSessionInfo(result);
        bind(socket, session);
        const room = rooms.getRoom(result.roomCode)!;
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return session;
      });
    });

    socket.on('room:reconnect', (untrustedInput, ack) => {
      respond(socket, 'room:reconnect', ack, () => {
        assertUnbound(socket);
        const input = recordInput(untrustedInput);
        const token = stringField(input, 'sessionToken');
        const result = rooms.reconnect(token, socket.id);
        const session = toSessionInfo(result);
        disconnectTimers.clear(token);
        bind(socket, session);
        if (result.replacedConnectionId !== undefined) {
          io.sockets.sockets.get(result.replacedConnectionId)?.emit(
            'session:replaced',
            { roomCode: result.roomCode },
          );
        }
        const room = rooms.getRoom(result.roomCode)!;
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return session;
      });
    });
    socket.on('room:update-settings', (untrustedInput, ack) => {
      respond(socket, 'room:update-settings', ack, () => {
        const input = recordInput(untrustedInput);
        const { room, token } = current(socket);
        rooms.updateSettings(token, settingsPatch(input.settings));
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return {};
      });
    });

    socket.on('room:add-bot', (untrustedInput, ack) => {
      respond(socket, 'room:add-bot', ack, () => {
        const input = recordInput(untrustedInput);
        const { room, token } = current(socket);
        rooms.addBot(token, stringField(input, 'style') as BotStyle);
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return {};
      });
    });

    socket.on('room:remove-bot', (untrustedInput, ack) => {
      respond(socket, 'room:remove-bot', ack, () => {
        const input = recordInput(untrustedInput);
        const { room, token } = current(socket);
        rooms.removeBot(token, stringField(input, 'playerId'));
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return {};
      });
    });

    socket.on('room:reset-stack', (untrustedInput, ack) => {
      respond(socket, 'room:reset-stack', ack, () => {
        const input = recordInput(untrustedInput);
        const { room, token } = current(socket);
        rooms.resetStack(token, stringField(input, 'playerId'));
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return {};
      });
    });

    socket.on('chat:send', (untrustedInput, ack) => {
      respond(socket, 'chat:send', ack, () => {
        const input = recordInput(untrustedInput);
        const { room, token } = current(socket);
        const message = rooms.sendChat(
          token,
          stringField(input, 'text'),
          options.scheduler.now(),
        );
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return { message };
      });
    });
    socket.on('game:start', (untrustedInput, ack) => {
      respond(socket, 'game:start', ack, () => {
        recordInput(untrustedInput);
        const { room, player } = current(socket);
        if (room.hostPlayerId !== player.id) {
          throw new SocketRuleError('NOT_HOST', 'Only the host can perform this action');
        }
        if (room.phase === 'playing') {
          throw new SocketRuleError('HAND_IN_PROGRESS', 'A hand is already in progress');
        }
        const seated = room.seats.filter(
          (candidate): candidate is RoomPlayer => candidate !== null && candidate.stack > 0,
        );
        if (seated.length < 2) {
          throw new SocketRuleError(
            'NOT_ENOUGH_PLAYERS',
            'At least two players with chips are required',
          );
        }
        room.hand = createHand({
          seats: seated.map((candidate) => ({ id: candidate.id, stack: candidate.stack })),
          dealerIndex: nextDealerIndex(room, seated),
          smallBlind: room.settings.smallBlind,
          bigBlind: room.settings.bigBlind,
          ...(options.randomInt === undefined ? {} : { randomInt: options.randomInt }),
        });
        actionTimers.clear(room.code);
        actionHistories.set(room.code, []);
        room.phase = 'playing';
        room.revealedPlayerIds.clear();
        rooms.recordSystemEvent(room.code, { type: 'hand-started' }, options.scheduler.now());
        room.version += 1;
        scheduleNextAction(room);
        broadcast(room);
        return {};
      });
    });
    socket.on('game:act', (untrustedInput, ack) => {
      respond(socket, 'game:act', ack, () => {
        const { room, player } = current(socket);
        if (room.phase !== 'playing' || room.hand === undefined) {
          throw new SocketRuleError('HAND_NOT_ACTIVE', 'No hand is in progress');
        }
        applyRoomAction(room, playerAction(untrustedInput, player.id));
        return {};
      });
    });
    socket.on('disconnect', () => {
      if (disposed) return;
      const { roomCode, playerId, sessionToken } = socket.data;
      if (roomCode === undefined || playerId === undefined || sessionToken === undefined) return;
      const room = rooms.getRoom(roomCode);
      const player = room === undefined
        ? undefined
        : roomPlayers(room).find((candidate) => candidate.id === playerId);
      if (room === undefined || player === undefined || player.connectionId !== socket.id) return;

      const disconnectedAt = options.scheduler.now();
      rooms.disconnect(sessionToken, disconnectedAt);
      room.version += 1;
      scheduleNextAction(room);
      broadcast(room);
      scheduleExpiry(sessionToken, room, player, disconnectedAt);
    });
  });

  return () => {
    disposed = true;
    actionTimers.dispose();
    scheduledTurns.clear();
    disconnectTimers.dispose();
  };
}
