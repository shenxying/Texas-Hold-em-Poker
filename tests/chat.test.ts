import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/server/chat';
import { RoomService } from '../src/server/room';

const sender = {
  sessionId: 'session-1',
  playerId: 'player-1',
  nickname: '小明',
  seatIndex: 0,
};

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code });
}

describe('room chat', () => {
  it('trims messages, rejects empty or overlong text, and retains HTML-like text as data', () => {
    const chat = new ChatService();

    expect(chat.send('r1', sender, '  <b>你好</b>  ', 1_000)).toMatchObject({
      kind: 'player',
      text: '<b>你好</b>',
      sentAt: 1_000,
      sender: {
        playerId: 'player-1',
        nickname: '小明',
        seatIndex: 0,
      },
    });
    expectCode(() => chat.send('r1', sender, '   ', 1_001), 'INVALID_MESSAGE');
    expectCode(() => chat.send('r1', sender, 'a'.repeat(301), 1_002), 'INVALID_MESSAGE');
  });

  it('limits each room session to five messages in a sliding five-second window', () => {
    const chat = new ChatService();
    for (let index = 0; index < 5; index += 1) {
      chat.send('r1', sender, `m${index}`, 1_000 + index);
    }

    expectCode(() => chat.send('r1', sender, 'too fast', 1_005), 'RATE_LIMITED');
    expect(chat.send('r1', sender, 'window moved', 6_000).text).toBe('window moved');

    expect(chat.send('r2', sender, 'other room', 1_005).text).toBe('other room');
    expect(chat.send('r1', { ...sender, sessionId: 'session-2' }, 'other session', 1_005).text)
      .toBe('other session');
  });

  it('lets system messages bypass player limits while sharing the 100-message cap', () => {
    const chat = new ChatService();
    for (let index = 0; index < 5; index += 1) {
      chat.send('r1', sender, `m${index}`, index);
    }
    for (let index = 0; index < 100; index += 1) {
      chat.system('r1', `系统 ${index}`, 10_000 + index);
    }

    const history = chat.history('r1');
    expect(history).toHaveLength(100);
    expect(history[0]).toMatchObject({ id: 6, kind: 'system', text: '系统 0' });
    expect(history[99]).toMatchObject({ id: 105, kind: 'system', text: '系统 99' });
  });

  it('returns deep-cloned history and stores a cloned public sender', () => {
    const chat = new ChatService();
    const mutableSender = { ...sender };
    chat.send('r1', mutableSender, '你好', 1_000);
    mutableSender.nickname = '篡改';

    const first = chat.history('r1');
    first[0]!.text = '篡改';
    first[0]!.sender!.nickname = '篡改';

    expect(chat.history('r1')).toEqual([
      {
        id: 1,
        kind: 'player',
        text: '你好',
        sentAt: 1_000,
        sender: { playerId: 'player-1', nickname: '小明', seatIndex: 0 },
      },
    ]);
  });

  it('derives a room message sender from the trusted session record', () => {
    const rooms = new RoomService({
      randomCode: () => 'ABCD23',
      randomToken: () => 'host-secret-token',
      now: () => 100,
    });
    const host = rooms.createRoom({ nickname: '房主' });

    const message = rooms.sendChat(host.sessionToken, '<i>你好</i>', 200);

    expect(message).toMatchObject({
      kind: 'player',
      text: '<i>你好</i>',
      sender: { playerId: host.playerId, nickname: '房主', seatIndex: 0 },
    });
    expect(JSON.stringify(message)).not.toContain(host.sessionToken);
    expect(rooms.getRoom(host.roomCode)!.messages.at(-1)).toEqual(message);
  });

  it('adds concise Chinese room and game system messages without private state', () => {
    let now = 100;
    const rooms = new RoomService({
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        const tokens = ['host-secret-token', 'guest-secret-token'];
        return () => tokens.shift()!;
      })(),
      now: () => now++,
    });
    const host = rooms.createRoom({ nickname: '房主' });
    const guest = rooms.joinRoom({ roomCode: host.roomCode, nickname: '朋友' });
    rooms.addBot(host.sessionToken, 'balanced');
    const bot = rooms.getRoom(host.roomCode)!.seats.find((player) => player?.isBot)!;
    rooms.removeBot(host.sessionToken, bot.id);
    rooms.recordSystemEvent(host.roomCode, { type: 'hand-started' }, 200);
    rooms.recordSystemEvent(
      host.roomCode,
      { type: 'timeout-action', nickname: '朋友', action: 'check' },
      201,
    );
    rooms.recordSystemEvent(
      host.roomCode,
      { type: 'hand-settled', payouts: [{ nickname: '朋友', amount: 250 }] },
      202,
    );

    rooms.disconnect(host.sessionToken, 300);
    rooms.expireDisconnected(300_300);
    rooms.expireDisconnected(300_300 + 300_000);

    const messages = rooms.getRoom(host.roomCode)!.messages;
    const text = messages.map((message) => message.text).join('\n');
    expect(text).toContain('房主 加入了房间');
    expect(text).toContain('朋友 加入了房间');
    expect(text).toContain(`已添加机器人 ${bot.nickname}`);
    expect(text).toContain(`已移除机器人 ${bot.nickname}`);
    expect(text).toContain('新一手牌开始了');
    expect(text).toContain('朋友 超时，自动过牌');
    expect(text).toContain('本手牌结算：朋友 +250');
    expect(text).toContain('房主 离开了房间');
    expect(text).toContain('朋友 成为新房主');
    expect(rooms.getRoom(host.roomCode)!.hostPlayerId).toBe(guest.playerId);

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('host-secret-token');
    expect(serialized).not.toContain('guest-secret-token');
    expect(serialized).not.toContain('holeCards');
    expect(serialized).not.toContain('deck');
  });

  it('announces exactly one host transfer when an offline survivor reconnects', () => {
    const tokens = ['host-token', 'guest-token'];
    const rooms = new RoomService({
      randomCode: () => 'ABCD23',
      randomToken: () => tokens.shift()!,
      now: () => 100,
    });
    const host = rooms.createRoom({ nickname: '房主' });
    const guest = rooms.joinRoom({ roomCode: host.roomCode, nickname: '朋友' });

    rooms.disconnect(host.sessionToken, 0);
    rooms.disconnect(guest.sessionToken, 1);
    rooms.expireDisconnected(300_000);
    expect(rooms.getRoom(host.roomCode)!.hostPlayerId).toBeUndefined();

    rooms.reconnect(guest.sessionToken, 'guest-returned');
    rooms.reconnect(guest.sessionToken, 'guest-returned-again');

    const transfers = rooms.getRoom(host.roomCode)!.messages.filter(
      (message) => message.kind === 'system' && message.text === '朋友 成为新房主',
    );
    expect(rooms.getRoom(host.roomCode)!.hostPlayerId).toBe(guest.playerId);
    expect(transfers).toHaveLength(1);
  });
});
