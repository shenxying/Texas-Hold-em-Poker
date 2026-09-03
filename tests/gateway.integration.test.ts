import { once } from 'node:events';
import {
  createServer,
  get,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createGateway, isPathWithinBase, type GatewayServer } from '../src/gateway/app';
import { startGateway, type RunningGateway } from '../src/gateway/index';
import { createPokerServer, type PokerServer } from '../src/server/app';
import { emitAck } from './support/socket';

interface ListeningServer {
  server: HttpServer;
  url: string;
}

const httpServers: HttpServer[] = [];
const gateways: GatewayServer[] = [];
const pokerServers: PokerServer[] = [];
const clients: Socket[] = [];
const runningGateways: RunningGateway[] = [];
const rawSockets: Duplex[] = [];

async function listen(server: HttpServer): Promise<ListeningServer> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port');
  }
  httpServers.push(server);
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function readBody(requestMessage: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of requestMessage) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function reservePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Port reservation did not bind a TCP port');
  }
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

async function waitForSocketConnection(client: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      client.off('connect_error', onConnectError);
      resolve();
    };
    const onConnectError = (error: Error): void => {
      client.off('connect', onConnect);
      reject(error);
    };
    client.once('connect', onConnect);
    client.once('connect_error', onConnectError);
  });
}

function waitForSocketClose(socket: Duplex): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  });
}

function echoUpstream(
  upstream: string,
  status: number,
  responseHeader: string,
): HttpServer {
  return createServer(async (requestMessage: IncomingMessage, response: ServerResponse) => {
    const rawBody = await readBody(requestMessage);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-upstream-response', responseHeader);
    response.end(JSON.stringify({
      upstream,
      method: requestMessage.method,
      url: requestMessage.url,
      requestHeader: requestMessage.headers['x-gateway-test'],
      body: rawBody === '' ? null : JSON.parse(rawBody),
    }));
  });
}

async function startGatewayForTest(
  drawingUpstream: string,
  pokerUpstream: string,
): Promise<{ gateway: GatewayServer; url: string }> {
  const gateway = createGateway({
    drawingUpstream: new URL(drawingUpstream),
    pokerUpstream: new URL(pokerUpstream),
    pokerBasePath: '/poker',
  });
  gateways.push(gateway);
  const listening = await listen(gateway.httpServer);
  return { gateway, url: listening.url };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const socket of rawSockets.splice(0)) socket.destroy();
  for (const running of runningGateways.splice(0)) await running.close();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of pokerServers.splice(0)) await server.close();
  for (const server of httpServers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});

describe('shared gateway entrypoint', () => {
  it('starts with the default host and poker base, then removes one signal handler on close', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    const poker = await listen(echoUpstream('poker', 200, 'poker-header'));
    const port = await reservePort();
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const messages: string[] = [];
    const running = await startGateway({
      env: {
        GATEWAY_PORT: String(port),
        DRAWING_UPSTREAM: drawing.url,
        POKER_UPSTREAM: poker.url,
      },
      log: (message) => messages.push(message),
    });
    runningGateways.push(running);

    expect(running.host).toBe('0.0.0.0');
    expect(running.port).toBe(port);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    expect(messages.join('\n')).toContain(`http://localhost:${port}/poker/`);
    await request(`http://127.0.0.1:${port}`)
      .get('/poker/health?probe=1')
      .expect(200)
      .expect(({ body }) => {
        expect(body.upstream).toBe('poker');
        expect(body.url).toBe('/poker/health?probe=1');
      });

    const first = running.close();
    const second = running.close();
    expect(second).toBe(first);
    await first;
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it.each([
    ['DRAWING_UPSTREAM', 'relative'],
    ['DRAWING_UPSTREAM', 'https://127.0.0.1:18080'],
    ['POKER_UPSTREAM', 'relative'],
    ['POKER_UPSTREAM', 'https://127.0.0.1:3000'],
  ] as const)('rejects non-absolute-http %s values', async (name, value) => {
    await expect(startGateway({
      env: {
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: '8081',
        DRAWING_UPSTREAM: 'http://127.0.0.1:18080',
        POKER_UPSTREAM: 'http://127.0.0.1:3000',
        [name]: value,
      },
      log: () => undefined,
    })).rejects.toThrow(new RegExp(name));
  });

  it.each(['0', '3.5', '8080x', '65536'])('rejects invalid GATEWAY_PORT=%s', async (value) => {
    await expect(startGateway({
      env: { GATEWAY_PORT: value },
      log: () => undefined,
    })).rejects.toThrow(/PORT/);
  });

  it('rejects an empty gateway host before binding', async () => {
    await expect(startGateway({
      env: { GATEWAY_HOST: '   ', GATEWAY_PORT: '8081' },
      log: () => undefined,
    })).rejects.toThrow(/GATEWAY_HOST/);
  });
});

describe('shared gateway HTTP routing', () => {
  it('matches the poker base by complete path segment only', () => {
    expect(isPathWithinBase('/poker', '/poker')).toBe(true);
    expect(isPathWithinBase('/poker/?room=ABCD23', '/poker')).toBe(true);
    expect(isPathWithinBase('/pokerface', '/poker')).toBe(false);
  });

  it('preserves drawing request method, URL, headers, body, status, and headers', async () => {
    const drawing = await listen(echoUpstream('drawing', 207, 'drawing-header'));
    const poker = await listen(echoUpstream('poker', 200, 'poker-header'));
    const gateway = await startGatewayForTest(`${drawing.url}/configured-base`, poker.url);

    await request(gateway.url)
      .post('/api/v1/search?top_k=3')
      .set('content-type', 'application/json')
      .set('x-gateway-test', 'preserved')
      .send({ query: '齿轮' })
      .expect(207)
      .expect('x-upstream-response', 'drawing-header')
      .expect(({ body }) => {
        expect(body).toEqual({
          upstream: 'drawing',
          method: 'POST',
          url: '/api/v1/search?top_k=3',
          requestHeader: 'preserved',
          body: { query: '齿轮' },
        });
      });
  });

  it('preserves repeated slashes in a drawing request URL byte-for-byte', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    const poker = await listen(echoUpstream('poker', 200, 'poker-header'));
    const gateway = await startGatewayForTest(drawing.url, poker.url);

    await request(gateway.url)
      .get('/api//v1///items?next=//keep')
      .expect(200)
      .expect(({ body }) => {
        expect(body.upstream).toBe('drawing');
        expect(body.url).toBe('/api//v1///items?next=//keep');
      });
  });

  it('preserves the poker prefix and keeps similarly named paths on drawing', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    const poker = await listen(echoUpstream('poker', 200, 'poker-header'));
    const gateway = await startGatewayForTest(drawing.url, poker.url);

    await request(gateway.url)
      .get('/poker/health?probe=1')
      .expect(200)
      .expect(({ body }) => {
        expect(body.upstream).toBe('poker');
        expect(body.url).toBe('/poker/health?probe=1');
      });
    await request(gateway.url)
      .get('/pokerface')
      .expect(200)
      .expect(({ body }) => expect(body.upstream).toBe('drawing'));
  });

  it('returns a bounded 502 response when the selected upstream is unavailable', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    const unavailable = await listen(echoUpstream('unused', 200, 'unused'));
    await new Promise<void>((resolve, reject) => {
      unavailable.server.close((error) => error === undefined ? resolve() : reject(error));
    });
    const credential = 'gateway-secret';
    const gateway = await startGatewayForTest(
      drawing.url,
      unavailable.url.replace('http://', `http://${credential}@`),
    );

    const response = await request(gateway.url)
      .get('/poker/health')
      .expect(502)
      .expect('content-type', /application\/json/);

    expect(response.body).toEqual({ error: '上游服务暂不可用' });
    expect(response.text).not.toContain(credential);
    expect(response.text).not.toContain('ECONNREFUSED');
    expect(response.text).not.toContain('\n    at ');
  });

  it('closes a pending HTTP upstream request before close resolves', async () => {
    let captureRequest: (requestMessage: IncomingMessage) => void = () => undefined;
    const receivedRequest = new Promise<IncomingMessage>((resolve) => {
      captureRequest = resolve;
    });
    const stalledUpstream = createServer((requestMessage) => {
      captureRequest(requestMessage);
    });
    const drawing = await listen(stalledUpstream);
    const poker = await listen(echoUpstream('poker', 200, 'poker-header'));
    const gateway = await startGatewayForTest(drawing.url, poker.url);
    const clientRequest = get(`${gateway.url}/api/pending`);
    clientRequest.on('error', () => undefined);
    clientRequest.on('socket', (socket) => rawSockets.push(socket));
    const upstreamRequest = await receivedRequest;
    rawSockets.push(upstreamRequest.socket);
    upstreamRequest.socket.on('error', () => undefined);
    const upstreamClosed = waitForSocketClose(upstreamRequest.socket);

    await gateway.gateway.close();
    await upstreamClosed;

    expect(upstreamRequest.socket.destroyed).toBe(true);
  });

  it('closes the gateway idempotently', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    const poker = await listen(echoUpstream('poker', 200, 'poker-header'));
    const { gateway } = await startGatewayForTest(drawing.url, poker.url);

    const first = gateway.close();
    const second = gateway.close();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(gateway.httpServer.listening).toBe(false);
  });
});

describe('shared gateway Socket.IO routing', () => {
  it('preserves repeated slashes in a WebSocket upgrade URL byte-for-byte', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    let captureUrl: (url: string) => void = () => undefined;
    const receivedUrl = new Promise<string>((resolve) => {
      captureUrl = resolve;
    });
    const pokerServer = createServer();
    pokerServer.on('upgrade', (requestMessage, socket) => {
      socket.on('error', () => undefined);
      captureUrl(requestMessage.url ?? '');
      socket.end([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'));
    });
    const poker = await listen(pokerServer);
    const gateway = await startGatewayForTest(drawing.url, poker.url);
    const gatewayUrl = new URL(gateway.url);
    const client = connect({
      host: gatewayUrl.hostname,
      port: Number(gatewayUrl.port),
    });
    rawSockets.push(client);
    await once(client, 'connect');

    client.write([
      'GET /poker/socket.io//engine///?EIO=4&transport=websocket&next=//keep HTTP/1.1',
      `Host: ${gatewayUrl.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'));

    await expect(receivedUrl).resolves.toBe(
      '/poker/socket.io//engine///?EIO=4&transport=websocket&next=//keep',
    );
  });

  it('closes a pending WebSocket upstream handshake before close resolves', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    let captureSocket: (socket: Duplex) => void = () => undefined;
    const receivedSocket = new Promise<Duplex>((resolve) => {
      captureSocket = resolve;
    });
    const stalledUpstream = createServer();
    stalledUpstream.on('upgrade', (_requestMessage, socket) => {
      socket.resume();
      captureSocket(socket);
    });
    const poker = await listen(stalledUpstream);
    const gateway = await startGatewayForTest(drawing.url, poker.url);
    const gatewayUrl = new URL(gateway.url);
    const client = connect({
      host: gatewayUrl.hostname,
      port: Number(gatewayUrl.port),
    });
    rawSockets.push(client);
    await once(client, 'connect');
    client.write([
      'GET /poker/socket.io/?EIO=4&transport=websocket HTTP/1.1',
      `Host: ${gatewayUrl.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'));
    const upstreamSocket = await receivedSocket;
    rawSockets.push(upstreamSocket);
    upstreamSocket.on('error', () => undefined);
    const upstreamClosed = waitForSocketClose(upstreamSocket);

    await gateway.gateway.close();
    await upstreamClosed;

    expect(upstreamSocket.destroyed).toBe(true);
  });

  it('forwards a real Socket.IO upgrade and releases it on close', async () => {
    const drawing = await listen(echoUpstream('drawing', 200, 'drawing-header'));
    const poker = createPokerServer({ basePath: '/poker' });
    pokerServers.push(poker);
    const listeningPoker = await listen(poker.httpServer);
    const gateway = await startGatewayForTest(drawing.url, listeningPoker.url);
    const client = io(gateway.url, {
      path: '/poker/socket.io',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 500,
    });
    clients.push(client);

    await waitForSocketConnection(client);
    const created = await emitAck<{ roomCode: string }>(client, 'room:create', {
      nickname: '房主',
    });
    expect(created.roomCode).toMatch(/^[A-Z0-9]{6}$/);

    const upstreamSocket = poker.io.sockets.sockets.values().next().value;
    if (upstreamSocket === undefined) throw new Error('Poker server has no connected socket');
    const upstreamDisconnected = new Promise<void>((resolve) => {
      upstreamSocket.once('disconnect', () => resolve());
    });
    await gateway.gateway.close();
    await upstreamDisconnected;
    expect(poker.io.engine.clientsCount).toBe(0);
  });
});
