export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemScheduler: Scheduler = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ActionTimerRegistry {
  private readonly handles = new Map<string, unknown>();

  constructor(private readonly scheduler: Scheduler) {}

  replace(roomCode: string, callback: () => void, delayMs: number): void {
    this.clear(roomCode);
    let handle: unknown;
    handle = this.scheduler.setTimeout(() => {
      if (this.handles.get(roomCode) === handle) {
        this.handles.delete(roomCode);
      }
      callback();
    }, delayMs);
    this.handles.set(roomCode, handle);
  }

  clear(roomCode: string): void {
    const handle = this.handles.get(roomCode);
    if (handle === undefined) return;
    this.scheduler.clearTimeout(handle);
    this.handles.delete(roomCode);
  }

  dispose(): void {
    for (const roomCode of [...this.handles.keys()]) this.clear(roomCode);
  }
}

export class DisconnectTimerRegistry extends ActionTimerRegistry {}
