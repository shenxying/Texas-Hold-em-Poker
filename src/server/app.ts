import { randomInt as cryptoRandomInt } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import express from 'express';
import { Server as SocketIoServer } from 'socket.io';
import type { PlayerAction } from '../game/types';
import { normalizeBasePath, pathWithinBase } from '../shared/basePath';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/protocol';
import type { BotInput } from './ai';
import { RoomService } from './room';
import { registerPokerSocketHandlers } from './socket';
import { systemScheduler, type Scheduler } from './timers';

export interface PokerServerOptions {
  staticDir?: string;
  basePath?: string;
  scheduler?: Scheduler;
  randomCode?: () => string;
  randomToken?: () => string;
  randomInt?: (max: number) => number;
  random?: () => number;
  chooseBotAction?: (input: BotInput, random: () => number) => PlayerAction;
  rooms?: RoomService;
  onUnexpectedError?: (
    context: { command: string; roomCode?: string },
    error: unknown,
  ) => void;
}

export interface PokerServer {
  httpServer: HttpServer;
  io: SocketIoServer<ClientToServerEvents, ServerToClientEvents>;
  rooms: RoomService;
  close(): Promise<void>;
}

export function createPokerServer(options: PokerServerOptions = {}): PokerServer {
  const basePath = normalizeBasePath(options.basePath);
  const scheduler = options.scheduler ?? systemScheduler;
  const rooms = options.rooms ?? new RoomService({
    ...(options.randomCode === undefined ? {} : { randomCode: options.randomCode }),
    ...(options.randomToken === undefined ? {} : { randomToken: options.randomToken }),
    now: scheduler.now,
  });
  const app = express();
  const router = express.Router();
  router.get('/health', (_request, response) => response.json({ ok: true }));
  if (options.staticDir !== undefined) {
    router.use(express.static(options.staticDir));
    router.use((request, response, next) => {
      if (
        (request.method !== 'GET' && request.method !== 'HEAD') ||
        request.path === '/health' || request.path.startsWith('/health/') ||
        request.path.startsWith('/socket.io')
      ) {
        next();
        return;
      }
      response.sendFile('index.html', { root: options.staticDir }, (error) => {
        if (error !== undefined) next(error);
      });
    });
  }
  if (basePath === '') {
    app.use(router);
  } else {
    app.get(basePath, (request, response, next) => {
      if (request.path !== basePath) {
        next();
        return;
      }
      response.redirect(301, `${basePath}/`);
    });
    app.use(basePath, router);
  }
  const httpServer = createServer(app);
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    path: pathWithinBase(basePath, 'socket.io'),
    serveClient: false,
    cors: { origin: true, credentials: true },
  });
  const disposeSocket = registerPokerSocketHandlers(io, {
    rooms,
    scheduler,
    random: options.random ?? Math.random,
    ...(options.chooseBotAction === undefined
      ? {}
      : { chooseBotAction: options.chooseBotAction }),
    randomInt: options.randomInt ?? ((max: number) => cryptoRandomInt(max)),
    ...(options.onUnexpectedError === undefined
      ? {}
      : { onUnexpectedError: options.onUnexpectedError }),
  });

  let closePromise: Promise<void> | undefined;
  return {
    httpServer,
    io,
    rooms,
    close: () => {
      disposeSocket();
      closePromise ??= new Promise<void>((resolve, reject) => {
        io.close(() => {
          if (!httpServer.listening) {
            resolve();
            return;
          }
          httpServer.close((error) => error === undefined ? resolve() : reject(error));
        });
      });
      return closePromise;
    },
  };
}
