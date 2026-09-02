import { describe, expect, it } from 'vitest';
import { RoomService } from '../src/server/room';
import { createTableView } from '../src/server/views';
import { roomWithActiveHand } from './support/rooms';

function values(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code });
}

describe('room service and views', () => {
  it('creates a private room and rejects duplicate normalized nicknames', () => {
    const rooms = new RoomService({
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
    });
    const host = rooms.createRoom({ nickname: '小明' });

    expect(host.roomCode).toBe('ABCD23');
    expectCode(
      () => rooms.joinRoom({ roomCode: 'abcd23', nickname: ' 小明 ' }),
      'NICKNAME_TAKEN',
    );
  });

  it('never includes another player hole cards in a private view', () => {
    const room = roomWithActiveHand();
    const view = createTableView(room, 'p1');

    expect(view.players.find((player) => player.id === 'p1')?.holeCards).toHaveLength(2);
    expect(view.players.find((player) => player.id === 'p2')?.holeCards).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('sessionToken');
    expect(JSON.stringify(view)).not.toContain('deck');
  });

  it('validates visible nicknames and room settings at their boundaries', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });

    expectCode(() => rooms.createRoom({ nickname: '   ' }), 'INVALID_NICKNAME');
    expectCode(() => rooms.createRoom({ nickname: 'a'.repeat(21) }), 'INVALID_NICKNAME');
    expectCode(
      () => rooms.createRoom({ nickname: '房主', settings: { startingStack: 999 } }),
      'INVALID_SETTINGS',
    );
    expectCode(
      () => rooms.createRoom({ nickname: '房主', settings: { smallBlind: 101, bigBlind: 100 } }),
      'INVALID_SETTINGS',
    );
    expectCode(
      () => rooms.createRoom({ nickname: '房主', settings: { startingStack: 1_000, bigBlind: 1_001 } }),
      'INVALID_SETTINGS',
    );
  });

  it('retries normalized room-code collisions', () => {
    const codes = ['ABCD23', 'abcd23', 'WXYZ89'];
    const rooms = new RoomService({
      randomCode: () => codes.shift()!,
      randomToken: values('token'),
    });

    expect(rooms.createRoom({ nickname: '甲' }).roomCode).toBe('ABCD23');
    expect(rooms.createRoom({ nickname: '乙' }).roomCode).toBe('WXYZ89');
  });

  it('allows only the host to change valid settings or manage bots between hands', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主' });
    const guest = rooms.joinRoom({ roomCode: host.roomCode, nickname: '朋友' });

    expectCode(() => rooms.updateSettings(guest.sessionToken, { bigBlind: 200 }), 'NOT_HOST');
    expectCode(() => rooms.addBot(guest.sessionToken, 'tight'), 'NOT_HOST');

    rooms.updateSettings(host.sessionToken, {
      startingStack: 20_000,
      smallBlind: 100,
      bigBlind: 200,
    });
    rooms.addBot(host.sessionToken, 'aggressive');
    const room = rooms.getRoom(host.roomCode)!;
    const bot = room.seats.find((player) => player?.isBot)!;

    expect(room.settings).toEqual({ startingStack: 20_000, smallBlind: 100, bigBlind: 200 });
    expect(bot).toMatchObject({ botStyle: 'aggressive', stack: 20_000 });

    room.phase = 'playing';
    expectCode(() => rooms.updateSettings(host.sessionToken, { bigBlind: 400 }), 'HAND_IN_PROGRESS');
    expectCode(() => rooms.addBot(host.sessionToken, 'balanced'), 'HAND_IN_PROGRESS');
    expectCode(() => rooms.removeBot(host.sessionToken, bot.id), 'HAND_IN_PROGRESS');
  });

  it('rejects a tenth human when no bot can yield a full table seat', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: 'p1' });
    for (let index = 2; index <= 9; index += 1) {
      rooms.joinRoom({ roomCode: host.roomCode, nickname: `p${index}` });
    }

    expectCode(
      () => rooms.joinRoom({ roomCode: host.roomCode, nickname: 'p10' }),
      'ROOM_FULL',
    );
  });

  it('promotes waiting humans FIFO by removing highest-seat bots first', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主' });
    for (let index = 1; index <= 6; index += 1) {
      rooms.joinRoom({ roomCode: host.roomCode, nickname: `玩家${index}` });
    }
    rooms.addBot(host.sessionToken, 'tight');
    rooms.addBot(host.sessionToken, 'aggressive');

    const first = rooms.joinRoom({ roomCode: host.roomCode, nickname: '等待甲' });
    const second = rooms.joinRoom({ roomCode: host.roomCode, nickname: '等待乙' });
    const room = rooms.getRoom(host.roomCode)!;
    const botSeats = room.seats
      .filter((player) => player?.isBot)
      .map((player) => player!.seatIndex);

    expect(first.waitingPosition).toBe(1);
    expect(second.waitingPosition).toBe(2);
    expect(botSeats).toEqual([7, 8]);

    room.phase = 'between-hands';
    rooms.completeHand(host.roomCode);

    expect(room.waiting).toEqual([]);
    expect(room.seats[8]).toMatchObject({ nickname: '等待甲', isBot: false });
    expect(room.seats[7]).toMatchObject({ nickname: '等待乙', isBot: false });
    expect(room.seats.filter((player) => player?.isBot)).toHaveLength(0);
  });

  it('reconnects the same token by replacing its prior connection ID', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主', connectionId: 'socket-old' });

    const reconnected = rooms.reconnect(host.sessionToken, 'socket-new');
    const player = rooms.getRoom(host.roomCode)!.seats[0]!;

    expect(reconnected).toMatchObject({
      connectionId: 'socket-new',
      replacedConnectionId: 'socket-old',
    });
    expect(player).toMatchObject({ connectionId: 'socket-new', connected: true });

    const unchanged = rooms.reconnect(host.sessionToken);
    expect(unchanged.connectionId).toBe('socket-new');
    expect(unchanged.replacedConnectionId).toBeUndefined();
  });

  it('retains disconnected human seats until 300,000 ms and restores them on reconnect', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主' });
    const guest = rooms.joinRoom({ roomCode: host.roomCode, nickname: '朋友' });
    const room = rooms.getRoom(host.roomCode)!;

    rooms.disconnect(guest.sessionToken, 1_000);
    const guestSeat = room.seats.find((player) => player?.id === guest.playerId);
    expect(rooms.expireDisconnected(300_999)).toEqual([]);
    expect(guestSeat).toMatchObject({ connected: false, disconnectedAt: 1_000 });

    rooms.reconnect(guest.sessionToken, 'socket-returned');
    expect(guestSeat).toMatchObject({ connected: true, connectionId: 'socket-returned' });
    expect(guestSeat?.disconnectedAt).toBeUndefined();
  });

  it('expires disconnected humans and transfers host to the earliest seated online human', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主' });
    const offlineGuest = rooms.joinRoom({ roomCode: host.roomCode, nickname: '离线朋友' });
    const onlineGuest = rooms.joinRoom({ roomCode: host.roomCode, nickname: '在线朋友' });
    const room = rooms.getRoom(host.roomCode)!;

    rooms.disconnect(offlineGuest.sessionToken, 0);
    rooms.disconnect(host.sessionToken, 0);
    const events = rooms.expireDisconnected(300_000);

    expect(room.seats.some((player) => player?.id === host.playerId)).toBe(false);
    expect(room.seats.some((player) => player?.id === offlineGuest.playerId)).toBe(false);
    expect(room.hostPlayerId).toBe(onlineGuest.playerId);
    expect(events).toContainEqual({
      type: 'host-transferred',
      roomCode: host.roomCode,
      playerId: onlineGuest.playerId,
    });
  });

  it('destroys rooms after their last human expires even when bots remain', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主' });
    rooms.addBot(host.sessionToken, 'balanced');

    rooms.disconnect(host.sessionToken, 10);
    const events = rooms.expireDisconnected(300_010);

    expect(rooms.getRoom(host.roomCode)).toBeUndefined();
    expect(events).toContainEqual({ type: 'room-destroyed', roomCode: host.roomCode });
    expectCode(() => rooms.reconnect(host.sessionToken), 'INVALID_SESSION');
  });

  it('keeps zero-stack humans seated and lets only the host reset them between hands', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主' });
    const guest = rooms.joinRoom({ roomCode: host.roomCode, nickname: '朋友' });
    const room = rooms.getRoom(host.roomCode)!;
    const guestPlayer = room.seats.find((player) => player?.id === guest.playerId)!;
    guestPlayer.stack = 0;
    room.phase = 'between-hands';

    rooms.completeHand(host.roomCode);
    expect(room.seats.find((player) => player?.id === guest.playerId)).toBe(guestPlayer);
    expectCode(() => rooms.resetStack(guest.sessionToken, guest.playerId), 'NOT_HOST');

    rooms.resetStack(host.sessionToken, guest.playerId);
    expect(guestPlayer.stack).toBe(10_000);
    expectCode(() => rooms.resetStack(host.sessionToken, guest.playerId), 'PLAYER_NOT_BUSTED');

    guestPlayer.stack = 0;
    room.phase = 'playing';
    expectCode(() => rooms.resetStack(host.sessionToken, guest.playerId), 'HAND_IN_PROGRESS');
  });

  it('chooses the first normalized-unique Bot N nickname', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: ' bOt 2 ' });

    rooms.addBot(host.sessionToken, 'balanced');
    const nicknames = rooms.getRoom(host.roomCode)!.seats
      .filter((player) => player !== null)
      .map((player) => player!.nickname);

    expect(nicknames).toEqual(['bOt 2', 'Bot 1']);
    expect(new Set(nicknames.map((nickname) => nickname.toLowerCase())).size).toBe(2);
  });

  it('assigns host to a surviving waiter promoted after the prior host expires during play', () => {
    const rooms = new RoomService({ randomCode: () => 'ABCD23', randomToken: values('token') });
    const host = rooms.createRoom({ nickname: '房主' });
    for (let index = 0; index < 8; index += 1) {
      rooms.addBot(host.sessionToken, 'balanced');
    }
    const waiter = rooms.joinRoom({ roomCode: host.roomCode, nickname: '等待玩家' });
    const room = rooms.getRoom(host.roomCode)!;
    room.phase = 'playing';

    rooms.disconnect(host.sessionToken, 0);
    rooms.expireDisconnected(300_000);
    expect(room.hostPlayerId).toBeUndefined();

    room.phase = 'between-hands';
    rooms.completeHand(room.code);
    rooms.updateSettings(waiter.sessionToken, { bigBlind: 200 });

    expect(room.seats[0]).toMatchObject({ id: waiter.playerId, isBot: false });
    expect(room.hostPlayerId).toBe(waiter.playerId);
    expect(room.settings.bigBlind).toBe(200);
  });
});
