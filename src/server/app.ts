import { createServer, type Server as HttpServer } from 'node:http';
import express from 'express';
import { Server as SocketIoServer } from 'socket.io';
import type { PlayerAction } from '../game/types';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/protocol';
import type { BotInput } from './ai';
import { RoomService } from './room';
import { registerPokerSocketHandlers } from './socket';
import { systemScheduler, type Scheduler } from './timers';

export interface PokerServerOptions {
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
  const scheduler = options.scheduler ?? systemScheduler;
  const rooms = options.rooms ?? new RoomService({
    ...(options.randomCode === undefined ? {} : { randomCode: options.randomCode }),
    ...(options.randomToken === undefined ? {} : { randomToken: options.randomToken }),
    now: scheduler.now,
  });
  const app = express();
  app.get('/health', (_request, response) => response.json({ ok: true }));
  const httpServer = createServer(app);
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
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
    ...(options.randomInt === undefined ? {} : { randomInt: options.randomInt }),
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
