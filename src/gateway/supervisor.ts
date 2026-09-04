import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type ServiceName = 'drawing' | 'poker' | 'gateway';

export interface ChildSpec {
  name: ServiceName;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  readyUrl: string;
}

export interface OwnedChild {
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal(signal: NodeJS.Signals): void;
}

export interface SpawnedChildLike {
  pid?: number;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface SupervisorClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface SupervisorSignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface SupervisorOptions {
  specs?: readonly ChildSpec[];
  spawnChild?: (spec: ChildSpec) => OwnedChild;
  waitUntilReady?: (url: string, timeoutMs: number) => Promise<void>;
  clock?: SupervisorClock;
  signalSource?: SupervisorSignalSource;
  log?: (message: string) => void;
  pidFile?: string;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  killTimeoutMs?: number;
  stopAfterReady?: boolean;
}

interface TrackedChild {
  spec: ChildSpec;
  child: OwnedChild;
  result?: { code: number | null; signal: NodeJS.Signals | null };
}

const defaultClock: SupervisorClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds).unref();
  }),
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePid(contents: string): number | undefined {
  const value = contents.trim();
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

async function acquireOwnedPidFile(
  pidFile: string,
  clock: SupervisorClock,
): Promise<void> {
  await mkdir(dirname(pidFile), { recursive: true });
  for (;;) {
    try {
      const handle = await open(pidFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let observed: string;
    let observedStat;
    try {
      [observed, observedStat] = await Promise.all([
        readFile(pidFile, 'utf8'),
        lstat(pidFile),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let existingPid = parsePid(observed);
    if (existingPid !== undefined && processExists(existingPid)) {
      throw new Error(`共享服务监督器已在运行（PID ${existingPid}）`);
    }

    if (existingPid === undefined) {
      await clock.sleep(25);
      try {
        const settled = await readFile(pidFile, 'utf8');
        if (settled !== observed) continue;
        existingPid = parsePid(settled);
        if (existingPid !== undefined && processExists(existingPid)) {
          throw new Error(`共享服务监督器已在运行（PID ${existingPid}）`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }

    try {
      const currentStat = await lstat(pidFile);
      const current = await readFile(pidFile, 'utf8');
      if (currentStat.dev !== observedStat.dev || currentStat.ino !== observedStat.ino ||
          current !== observed) continue;
      await rm(pidFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function removeOwnedPidFile(pidFile: string): Promise<void> {
  try {
    const contents = await readFile(pidFile, 'utf8');
    if (contents.trim() === String(process.pid)) await rm(pidFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function trackSpawnedChild(
  spec: ChildSpec,
  child: SpawnedChildLike,
): OwnedChild {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once('error', () => resolveExit({ code: 1, signal: null }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    },
  );
  if (child.pid === undefined) throw new Error(`无法启动 ${spec.name}`);
  return {
    pid: child.pid,
    exited,
    signal(signal) {
      child.kill(signal);
    },
  };
}

function defaultSpawnChild(spec: ChildSpec): OwnedChild {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    stdio: 'inherit',
  });
  return trackSpawnedChild(spec, child);
}

async function waitForHttpReady(
  url: string,
  timeoutMs: number,
  clock: SupervisorClock,
): Promise<void> {
  const deadline = clock.now() + timeoutMs;
  let lastError: unknown;
  while (clock.now() < deadline) {
    const remaining = Math.max(1, deadline - clock.now());
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(2_000, remaining)),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await clock.sleep(Math.min(250, Math.max(1, deadline - clock.now())));
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : '';
  throw new Error(`等待 ${url} 就绪超时${detail}`);
}

export function createDefaultChildSpecs(
  repositoryRoot: string,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): readonly ChildSpec[] {
  const tsx = resolve(repositoryRoot, 'node_modules/.bin/tsx');
  return [
    {
      name: 'drawing',
      command: './scripts/start_local_961.sh',
      args: [],
      cwd: '/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961',
      env: {
        ...inheritedEnv,
        DRAWING_API_HOST: '127.0.0.1',
        DRAWING_API_PORT: '18080',
        DRAWING_API_DATA_DIR: '/root/workspace/12.autoresearch/drawing_api_961/var',
        DRAWING_API_QDRANT_LOCAL_PATH: '/root/workspace/12.autoresearch/drawing_api_961/var/qdrant',
      },
      readyUrl: 'http://127.0.0.1:18080/ready',
    },
    {
      name: 'poker',
      command: tsx,
      args: ['src/server/index.ts'],
      cwd: repositoryRoot,
      env: {
        ...inheritedEnv,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        BASE_PATH: '/poker',
      },
      readyUrl: 'http://127.0.0.1:3000/poker/health',
    },
    {
      name: 'gateway',
      command: tsx,
      args: ['src/gateway/index.ts'],
      cwd: repositoryRoot,
      env: {
        ...inheritedEnv,
        NODE_ENV: 'production',
        GATEWAY_HOST: '0.0.0.0',
        GATEWAY_PORT: '8080',
        DRAWING_UPSTREAM: 'http://127.0.0.1:18080',
        POKER_UPSTREAM: 'http://127.0.0.1:3000',
        POKER_BASE_PATH: '/poker',
      },
      readyUrl: 'http://127.0.0.1:8080/poker/health',
    },
  ];
}

function unexpectedExitError(
  tracked: TrackedChild,
  result: { code: number | null; signal: NodeJS.Signals | null },
): Error {
  const outcome = result.signal === null
    ? `退出码 ${String(result.code)}`
    : `信号 ${result.signal}`;
  return new Error(`${tracked.spec.name} 子进程意外退出（${outcome}）`);
}

async function waitForExit(
  tracked: TrackedChild,
  timeoutMs: number,
  clock: SupervisorClock,
): Promise<boolean> {
  if (tracked.result !== undefined) return true;
  return Promise.race([
    tracked.child.exited.then(() => true),
    clock.sleep(timeoutMs).then(() => false),
  ]);
}

async function stopChildren(
  children: TrackedChild[],
  termTimeoutMs: number,
  killTimeoutMs: number,
  clock: SupervisorClock,
  log: (message: string) => void,
): Promise<void> {
  const failures: Error[] = [];
  for (const tracked of [...children].reverse()) {
    if (tracked.result !== undefined) continue;
    log(`正在停止 ${tracked.spec.name}（PID ${tracked.child.pid}）`);
    tracked.child.signal('SIGTERM');
    if (await waitForExit(tracked, termTimeoutMs, clock)) continue;
    if (tracked.result === undefined) {
      log(`${tracked.spec.name} 未在期限内退出，发送 SIGKILL`);
      tracked.child.signal('SIGKILL');
      if (!await waitForExit(tracked, killTimeoutMs, clock)) {
        failures.push(new Error(
          `${tracked.spec.name} 收到 SIGKILL 后仍未退出（PID ${tracked.child.pid}）`,
        ));
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, '多个子进程未能退出');
}

export async function runSupervisor(options: SupervisorOptions = {}): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const specs = options.specs ?? createDefaultChildSpecs(repositoryRoot);
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  const clock = options.clock ?? defaultClock;
  const waitUntilReady = options.waitUntilReady ?? (
    (url: string, timeoutMs: number) => waitForHttpReady(url, timeoutMs, clock)
  );
  const signalSource = options.signalSource ?? process;
  const log = options.log ?? console.log;
  const pidFile = options.pidFile ?? resolve(repositoryRoot, 'var/shared-8080/supervisor.pid');
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const killTimeoutMs = options.killTimeoutMs ?? 5_000;
  const children: TrackedChild[] = [];
  let stopping = false;
  let resolveSignal!: () => void;
  let rejectFatalExit!: (error: Error) => void;
  const fatalExit = new Promise<never>((_resolve, reject) => {
    rejectFatalExit = reject;
  });
  const signalReceived = new Promise<void>((resolveStop) => {
    resolveSignal = resolveStop;
  });
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    resolveSignal();
  };
  signalSource.on('SIGINT', requestStop);
  signalSource.on('SIGTERM', requestStop);

  let ownsPidFile = false;
  try {
    await acquireOwnedPidFile(pidFile, clock);
    ownsPidFile = true;
    for (const spec of specs) {
      if (stopping) break;
      log(`正在启动 ${spec.name}……`);
      const child = spawnChild(spec);
      const tracked: TrackedChild = { spec, child };
      children.push(tracked);
      void child.exited.then((result) => {
        tracked.result = result;
        if (!stopping) rejectFatalExit(unexpectedExitError(tracked, result));
      });
      await Promise.race([
        waitUntilReady(spec.readyUrl, readyTimeoutMs),
        fatalExit,
        signalReceived,
      ]);
      if (stopping) break;
      log(`${spec.name} 已就绪`);
    }

    if (!stopping && children.length === specs.length && !options.stopAfterReady) {
      await Promise.race([
        signalReceived,
        fatalExit,
      ]);
    }
  } finally {
    stopping = true;
    signalSource.off('SIGINT', requestStop);
    signalSource.off('SIGTERM', requestStop);
    await stopChildren(children, shutdownTimeoutMs, killTimeoutMs, clock, log);
    if (ownsPidFile) await removeOwnedPidFile(pidFile);
  }
}

const isMain = process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  void runSupervisor().catch((error: unknown) => {
    console.error('共享服务监督器失败', error);
    process.exitCode = 1;
  });
}
