import { randomBytes, randomInt } from 'node:crypto';
import type { HandState } from '../game/types';
import type { BotStyle, ChatMessage, RoomSettings } from '../shared/protocol';
import { ChatService, systemMessageText } from './chat';
import type { RoomSystemEvent } from './chat';

const MAX_SEATS = 9;
const DEFAULT_SETTINGS: RoomSettings = {
  startingStack: 10_000,
  smallBlind: 50,
  bigBlind: 100,
};
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type RoomErrorCode =
  | 'INVALID_NICKNAME'
  | 'INVALID_SETTINGS'
  | 'INVALID_BOT_STYLE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_CODE_EXHAUSTED'
  | 'SESSION_TOKEN_EXHAUSTED'
  | 'INVALID_SESSION'
  | 'NICKNAME_TAKEN'
  | 'NOT_HOST'
  | 'HAND_IN_PROGRESS'
  | 'HAND_NOT_COMPLETE'
  | 'PLAYER_NOT_FOUND'
  | 'NOT_BOT'
  | 'NOT_HUMAN'
  | 'PLAYER_NOT_BUSTED';

export class RoomRuleError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = 'RoomRuleError';
    this.code = code;
  }
}

export interface RoomPlayer {
  id: string;
  nickname: string;
  seatIndex: number | null;
  stack: number;
  connected: boolean;
  isBot: boolean;
  botStyle?: BotStyle;
  joinedOrder: number;
  sessionToken?: string;
  connectionId?: string;
  disconnectedAt?: number;
}

export interface Room {
  code: string;
  version: number;
  settings: RoomSettings;
  phase: 'lobby' | 'playing' | 'between-hands';
  seats: Array<RoomPlayer | null>;
  waiting: RoomPlayer[];
  hostPlayerId?: string;
  dealerSeatIndex?: number;
  hand?: HandState;
  revealedPlayerIds: Set<string>;
  actionDeadline?: number;
  messages: ChatMessage[];
}

export interface CreateRoomInput {
  nickname: string;
  settings?: Partial<RoomSettings>;
  connectionId?: string;
}

export interface JoinRoomInput {
  roomCode: string;
  nickname: string;
  connectionId?: string;
}

export interface JoinResult {
  roomCode: string;
  sessionToken: string;
  playerId: string;
  connectionId?: string;
  replacedConnectionId?: string;
  waitingPosition?: number;
}

export type RoomEvent =
  | { type: 'player-joined'; roomCode: string; playerId: string; waiting: boolean }
  | { type: 'player-left'; roomCode: string; playerId: string }
  | { type: 'player-seated'; roomCode: string; playerId: string; seatIndex: number }
  | { type: 'bot-added'; roomCode: string; playerId: string; seatIndex: number }
  | { type: 'bot-removed'; roomCode: string; playerId: string; seatIndex: number }
  | { type: 'host-transferred'; roomCode: string; playerId: string }
  | { type: 'room-destroyed'; roomCode: string };

interface SessionRecord {
  room: Room;
  player: RoomPlayer;
}

export interface RoomServiceOptions {
  randomCode?: () => string;
  randomToken?: () => string;
  chat?: ChatService;
  now?: () => number;
}

function defaultRoomCode(): string {
  let result = '';
  for (let index = 0; index < 6; index += 1) {
    result += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return result;
}

function normalizedRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

function normalizeNickname(nickname: string): { display: string; key: string } {
  const display = nickname.trim();
  const visibleLength = Array.from(display).length;
  const containsVisibleCharacter =
    /[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(display);
  if (visibleLength < 1 || visibleLength > 20 || !containsVisibleCharacter) {
    throw new RoomRuleError('INVALID_NICKNAME', 'Nickname must contain 1 to 20 visible characters');
  }
  return { display, key: display.toLowerCase() };
}

function mergeSettings(patch?: Partial<RoomSettings>, current = DEFAULT_SETTINGS): RoomSettings {
  const settings = { ...current, ...patch };
  const valid =
    Number.isInteger(settings.startingStack) &&
    settings.startingStack >= 1_000 &&
    settings.startingStack <= 1_000_000 &&
    Number.isInteger(settings.smallBlind) &&
    settings.smallBlind > 0 &&
    Number.isInteger(settings.bigBlind) &&
    settings.bigBlind > 0 &&
    settings.bigBlind >= settings.smallBlind &&
    settings.bigBlind <= settings.startingStack;
  if (!valid) {
    throw new RoomRuleError('INVALID_SETTINGS', 'Invalid room settings');
  }
  return settings;
}

function firstOpenSeat(room: Room): number | null {
  const seatIndex = room.seats.findIndex((seat) => seat === null);
  return seatIndex === -1 ? null : seatIndex;
}

function seatedPlayers(room: Room): RoomPlayer[] {
  return room.seats.filter((player): player is RoomPlayer => player !== null);
}

function allHumans(room: Room): RoomPlayer[] {
  return [...seatedPlayers(room), ...room.waiting].filter((player) => !player.isBot);
}

function firstAvailableBotNickname(room: Room): string {
  const nicknameKeys = new Set(
    [...seatedPlayers(room), ...room.waiting].map(
      (player) => normalizeNickname(player.nickname).key,
    ),
  );
  for (let number = 1; ; number += 1) {
    const nickname = `Bot ${number}`;
    if (!nicknameKeys.has(nickname.toLowerCase())) return nickname;
  }
}

function waitingPosition(room: Room, player: RoomPlayer): number | undefined {
  const index = room.waiting.indexOf(player);
  return index === -1 ? undefined : index + 1;
}

export class RoomService {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly randomCode: () => string;
  private readonly randomToken: () => string;
  private readonly chat: ChatService;
  private readonly now: () => number;
  private nextPlayerNumber = 1;
  private nextJoinOrder = 1;

  constructor(options: RoomServiceOptions = {}) {
    this.randomCode = options.randomCode ?? defaultRoomCode;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('hex'));
    this.chat = options.chat ?? new ChatService();
    this.now = options.now ?? Date.now;
  }

  createRoom(input: CreateRoomInput): JoinResult {
    const nickname = normalizeNickname(input.nickname).display;
    const code = this.createUniqueRoomCode();
    const settings = mergeSettings(input.settings);
    const player = this.createHuman(nickname, 0, settings.startingStack, input.connectionId);
    const room: Room = {
      code,
      version: 0,
      settings,
      phase: 'lobby',
      seats: [player, ...Array<null>(MAX_SEATS - 1).fill(null)],
      waiting: [],
      hostPlayerId: player.id,
      revealedPlayerIds: new Set(),
      messages: [],
    };
    this.rooms.set(code, room);
    this.sessions.set(player.sessionToken!, { room, player });
    this.appendSystemEvent(room, { type: 'player-joined', nickname: player.nickname }, this.now());
    return this.joinResult(room, player);
  }

  joinRoom(input: JoinRoomInput): JoinResult {
    const room = this.requireRoom(input.roomCode);
    const nickname = normalizeNickname(input.nickname);
    const taken = allHumans(room).some(
      (player) => normalizeNickname(player.nickname).key === nickname.key,
    ) || seatedPlayers(room).some(
      (player) => player.isBot && normalizeNickname(player.nickname).key === nickname.key,
    );
    if (taken) {
      throw new RoomRuleError('NICKNAME_TAKEN', 'Nickname is already in use');
    }

    const openSeat = firstOpenSeat(room);
    if (openSeat === null && !seatedPlayers(room).some((player) => player.isBot)) {
      throw new RoomRuleError('ROOM_FULL', 'Room is full');
    }

    const player = this.createHuman(
      nickname.display,
      openSeat,
      room.settings.startingStack,
      input.connectionId,
    );
    if (openSeat === null) {
      room.waiting.push(player);
    } else {
      room.seats[openSeat] = player;
    }
    this.sessions.set(player.sessionToken!, { room, player });
    this.appendSystemEvent(room, { type: 'player-joined', nickname: player.nickname }, this.now());
    return this.joinResult(room, player);
  }

  reconnect(sessionToken: string, connectionId?: string): JoinResult {
    const { room, player } = this.requireSession(sessionToken);
    const replacedConnectionId = player.connectionId;
    player.connected = true;
    delete player.disconnectedAt;
    if (connectionId !== undefined) player.connectionId = connectionId;
    if (room.hostPlayerId === undefined && player.seatIndex !== null) {
      const nextHost = seatedPlayers(room)
        .filter((candidate) => !candidate.isBot && candidate.connected)
        .sort((left, right) => left.joinedOrder - right.joinedOrder)[0];
      if (nextHost) {
        room.hostPlayerId = nextHost.id;
        this.appendSystemEvent(
          room,
          { type: 'host-transferred', nickname: nextHost.nickname },
          this.now(),
        );
      }
    }
    return this.joinResult(
      room,
      player,
      connectionId !== undefined &&
        replacedConnectionId !== undefined &&
        replacedConnectionId !== connectionId
        ? replacedConnectionId
        : undefined,
    );
  }

  disconnect(sessionToken: string, now: number): void {
    const { player } = this.requireSession(sessionToken);
    player.connected = false;
    player.disconnectedAt = now;
  }

  leave(sessionToken: string, now: number): RoomEvent[] {
    const { room, player } = this.requireSession(sessionToken);
    return this.removeHuman(sessionToken, room, player, now);
  }

  expireDisconnected(now: number): RoomEvent[] {
    const events: RoomEvent[] = [];
    for (const [sessionToken, { room, player }] of [...this.sessions]) {
      if (
        player.connected ||
        player.disconnectedAt === undefined ||
        now - player.disconnectedAt < 300_000
      ) {
        continue;
      }
      events.push(...this.removeHuman(sessionToken, room, player, now));
    }
    return events;
  }

  updateSettings(actorToken: string, patch: Partial<RoomSettings>): void {
    const { room, player } = this.requireSession(actorToken);
    this.requireHost(room, player);
    this.requireBetweenHands(room);
    room.settings = mergeSettings(patch, room.settings);
  }

  addBot(actorToken: string, style: BotStyle): void {
    const { room, player } = this.requireSession(actorToken);
    this.requireHost(room, player);
    this.requireBetweenHands(room);
    if (!(['tight', 'balanced', 'aggressive'] as const).includes(style)) {
      throw new RoomRuleError('INVALID_BOT_STYLE', 'Unknown bot style');
    }
    const seatIndex = firstOpenSeat(room);
    if (seatIndex === null) {
      throw new RoomRuleError('ROOM_FULL', 'Room is full');
    }
    const id = this.nextPlayerId('bot');
    const bot: RoomPlayer = {
      id,
      nickname: firstAvailableBotNickname(room),
      seatIndex,
      stack: room.settings.startingStack,
      connected: true,
      isBot: true,
      botStyle: style,
      joinedOrder: this.nextJoinOrder++,
    };
    room.seats[seatIndex] = bot;
    this.appendSystemEvent(room, { type: 'bot-added', nickname: bot.nickname }, this.now());
  }

  removeBot(actorToken: string, playerId: string): void {
    const { room, player } = this.requireSession(actorToken);
    this.requireHost(room, player);
    this.requireBetweenHands(room);
    const seatIndex = room.seats.findIndex((candidate) => candidate?.id === playerId);
    if (seatIndex === -1) {
      throw new RoomRuleError('PLAYER_NOT_FOUND', 'Player does not exist');
    }
    const bot = room.seats[seatIndex]!;
    if (!bot.isBot) {
      throw new RoomRuleError('NOT_BOT', 'Player is not a bot');
    }
    room.seats[seatIndex] = null;
    this.appendSystemEvent(room, { type: 'bot-removed', nickname: bot.nickname }, this.now());
  }

  resetStack(actorToken: string, playerId: string): void {
    const { room, player: actor } = this.requireSession(actorToken);
    this.requireHost(room, actor);
    this.requireBetweenHands(room);
    const player = room.seats.find((candidate) => candidate?.id === playerId);
    if (!player) throw new RoomRuleError('PLAYER_NOT_FOUND', 'Player does not exist');
    if (player.isBot) throw new RoomRuleError('NOT_HUMAN', 'Only human stacks can be reset');
    if (player.stack !== 0) {
      throw new RoomRuleError('PLAYER_NOT_BUSTED', 'Player still has chips');
    }
    player.stack = room.settings.startingStack;
  }

  completeHand(roomCode: string): RoomEvent[] {
    const room = this.requireRoom(roomCode);
    if (room.phase !== 'between-hands') {
      throw new RoomRuleError('HAND_NOT_COMPLETE', 'The room is not between hands');
    }
    const events: RoomEvent[] = [];
    if (room.hand?.street === 'complete') {
      for (const handPlayer of room.hand.players) {
        const roomPlayer = room.seats.find((candidate) => candidate?.id === handPlayer.id);
        if (roomPlayer) roomPlayer.stack = handPlayer.stack;
      }
    }
    events.push(...this.promoteWaiting(room, this.now()));
    return events;
  }

  private promoteWaiting(room: Room, now: number): RoomEvent[] {
    const events: RoomEvent[] = [];
    while (room.waiting.length > 0) {
      let seatIndex = firstOpenSeat(room);
      if (seatIndex === null) {
        for (let candidate = room.seats.length - 1; candidate >= 0; candidate -= 1) {
          if (room.seats[candidate]?.isBot) {
            seatIndex = candidate;
            break;
          }
        }
        if (seatIndex === null) break;
        const bot = room.seats[seatIndex]!;
        room.seats[seatIndex] = null;
        events.push({
          type: 'bot-removed',
          roomCode: room.code,
          playerId: bot.id,
          seatIndex,
        });
        this.appendSystemEvent(room, { type: 'bot-removed', nickname: bot.nickname }, now);
      }

      const human = room.waiting.shift()!;
      human.seatIndex = seatIndex;
      room.seats[seatIndex] = human;
      events.push({
        type: 'player-seated',
        roomCode: room.code,
        playerId: human.id,
        seatIndex,
      });
    }
    events.push(...this.transferHost(room, now));
    return events;
  }

  private removeHuman(
    sessionToken: string,
    room: Room,
    player: RoomPlayer,
    now: number,
  ): RoomEvent[] {
    this.sessions.delete(sessionToken);
    const seatIndex = room.seats.indexOf(player);
    if (seatIndex !== -1) room.seats[seatIndex] = null;
    const waitingIndex = room.waiting.indexOf(player);
    if (waitingIndex !== -1) room.waiting.splice(waitingIndex, 1);
    if (room.hostPlayerId === player.id) room.hostPlayerId = undefined;

    const events: RoomEvent[] = [{ type: 'player-left', roomCode: room.code, playerId: player.id }];
    this.appendSystemEvent(room, { type: 'player-left', nickname: player.nickname }, now);

    if (allHumans(room).length === 0) {
      this.rooms.delete(room.code);
      this.chat.clear(room.code);
      events.push({ type: 'room-destroyed', roomCode: room.code });
      return events;
    }

    if (room.phase !== 'playing') events.push(...this.promoteWaiting(room, now));
    else events.push(...this.transferHost(room, now));
    return events;
  }

  private transferHost(room: Room, now: number): RoomEvent[] {
    if (room.hostPlayerId !== undefined) return [];
    const nextHost = seatedPlayers(room)
      .filter((player) => !player.isBot && player.connected)
      .sort((left, right) => left.joinedOrder - right.joinedOrder)[0];
    if (!nextHost) return [];

    room.hostPlayerId = nextHost.id;
    this.appendSystemEvent(room, { type: 'host-transferred', nickname: nextHost.nickname }, now);
    return [{ type: 'host-transferred', roomCode: room.code, playerId: nextHost.id }];
  }

  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(normalizedRoomCode(roomCode));
  }

  sendChat(sessionToken: string, text: string, now: number): ChatMessage {
    const { room, player } = this.requireSession(sessionToken);
    const message = this.chat.send(
      room.code,
      {
        sessionId: sessionToken,
        playerId: player.id,
        nickname: player.nickname,
        seatIndex: player.seatIndex ?? -1,
      },
      text,
      now,
    );
    room.messages = this.chat.history(room.code);
    return message;
  }

  recordSystemEvent(roomCode: string, event: RoomSystemEvent, now: number): ChatMessage {
    const room = this.requireRoom(roomCode);
    return this.appendSystemEvent(room, event, now);
  }

  private createUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const code = normalizedRoomCode(this.randomCode());
      if (/^[A-HJ-NP-Z2-9]{6}$/.test(code) && !this.rooms.has(code)) return code;
    }
    throw new RoomRuleError('ROOM_CODE_EXHAUSTED', 'Could not allocate a room code');
  }

  private createHuman(
    nickname: string,
    seatIndex: number | null,
    stack: number,
    connectionId?: string,
  ): RoomPlayer {
    const sessionToken = this.createUniqueSessionToken();
    return {
      id: this.nextPlayerId('player'),
      nickname,
      seatIndex,
      stack,
      connected: true,
      isBot: false,
      joinedOrder: this.nextJoinOrder++,
      sessionToken,
      ...(connectionId === undefined ? {} : { connectionId }),
    };
  }

  private createUniqueSessionToken(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const token = this.randomToken();
      if (token.length > 0 && !this.sessions.has(token)) return token;
    }
    throw new RoomRuleError('SESSION_TOKEN_EXHAUSTED', 'Could not allocate a session token');
  }

  private nextPlayerId(prefix: 'player' | 'bot'): string {
    return `${prefix}-${this.nextPlayerNumber++}`;
  }

  private requireRoom(roomCode: string): Room {
    const room = this.getRoom(roomCode);
    if (!room) throw new RoomRuleError('ROOM_NOT_FOUND', 'Room does not exist');
    return room;
  }

  private requireSession(sessionToken: string): SessionRecord {
    const session = this.sessions.get(sessionToken);
    if (!session) throw new RoomRuleError('INVALID_SESSION', 'Session does not exist');
    return session;
  }

  private requireHost(room: Room, player: RoomPlayer): void {
    if (room.hostPlayerId !== player.id) {
      throw new RoomRuleError('NOT_HOST', 'Only the host can perform this action');
    }
  }

  private requireBetweenHands(room: Room): void {
    if (room.phase === 'playing') {
      throw new RoomRuleError('HAND_IN_PROGRESS', 'This action is unavailable during a hand');
    }
  }

  private appendSystemEvent(room: Room, event: RoomSystemEvent, now: number): ChatMessage {
    const message = this.chat.system(room.code, systemMessageText(event), now);
    room.messages = this.chat.history(room.code);
    return message;
  }

  private joinResult(
    room: Room,
    player: RoomPlayer,
    replacedConnectionId?: string,
  ): JoinResult {
    return {
      roomCode: room.code,
      sessionToken: player.sessionToken!,
      playerId: player.id,
      ...(player.connectionId === undefined ? {} : { connectionId: player.connectionId }),
      ...(replacedConnectionId === undefined ? {} : { replacedConnectionId }),
      ...(waitingPosition(room, player) === undefined
        ? {}
        : { waitingPosition: waitingPosition(room, player) }),
    };
  }
}
