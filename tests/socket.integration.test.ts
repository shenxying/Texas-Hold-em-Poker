import { afterEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { BotInput } from '../src/server/ai';
import {
  closeClient,
  connectClient,
  emitAck,
  emitRawAck,
  nextSnapshot,
  startTestServer,
  ManualScheduler,
  type TestServer,
} from './support/socket';

describe('poker socket server', () => {
  const servers: TestServer[] = [];
  const clients: Socket[] = [];

  afterEach(async () => {
    for (const client of clients) closeClient(client);
    for (const server of servers) await server.close();
    clients.length = 0;
    servers.length = 0;
  });

  it('synchronizes two clients without leaking private cards', async () => {
    const server = await startTestServer({
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
      randomInt: () => 0,
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const guest = await connectClient(server.url);
    clients.push(host, guest);

    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    await emitAck(host, 'game:start', {});

    const hostView = await nextSnapshot(host);
    const guestView = await nextSnapshot(guest);
    expect(hostView.players.find((player) => player.nickname === '房主')?.holeCards).toHaveLength(2);
    expect(hostView.players.find((player) => player.nickname === '朋友')?.holeCards).toBeUndefined();
    expect(guestView.players.find((player) => player.nickname === '朋友')?.holeCards).toHaveLength(2);
    expect(JSON.stringify(hostView)).not.toContain('deck');
    expect(JSON.stringify(guestView)).not.toContain('sessionToken');
    expect(hostView.messages.map((message) => message.text)).toContain('新一手牌开始了');
  });

  it('folds on a 30 second timeout and records timeout and settlement messages', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
      randomInt: () => 0,
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const guest = await connectClient(server.url);
    clients.push(host, guest);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    await emitAck(host, 'game:start', {});

    expect(scheduler.pendingCount()).toBe(1);
    scheduler.advanceBy(29_999);
    expect(server.rooms.getRoom(created.roomCode)?.phase).toBe('playing');
    scheduler.advanceBy(1);

    const view = await nextSnapshot(host, (snapshot) => snapshot.phase === 'between-hands');
    expect(view.phase).toBe('between-hands');
    expect(view.messages.map((message) => message.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('超时，自动弃牌'),
        expect.stringContaining('本手牌结算'),
      ]),
    );
  });

  it('auto-checks when checking is legal', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
      randomInt: () => 0,
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const guest = await connectClient(server.url);
    clients.push(host, guest);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    await emitAck(host, 'game:start', {});
    await emitAck(host, 'game:act', { type: 'call' });

    scheduler.advanceBy(30_000);

    const view = await nextSnapshot(host, (snapshot) => snapshot.board.length === 3);
    expect(view.phase).toBe('playing');
    expect(view.messages.map((message) => message.text)).toContain('朋友 超时，自动过牌');
  });

  it('ignores a canceled action callback after a later hand starts', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
      randomInt: () => 0,
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const guest = await connectClient(server.url);
    clients.push(host, guest);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    await emitAck(host, 'game:start', {});
    const staleCallback = scheduler.callbacks()[0]!;
    await emitAck(host, 'game:act', { type: 'fold' });
    scheduler.advanceBy(1_000);
    await emitAck(host, 'game:start', {});

    const room = server.rooms.getRoom(created.roomCode)!;
    const version = room.version;
    const actorId = room.hand?.actorId;
    staleCallback();

    expect(room.version).toBe(version);
    expect(room.hand?.actorId).toBe(actorId);
    expect(room.phase).toBe('playing');
  });

  it('schedules exactly one bot action from privacy-safe public input', async () => {
    const scheduler = new ManualScheduler();
    const seenInputs: BotInput[] = [];
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
      randomInt: () => 0,
      random: () => 0,
      chooseBotAction: (input: BotInput) => {
        seenInputs.push(input);
        return { playerId: input.playerId, type: 'check' };
      },
    });
    servers.push(server);
    const host = await connectClient(server.url);
    clients.push(host);
    const created = await emitAck<{ roomCode: string; sessionToken: string }>(
      host,
      'room:create',
      { nickname: '房主' },
    );
    server.rooms.addBot(created.sessionToken, 'balanced');
    await emitAck(host, 'game:start', {});
    await emitAck(host, 'game:act', { type: 'call' });

    expect(scheduler.pendingCount()).toBe(1);
    scheduler.advanceBy(600);

    const view = await nextSnapshot(host, (snapshot) => snapshot.board.length === 3);
    expect(seenInputs).toHaveLength(1);
    expect(Object.keys(seenInputs[0]!).sort()).toEqual([
      'actionHistory',
      'board',
      'effectiveStack',
      'holeCards',
      'legalActions',
      'playerId',
      'position',
      'pot',
      'style',
    ]);
    expect(seenInputs[0]!.position).toBeGreaterThanOrEqual(0);
    expect(seenInputs[0]!.position).toBeLessThanOrEqual(1);
    expect(seenInputs[0]!.actionHistory).toEqual([
      { playerId: expect.any(String), type: 'call' },
    ]);
    expect(view.board).toHaveLength(3);
    expect(scheduler.pendingCount()).toBe(1);
  });

  it('reconnects by replacing the prior live socket and sending a fresh private snapshot', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
      randomInt: () => 0,
    });
    servers.push(server);
    const original = await connectClient(server.url);
    const replacement = await connectClient(server.url);
    clients.push(original, replacement);
    const created = await emitAck<{
      roomCode: string;
      sessionToken: string;
      playerId: string;
    }>(original, 'room:create', { nickname: '房主' });
    const replacedEvent = new Promise<{ roomCode: string }>((resolve) => {
      original.once('session:replaced', resolve);
    });

    const reconnected = await emitAck<{
      roomCode: string;
      sessionToken: string;
      playerId: string;
    }>(replacement, 'room:reconnect', { sessionToken: created.sessionToken });

    expect(reconnected).toEqual(created);
    await expect(replacedEvent).resolves.toEqual({ roomCode: created.roomCode });
    const view = await nextSnapshot(
      replacement,
      (snapshot) => snapshot.players.some((player) => player.id === created.playerId),
    );
    expect(view.players.find((player) => player.id === created.playerId)?.connected).toBe(true);
  }, 1_000);

  it('expires a disconnected host after five minutes and transfers ownership', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const guest = await connectClient(server.url);
    clients.push(host, guest);
    const created = await emitAck<{ roomCode: string; playerId: string }>(
      host,
      'room:create',
      { nickname: '房主' },
    );
    const joined = await emitAck<{ playerId: string }>(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });

    host.disconnect();
    const offline = await nextSnapshot(
      guest,
      (snapshot) => snapshot.players.some(
        (player) => player.id === created.playerId && !player.connected,
      ),
    );
    expect(offline.players.find((player) => player.id === created.playerId)?.connected).toBe(false);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.advanceBy(300_000);

    const expired = await nextSnapshot(
      guest,
      (snapshot) => !snapshot.players.some((player) => player.id === created.playerId),
    );
    expect(expired.players.find((player) => player.id === joined.playerId)?.isHost).toBe(true);
  }, 1_000);

  it('makes a canceled disconnect-expiry callback harmless after reconnect', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
    });
    servers.push(server);
    const original = await connectClient(server.url);
    clients.push(original);
    const created = await emitAck<{
      roomCode: string;
      sessionToken: string;
      playerId: string;
    }>(original, 'room:create', { nickname: '房主' });
    original.disconnect();
    for (let attempt = 0; attempt < 5 && scheduler.pendingCount() === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const staleExpiry = scheduler.callbacks()[0]!;
    const replacement = await connectClient(server.url);
    clients.push(replacement);

    await emitAck(replacement, 'room:reconnect', { sessionToken: created.sessionToken });
    staleExpiry();

    const room = server.rooms.getRoom(created.roomCode);
    expect(room?.seats.some((player) => player?.id === created.playerId)).toBe(true);
    expect(room?.seats.find((player) => player?.id === created.playerId)?.connected).toBe(true);
  }, 1_000);

  it('returns stable errors for duplicate nicknames, host controls, and double actions', async () => {
    const server = await startTestServer({
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
      randomInt: () => 0,
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const guest = await connectClient(server.url);
    const duplicate = await connectClient(server.url);
    clients.push(host, guest, duplicate);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });

    const duplicateResult = await emitRawAck<{
      ok: false;
      error: { code: string; message: string };
    }>(duplicate, 'room:join', {
      roomCode: created.roomCode,
      nickname: ' 朋友 ',
    });
    expect(duplicateResult).toMatchObject({
      ok: false,
      error: { code: 'NICKNAME_TAKEN' },
    });

    const commandError = new Promise<{ code: string }>((resolve) => {
      guest.once('command:error', resolve);
    });
    const botResult = await emitRawAck<{
      ok: false;
      error: { code: string; message: string };
    }>(guest, 'room:add-bot', { style: 'balanced' });
    expect(botResult).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    await expect(commandError).resolves.toMatchObject({ code: 'NOT_HOST' });

    await emitAck(host, 'game:start', {});
    await emitAck(host, 'game:act', { type: 'call' });
    const hostView = await nextSnapshot(host, (view) => view.actorId !== undefined);
    const guestView = await nextSnapshot(guest, (view) => view.version === hostView.version);
    expect(guestView.actorId).toBe(hostView.actorId);

    const doubleAction = await emitRawAck<{
      ok: false;
      error: { code: string; message: string };
    }>(host, 'game:act', { type: 'fold' });
    expect(doubleAction).toMatchObject({
      ok: false,
      error: { code: 'NOT_PLAYER_TURN' },
    });
  }, 1_000);

  it('rate limits six rapid chat messages while preserving HTML-like text as data', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
    });
    servers.push(server);
    const host = await connectClient(server.url);
    clients.push(host);
    await emitAck(host, 'room:create', { nickname: '房主' });

    const text = '<img src=x onerror=alert(1)>你好';
    await emitAck(host, 'chat:send', { text });
    for (let index = 2; index <= 5; index += 1) {
      await emitAck(host, 'chat:send', { text: `消息${index}` });
    }
    const sixth = await emitRawAck<{
      ok: false;
      error: { code: string; message: string };
    }>(host, 'chat:send', { text: '第六条' });

    expect(sixth).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    const view = await nextSnapshot(
      host,
      (snapshot) => snapshot.messages.some((message) => message.text === text),
    );
    expect(view.messages.find((message) => message.text === text)?.text).toBe(text);
  }, 1_000);

  it('ignores a stale bot callback after another room transition', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
      randomInt: () => 0,
      random: () => 0,
    });
    servers.push(server);
    const host = await connectClient(server.url);
    clients.push(host);
    await emitAck(host, 'room:create', { nickname: '房主' });
    await emitAck(host, 'room:add-bot', { style: 'balanced' });
    await emitAck(host, 'game:start', {});
    await emitAck(host, 'game:act', { type: 'call' });
    const staleBotCallback = scheduler.callbacks()[0]!;

    await emitAck(host, 'chat:send', { text: '保持计时器版本前进' });
    const room = server.rooms.getRoom('ABCD23')!;
    const version = room.version;
    const actorId = room.hand?.actorId;
    staleBotCallback();

    expect(room.version).toBe(version);
    expect(room.hand?.actorId).toBe(actorId);
    await emitAck(host, 'chat:send', { text: '再次替换计时器' });
    expect(scheduler.pendingCount()).toBe(1);
  });

  it('promotes a waiting human by replacing a bot after settlement', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
      randomInt: () => 0,
      random: () => 0,
      chooseBotAction: (input: BotInput) => {
        if (input.legalActions.canCheck) return { playerId: input.playerId, type: 'check' };
        if (input.legalActions.canCall) return { playerId: input.playerId, type: 'call' };
        return { playerId: input.playerId, type: 'fold' };
      },
    });
    servers.push(server);
    const host = await connectClient(server.url);
    clients.push(host);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    for (let index = 1; index <= 7; index += 1) {
      const client = await connectClient(server.url);
      clients.push(client);
      await emitAck(client, 'room:join', {
        roomCode: created.roomCode,
        nickname: `玩家${index}`,
      });
    }
    await emitAck(host, 'room:add-bot', { style: 'balanced' });
    const waiter = await connectClient(server.url);
    clients.push(waiter);
    const waiting = await emitAck<{ playerId: string; waitingPosition?: number }>(
      waiter,
      'room:join',
      { roomCode: created.roomCode, nickname: '等待玩家' },
    );
    expect(waiting.waitingPosition).toBe(1);

    await emitAck(host, 'game:start', {});
    for (let turn = 0; turn < 20 && server.rooms.getRoom(created.roomCode)?.phase === 'playing'; turn += 1) {
      scheduler.advanceBy(30_000);
    }

    const view = await nextSnapshot(
      waiter,
      (snapshot) =>
        snapshot.phase === 'between-hands' &&
        snapshot.players.some((player) => player.id === waiting.playerId),
    );
    expect(view.waitingPosition).toBeUndefined();
    expect(view.players.find((player) => player.id === waiting.playerId)?.isBot).toBe(false);
    expect(view.players.some((player) => player.isBot)).toBe(false);
  });

  it('completes a deterministic mixed human and bot hand', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
      randomInt: () => 0,
      random: () => 0,
      chooseBotAction: (input: BotInput) => {
        if (input.legalActions.canCheck) return { playerId: input.playerId, type: 'check' };
        if (input.legalActions.canCall) return { playerId: input.playerId, type: 'call' };
        return { playerId: input.playerId, type: 'fold' };
      },
    });
    servers.push(server);
    const host = await connectClient(server.url);
    clients.push(host);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(host, 'room:add-bot', { style: 'tight' });
    await emitAck(host, 'room:add-bot', { style: 'aggressive' });
    await emitAck(host, 'game:start', {});

    scheduler.advanceBy(120_000);

    const room = server.rooms.getRoom(created.roomCode)!;
    expect(room.phase).toBe('between-hands');
    expect(room.hand?.street).toBe('complete');
    expect(room.hand?.board).toHaveLength(5);
    const view = await nextSnapshot(host, (snapshot) => snapshot.phase === 'between-hands');
    expect(view.messages.at(-1)?.text).toContain('本手牌结算');
  });

  it('promotes a waiter when a disconnected seated human expires between hands', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: (() => {
        let token = 0;
        return () => `token-${++token}`;
      })(),
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const guest = await connectClient(server.url);
    const waiter = await connectClient(server.url);
    clients.push(host, guest, waiter);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    for (let index = 0; index < 7; index += 1) {
      await emitAck(host, 'room:add-bot', { style: 'balanced' });
    }
    const joined = await emitAck<{ playerId: string }>(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '即将离线',
    });
    const waiting = await emitAck<{ playerId: string; waitingPosition?: number }>(
      waiter,
      'room:join',
      { roomCode: created.roomCode, nickname: '等待玩家' },
    );
    expect(waiting.waitingPosition).toBe(1);

    guest.disconnect();
    await nextSnapshot(
      host,
      (snapshot) => snapshot.players.some(
        (player) => player.id === joined.playerId && !player.connected,
      ),
    );
    scheduler.advanceBy(300_000);

    const promoted = await nextSnapshot(
      waiter,
      (snapshot) => snapshot.players.some((player) => player.id === waiting.playerId),
    );
    expect(promoted.waitingPosition).toBeUndefined();
    expect(promoted.players.find((player) => player.id === waiting.playerId)?.seatIndex).toBe(8);
  });

  it('destroys a room when its last human expires even if a bot remains', async () => {
    const scheduler = new ManualScheduler();
    const server = await startTestServer({
      scheduler,
      randomCode: () => 'ABCD23',
      randomToken: () => 'token-1',
    });
    servers.push(server);
    const host = await connectClient(server.url);
    clients.push(host);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(host, 'room:add-bot', { style: 'balanced' });

    host.disconnect();
    for (let attempt = 0; attempt < 5 && scheduler.pendingCount() === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    scheduler.advanceBy(300_000);

    expect(server.rooms.getRoom(created.roomCode)).toBeUndefined();
  });
});
