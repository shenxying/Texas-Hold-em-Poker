import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';
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
  const targetFor = (requestUrl: string): URL => (
    isPathWithinBase(requestUrl, pokerBasePath)
      ? options.pokerUpstream
      : options.drawingUpstream
  );
  const httpServer = createServer((request, response) => {
    const target = targetFor(request.url ?? '/');
    proxy.web(request, response, { target: target.href, prependPath: false }, () => {
      sendUpstreamUnavailable(response);
    });
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

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      proxy.close();
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close((error) => error === undefined ? resolve() : reject(error));
      for (const socket of sockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
    });
    return closePromise;
  };

  return { httpServer, close };
}
