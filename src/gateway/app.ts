import {
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import { normalizeBasePath } from '../shared/basePath';

export interface GatewayOptions {
  drawingUpstream: URL;
  pokerUpstream: URL;
  pokerBasePath?: string;
}

export interface GatewayServer {
  httpServer: HttpServer;
  close(): Promise<void>;
}

export function isPathWithinBase(requestUrl: string, basePath: string): boolean {
  const normalizedBasePath = normalizeBasePath(basePath);
  if (normalizedBasePath === '') return true;
  const path = requestUrl.split(/[?#]/, 1)[0] ?? '';
  return path === normalizedBasePath || path.startsWith(`${normalizedBasePath}/`);
}

function sendUpstreamUnavailable(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: '上游服务暂不可用' }));
}

export function createGateway(options: GatewayOptions): GatewayServer {
  const pokerBasePath = normalizeBasePath(options.pokerBasePath ?? '/poker');
  const proxy = httpProxy.createProxyServer();
  const sockets = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();
  const proxyRequests = new Set<ClientRequest>();
  const proxySockets = new Set<Socket>();
  const expectHeaders = new WeakMap<IncomingMessage, string>();
  const trackProxyRequest = (proxyRequest: ClientRequest): void => {
    proxyRequests.add(proxyRequest);
    let proxySocket: Socket | undefined;
    const trackProxySocket = (socket: Socket): void => {
      proxySocket = socket;
      proxySockets.add(socket);
      socket.once('close', () => proxySockets.delete(socket));
    };
    if (proxyRequest.socket === null) {
      proxyRequest.once('socket', trackProxySocket);
    } else {
      trackProxySocket(proxyRequest.socket);
    }
    const release = (): void => {
      proxyRequests.delete(proxyRequest);
    };
    proxyRequest.once('close', release);
    proxyRequest.once('error', release);
    proxyRequest.once('finish', release);
    proxyRequest.once('upgrade', () => {
      release();
      if (proxySocket !== undefined) proxySockets.delete(proxySocket);
    });
  };
  const targetFor = (requestUrl: string): URL => (
    isPathWithinBase(requestUrl, pokerBasePath)
      ? options.pokerUpstream
      : options.drawingUpstream
  );
  const httpServer = createServer((request, response) => {
    const target = targetFor(request.url ?? '/');
    const expectHeader = request.headers.expect;
    if (expectHeader !== undefined) {
      expectHeaders.set(request, expectHeader);
      delete request.headers.expect;
    }
    try {
      proxy.web(request, response, { target: target.href, prependPath: false }, () => {
        sendUpstreamUnavailable(response);
      });
    } finally {
      if (expectHeader !== undefined) request.headers.expect = expectHeader;
    }
  });
  proxy.on('proxyReq', (proxyRequest, request) => {
    trackProxyRequest(proxyRequest);
    proxyRequest.path = request.url ?? '/';
    const expectHeader = expectHeaders.get(request);
    if (expectHeader !== undefined) {
      expectHeaders.delete(request);
      proxyRequest.setHeader('expect', expectHeader);
    }
  });
  proxy.on('proxyReqWs', (proxyRequest, request) => {
    trackProxyRequest(proxyRequest);
    proxyRequest.path = request.url ?? '/';
  });
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  httpServer.on('upgrade', (request, socket, head) => {
    const target = targetFor(request.url ?? '/');
    proxy.ws(
      request,
      socket,
      head,
      { target: target.href, prependPath: false },
      () => socket.destroy(),
    );
  });
  proxy.on('open', (socket) => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });

  const destroyProxyRequest = (proxyRequest: ClientRequest): Promise<void> => {
    if (proxyRequest.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      proxyRequest.once('close', resolve);
      proxyRequest.destroy();
    });
  };
  const resetSocket = (socket: Socket): Promise<void> => {
    if (socket.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.resetAndDestroy();
    });
  };
  const destroySocket = (socket: Socket): Promise<void> => {
    if (socket.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.destroy();
    });
  };
  const closeHttpServer = (): Promise<void> => {
    if (!httpServer.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error === undefined ? resolve() : reject(error));
    });
  };

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      proxy.close();
      const httpServerClosed = closeHttpServer();
      const proxySocketsClosed = [...proxySockets].map(resetSocket);
      const proxyRequestsClosed = [...proxyRequests].map(destroyProxyRequest);
      const upstreamSocketsClosed = [...upstreamSockets].map(destroySocket);
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        httpServerClosed,
        ...proxySocketsClosed,
        ...proxyRequestsClosed,
        ...upstreamSocketsClosed,
      ]);
    })();
    return closePromise;
  };

  return { httpServer, close };
}
