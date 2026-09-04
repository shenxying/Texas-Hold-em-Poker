import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { BotInput } from '../src/server/ai';
import { collectLanUrls, parsePort } from '../src/server/index';
import type { TableView } from '../src/shared/protocol';
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
  const fixtureDirectories: string[] = [];

  afterEach(async () => {
    for (const client of clients) closeClient(client);
    for (const server of servers) await server.close();
    clients.length = 0;
    servers.length = 0;
    for (const directory of fixtureDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
    fixtureDirectories.length = 0;
  });

  it('serves health, built assets, and the SPA fallback from the configured directory', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'lan-poker-dist-'));
    fixtureDirectories.push(fixtureRoot);
    const staticDir = join(fixtureRoot, '.build', 'dist');
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>测试牌桌</title>');
    await writeFile(join(staticDir, 'app.js'), 'globalThis.__LAN_POKER__ = true;');

    const server = await startTestServer({ staticDir });
    servers.push(server);

    await request(server.url).get('/health').expect(200, { ok: true });
    await request(server.url)
      .get('/app.js')
      .expect(200)
      .expect('Content-Type', /javascript/)
      .expect('globalThis.__LAN_POKER__ = true;');
    await request(server.url)
      .get('/rooms/ABCD23')
      .expect(200)
      .expect('Content-Type', /html/)
      .expect(/测试牌桌/);
  });

  it('mounts health and the SPA under an explicit public base path', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'lan-poker-dist-'));
    fixtureDirectories.push(fixtureRoot);
    const staticDir = join(fixtureRoot, '.build', 'dist');
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>测试牌桌</title>');

    const server = await startTestServer({ staticDir, basePath: '/poker' });
    servers.push(server);

    await request(server.url).get('/poker').expect(301).expect('Location', '/poker/');
    await request(server.url).get('/poker/').expect(200, /测试牌桌/);
    await request(server.url).get('/poker/health').expect(200, { ok: true });
    await request(server.url).get('/health').expect(404);
    await request(server.url).get('/anything/health').expect(404);
    await request(server.url).get('/poker/rooms/ABCD23').expect(200, /测试牌桌/);

    const client = await connectClient(server.url, '/poker/socket.io');
    clients.push(client);
    await expect(emitAck(client, 'room:create', { nickname: '房主' })).resolves.toMatchObject({
      roomCode: expect.any(String),
    });
  });

  it('rejects a parameterized base before arbitrary prefixes can expose health', async () => {
    const attemptedServer = startTestServer({ basePath: '/:tenant' });
    try {
      await expect(attemptedServer).rejects.toThrow(/BASE_PATH/);
    } finally {
      const server = await attemptedServer.catch(() => undefined);
      if (server !== undefined) await server.close();
    }
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

  it('rejects a second identity on one socket without leaking its private projection', async () => {
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
    const created = await emitAck<{ roomCode: string; playerId: string }>(host, 'room:create', {
      nickname: '房主',
    });
    const joined = await emitAck<{ sessionToken: string; playerId: string }>(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });

    const secondRoom = await emitRawAck<{
      ok: false;
      error: { code: string };
    }>(host, 'room:create', { nickname: '另一个房主' });
    const secondIdentity = await emitRawAck<{
      ok: false;
      error: { code: string };
    }>(host, 'room:join', { roomCode: created.roomCode, nickname: '分身' });
    const reconnectIdentity = await emitRawAck<{
      ok: false;
      error: { code: string };
    }>(host, 'room:reconnect', { sessionToken: joined.sessionToken });
    expect(secondRoom).toMatchObject({
      ok: false,
      error: { code: 'SOCKET_ALREADY_BOUND' },
    });
    expect(secondIdentity).toMatchObject({
      ok: false,
      error: { code: 'SOCKET_ALREADY_BOUND' },
    });
    expect(reconnectIdentity).toMatchObject({
      ok: false,
      error: { code: 'SOCKET_ALREADY_BOUND' },
    });
    expect(server.rooms.getRoom(created.roomCode)?.seats.filter(Boolean)).toHaveLength(2);

    const received: TableView[] = [];
    host.on('table:snapshot', (view) => received.push(view));
    await emitAck(host, 'game:start', {});
    await emitAck(host, 'game:act', { type: 'call' });
    await nextSnapshot(host, (view) => view.actorId === joined.playerId);

    expect(received.length).toBeGreaterThan(0);
    for (const view of received) {
      expect(view.players.find((player) => player.id === created.playerId)?.holeCards).toHaveLength(2);
      expect(view.players.find((player) => player.id === joined.playerId)?.holeCards).toBeUndefined();
    }
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

  it('moves the dealer clockwise between consecutive hands', async () => {
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
    const created = await emitAck<{ roomCode: string; playerId: string }>(
      host,
      'room:create',
      { nickname: '房主' },
    );
    const joined = await emitAck<{ playerId: string }>(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });

    await emitAck(host, 'game:start', {});
    const room = server.rooms.getRoom(created.roomCode)!;
    expect(room.hand?.players[room.hand.dealerIndex]?.id).toBe(created.playerId);
    await emitAck(host, 'game:act', { type: 'fold' });

    await emitAck(host, 'game:start', {});
    expect(room.hand?.players[room.hand.dealerIndex]?.id).toBe(joined.playerId);
  });

  it('uses a cryptographic shuffle source by default instead of engine Math.random', async () => {
    const server = await startTestServer({
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
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('engine Math.random must not provide production shuffle entropy');
    });

    try {
      await emitAck(host, 'game:start', {});
      expect(server.rooms.getRoom(created.roomCode)?.phase).toBe('playing');
    } finally {
      random.mockRestore();
    }
  });

  it('skips a zero-stack seat when advancing the dealer', async () => {
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
    const busted = await connectClient(server.url);
    const live = await connectClient(server.url);
    clients.push(host, busted, live);
    const created = await emitAck<{ roomCode: string; playerId: string }>(
      host,
      'room:create',
      { nickname: '房主' },
    );
    const bustedSession = await emitAck<{ playerId: string }>(busted, 'room:join', {
      roomCode: created.roomCode,
      nickname: '零筹码玩家',
    });
    const liveSession = await emitAck<{ playerId: string }>(live, 'room:join', {
      roomCode: created.roomCode,
      nickname: '继续玩家',
    });

    await emitAck(host, 'game:start', {});
    await emitAck(host, 'game:act', { type: 'fold' });
    await emitAck(busted, 'game:act', { type: 'fold' });
    const room = server.rooms.getRoom(created.roomCode)!;
    room.seats.find((player) => player?.id === bustedSession.playerId)!.stack = 0;

    await emitAck(host, 'game:start', {});
    expect(room.hand?.players[room.hand.dealerIndex]?.id).toBe(liveSession.playerId);
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

  it('preserves the active timeout after a rejected action and invalidates it after success', async () => {
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
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', { nickname: '房主' });
    await emitAck(guest, 'room:join', { roomCode: created.roomCode, nickname: '朋友' });
    await emitAck(host, 'game:start', {});

    const room = server.rooms.getRoom(created.roomCode)!;
    const deadline = room.actionDeadline;
    const originalTimeout = scheduler.callbacks()[0]!;
    const rejected = await emitRawAck<{
      ok: false;
      error: { code: string };
    }>(guest, 'game:act', { type: 'fold' });

    expect(rejected).toMatchObject({ ok: false, error: { code: 'NOT_PLAYER_TURN' } });
    expect(room.actionDeadline).toBe(deadline);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.callbacks()[0]).toBe(originalTimeout);

    const illegal = await emitRawAck<{
      ok: false;
      error: { code: string };
    }>(host, 'game:act', { type: 'check' });
    expect(illegal).toMatchObject({ ok: false, error: { code: 'ILLEGAL_ACTION' } });
    expect(room.actionDeadline).toBe(deadline);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.callbacks()[0]).toBe(originalTimeout);

    await emitAck(host, 'game:act', { type: 'call' });
    const version = room.version;
    const actorId = room.hand?.actorId;
    originalTimeout();
    expect(room.version).toBe(version);
    expect(room.hand?.actorId).toBe(actorId);
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

  it('does not extend the active human deadline when chat updates the room', async () => {
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
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', { nickname: '房主' });
    await emitAck(guest, 'room:join', { roomCode: created.roomCode, nickname: '朋友' });
    await emitAck(host, 'game:start', {});
    const room = server.rooms.getRoom(created.roomCode)!;

    expect(room.actionDeadline).toBe(30_000);
    scheduler.advanceBy(29_000);
    await emitAck(host, 'chat:send', { text: '不延长行动时间' });
    expect(room.actionDeadline).toBe(30_000);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.advanceBy(1_000);
    expect(room.phase).toBe('between-hands');
    expect(room.messages.map((message) => message.text)).toContain('房主 超时，自动弃牌');
  });

  it('preserves the original bot timer through chat and reconnect but rejects it after action', async () => {
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
    const created = await emitAck<{ sessionToken: string }>(host, 'room:create', {
      nickname: '房主',
    });
    await emitAck(host, 'room:add-bot', { style: 'balanced' });
    await emitAck(host, 'game:start', {});
    await emitAck(host, 'game:act', { type: 'call' });
    const originalBotCallback = scheduler.callbacks()[0]!;

    await emitAck(host, 'chat:send', { text: '聊天不应重排 AI 行动' });
    const replacement = await connectClient(server.url);
    clients.push(replacement);
    await emitAck(replacement, 'room:reconnect', { sessionToken: created.sessionToken });
    await emitAck(replacement, 'chat:send', { text: '重连也不应重排 AI 行动' });
    const room = server.rooms.getRoom('ABCD23')!;

    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.callbacks()[0]).toBe(originalBotCallback);
    scheduler.advanceBy(599);
    expect(seenInputs).toHaveLength(0);
    scheduler.advanceBy(1);
    expect(seenInputs).toHaveLength(1);

    const versionAfterAction = room.version;
    const actorAfterAction = room.hand?.actorId;
    originalBotCallback();
    expect(room.version).toBe(versionAfterAction);
    expect(room.hand?.actorId).toBe(actorAfterAction);
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

  it('keeps a winning bot nickname in settlement chat when that bot is replaced', async () => {
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
    });
    servers.push(server);
    const host = await connectClient(server.url);
    const waiter = await connectClient(server.url);
    clients.push(host, waiter);
    const created = await emitAck<{
      roomCode: string;
      sessionToken: string;
      playerId: string;
    }>(host, 'room:create', { nickname: '房主' });
    for (let index = 0; index < 8; index += 1) {
      await emitAck(host, 'room:add-bot', { style: 'balanced' });
    }
    await emitAck(waiter, 'room:join', {
      roomCode: created.roomCode,
      nickname: '候场玩家',
    });
    await emitAck(host, 'game:start', {});

    const room = server.rooms.getRoom(created.roomCode)!;
    const winningBot = room.seats[8]!;
    for (const player of room.hand!.players) {
      player.folded = player.id !== created.playerId && player.id !== winningBot.id;
    }
    room.hand!.actorId = created.playerId;
    await emitAck(host, 'game:act', { type: 'fold' });

    const view = await nextSnapshot(waiter, (snapshot) => snapshot.phase === 'between-hands');
    const settlement = view.messages.at(-1)?.text ?? '';
    expect(settlement).toContain(`${winningBot.nickname} +`);
    expect(settlement).not.toContain(winningBot.id);
    expect(view.players.some((player) => player.id === winningBot.id)).toBe(false);
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

  it('removes a waiting player and rejects its duplicate leave', async () => {
    const server = await startTestServer({ randomCode: () => 'ABCD23', randomToken: (() => {
      let token = 0;
      return () => `token-${++token}`;
    })() });
    servers.push(server);
    const host = await connectClient(server.url);
    const waiter = await connectClient(server.url);
    clients.push(host, waiter);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', { nickname: '房主' });
    for (let index = 0; index < 8; index += 1) {
      await emitAck(host, 'room:add-bot', { style: 'balanced' });
    }
    const waiting = await emitAck<{ playerId: string; waitingPosition?: number }>(
      waiter,
      'room:join',
      { roomCode: created.roomCode, nickname: '等待玩家' },
    );

    const invalid = await emitRawAck<{ ok: false; error: { code: string } }>(
      waiter,
      'room:leave',
      { unexpected: true },
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    await emitAck(waiter, 'room:leave', {});

    expect(server.rooms.getRoom(created.roomCode)!.waiting).toEqual([]);
    await expect(emitAck(waiter, 'room:leave', {})).rejects.toMatchObject({
      code: 'INVALID_SESSION',
    });
    expect(waiting.waitingPosition).toBe(1);
  }, 1_000);

  it('transfers a host who leaves between hands', async () => {
    const server = await startTestServer({ randomCode: () => 'ABCD23', randomToken: (() => {
      let token = 0;
      return () => `token-${++token}`;
    })() });
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

    await emitAck(host, 'room:leave', {});

    const snapshot = await nextSnapshot(
      guest,
      (view) => !view.players.some((player) => player.id === created.playerId),
    );
    expect(snapshot.players.find((player) => player.id === joined.playerId)?.isHost).toBe(true);
  }, 1_000);

  it('force-folds both active-hand actors and non-actors before removing them', async () => {
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
    const remaining = await connectClient(server.url);
    clients.push(host, guest, remaining);
    const created = await emitAck<{ roomCode: string; playerId: string }>(
      host,
      'room:create',
      { nickname: '房主' },
    );
    const joined = await emitAck<{ playerId: string }>(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    const survivor = await emitAck<{ playerId: string }>(remaining, 'room:join', {
      roomCode: created.roomCode,
      nickname: '留在牌桌',
    });
    await emitAck(host, 'game:start', {});
    const room = server.rooms.getRoom(created.roomCode)!;
    const guestCommitted = room.hand!.players.find((player) => player.id === joined.playerId)!.totalCommitted;

    await emitAck(guest, 'room:leave', {});

    expect(room.hand!.players.find((player) => player.id === joined.playerId)).toMatchObject({
      folded: true,
      totalCommitted: guestCommitted,
    });
    expect(room.seats.some((player) => player?.id === joined.playerId)).toBe(false);
    await emitAck(host, 'room:leave', {});
    expect(room.hand!.players.find((player) => player.id === created.playerId)).toMatchObject({
      folded: true,
    });
    const snapshot = await nextSnapshot(
      remaining,
      (view) => !view.players.some((player) => player.id === created.playerId),
    );
    expect(snapshot.actorId).not.toBe(created.playerId);
    expect(snapshot.players.some((player) => player.id === survivor.playerId)).toBe(true);
  }, 1_000);

  it('conserves a departing all-in over-contributor through multi-player settlement', async () => {
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
    const third = await connectClient(server.url);
    clients.push(host, guest, third);
    const created = await emitAck<{ roomCode: string; playerId: string }>(
      host,
      'room:create',
      { nickname: '房主' },
    );
    const joined = await emitAck<{ playerId: string }>(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    const thirdSeat = await emitAck<{ playerId: string }>(third, 'room:join', {
      roomCode: created.roomCode,
      nickname: '第三位',
    });
    await emitAck(host, 'game:start', {});

    const room = server.rooms.getRoom(created.roomCode)!;
    const hand = room.hand!;
    hand.board = hand.deck.splice(0, 5);
    hand.street = 'showdown';
    hand.actorId = null;
    hand.currentBet = 0;
    for (const player of hand.players) {
      player.stack = 0;
      player.streetBet = 0;
      player.totalCommitted = player.id === created.playerId ? 1_000 : 500;
      player.allIn = true;
      player.folded = false;
      player.actedSinceFullRaise = true;
    }

    await emitAck(host, 'room:leave', {});

    const settledView = await nextSnapshot(guest, (view) => view.phase === 'between-hands');
    expect(room.phase).toBe('between-hands');
    expect(room.hand!.players.reduce((sum, player) => sum + player.stack, 0)).toBe(2_000);
    expect(room.hand!.players.find((player) => player.id === created.playerId)).toMatchObject({
      folded: true,
      stack: 500,
      totalCommitted: 1_000,
    });
    expect(room.seats
      .filter((player) => player?.id === joined.playerId || player?.id === thirdSeat.playerId)
      .reduce((sum, player) => sum + (player?.stack ?? 0), 0)).toBe(1_500);
    expect(settledView.pots).toEqual([{ amount: 1_500 }]);
  }, 1_000);

  it('preserves the current human deadline when a non-actor leaves', async () => {
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
    const third = await connectClient(server.url);
    clients.push(host, guest, third);
    const created = await emitAck<{ roomCode: string; playerId: string }>(
      host,
      'room:create',
      { nickname: '房主' },
    );
    const joined = await emitAck<{ playerId: string }>(guest, 'room:join', {
      roomCode: created.roomCode,
      nickname: '朋友',
    });
    const thirdSeat = await emitAck<{ playerId: string }>(third, 'room:join', {
      roomCode: created.roomCode,
      nickname: '第三位',
    });
    await emitAck(host, 'game:start', {});

    const room = server.rooms.getRoom(created.roomCode)!;
    const actorId = room.hand!.actorId!;
    const actorNickname = room.seats.find((player) => player?.id === actorId)!.nickname;
    const nonActor = [
      { client: host, playerId: created.playerId },
      { client: guest, playerId: joined.playerId },
      { client: third, playerId: thirdSeat.playerId },
    ].find((entry) => entry.playerId !== actorId)!;
    const originalDeadline = room.actionDeadline;
    const originalTimeout = scheduler.callbacks()[0];
    scheduler.advanceBy(5_000);

    await emitAck(nonActor.client, 'room:leave', {});

    expect(room.hand?.actorId).toBe(actorId);
    expect(room.actionDeadline).toBe(originalDeadline);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.callbacks()[0]).toBe(originalTimeout);
    scheduler.advanceBy(25_000);
    expect(room.messages.map((message) => message.text)).toContain(
      `${actorNickname} 超时，自动弃牌`,
    );
  });

  it('destroys a last-human room with bots on explicit leave', async () => {
    const server = await startTestServer({ randomCode: () => 'ABCD23', randomToken: () => 'token-1' });
    servers.push(server);
    const host = await connectClient(server.url);
    clients.push(host);
    const created = await emitAck<{ roomCode: string }>(host, 'room:create', { nickname: '房主' });
    await emitAck(host, 'room:add-bot', { style: 'balanced' });

    await emitAck(host, 'room:leave', {});

    expect(server.rooms.getRoom(created.roomCode)).toBeUndefined();
  }, 1_000);
});

describe('production server configuration', () => {
  it('uses port 3000 by default and rejects partial, fractional, or out-of-range ports', () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort('4173')).toBe(4173);
    for (const invalid of ['', ' 3000', '3000abc', '3.5', '0', '65536']) {
      expect(() => parsePort(invalid)).toThrow(/PORT/);
    }
  });

  it('lists each unique non-internal IPv4 LAN URL', () => {
    expect(collectLanUrls(3000, {
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      eth0: [
        { address: '192.168.1.24', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: null, scopeid: 2 },
      ],
      wlan0: [
        { address: '10.0.0.8', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
        { address: '192.168.1.24', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
      ],
    })).toEqual([
      'http://192.168.1.24:3000',
      'http://10.0.0.8:3000',
    ]);
  });
});
