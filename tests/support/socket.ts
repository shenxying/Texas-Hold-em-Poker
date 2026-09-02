import { once } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import type { TableView } from '../../src/shared/protocol';
import { createPokerServer, type PokerServerOptions } from '../../src/server/app';
import type { RoomService } from '../../src/server/room';
import type { Scheduler } from '../../src/server/timers';

export interface TestServer {
  url: string;
  rooms: RoomService;
  close(): Promise<void>;
}

type TestClient = Socket;

const snapshots = new WeakMap<TestClient, TableView[]>();

export async function startTestServer(options: PokerServerOptions = {}): Promise<TestServer> {
  const server = createPokerServer(options);
  server.httpServer.listen(0, '127.0.0.1');
  await once(server.httpServer, 'listening');
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    rooms: server.rooms,
    close: server.close,
  };
}

export async function connectClient(url: string): Promise<TestClient> {
  const client = io(url, { transports: ['websocket'], forceNew: true });
  const queued: TableView[] = [];
  snapshots.set(client, queued);
  client.on('table:snapshot', (snapshot: TableView) => queued.push(snapshot));
  await new Promise<void>((resolve) => {
    client.once('connect', resolve);
  });
  return client;
}

export async function emitRawAck<T>(
  client: TestClient,
  event: string,
  payload: unknown,
): Promise<T> {
  return new Promise<T>((resolve) => {
    client.emit(event, payload, resolve);
  });
}

export async function emitAck<T>(
  client: TestClient,
  event: string,
  payload: unknown,
): Promise<T> {
  const response = await emitRawAck<
    { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
  >(client, event, payload);
  if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
  return response.data;
}

export async function nextSnapshot(
  client: TestClient,
  predicate: (view: TableView) => boolean = () => true,
): Promise<TableView> {
  const queued = snapshots.get(client);
  if (queued === undefined) throw new Error('Client was not created by connectClient');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const latest = [...queued].reverse().find(predicate);
    if (latest !== undefined) {
      queued.length = 0;
      return latest;
    }
  }
  return new Promise<TableView>((resolve) => {
    const listener = (view: TableView): void => {
      if (!predicate(view)) return;
      client.off('table:snapshot', listener);
      queued.length = 0;
      resolve(view);
    };
    client.on('table:snapshot', listener);
  });
}

export function closeClient(client: TestClient): void {
  client.disconnect();
  snapshots.delete(client);
}
interface ScheduledTask {
  at: number;
  callback: () => void;
}

export class ManualScheduler implements Scheduler {
  private currentTime = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, ScheduledTask>();

  now = (): number => this.currentTime;

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.currentTime + delayMs, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.tasks.delete(handle);
  };

  pendingCount(): number {
    return this.tasks.size;
  }

  callbacks(): Array<() => void> {
    return [...this.tasks.values()].map((task) => task.callback);
  }

  advanceBy(milliseconds: number): void {
    const target = this.currentTime + milliseconds;
    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.currentTime = task.at;
      task.callback();
    }
    this.currentTime = target;
  }

  clear(): void {
    this.tasks.clear();
  }
}
