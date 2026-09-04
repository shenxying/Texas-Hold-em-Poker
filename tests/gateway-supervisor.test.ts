import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { access, link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultChildSpecs,
  runSupervisor,
  trackSpawnedChild,
  type ChildSpec,
  type OwnedChild,
  type SpawnedChildLike,
  type SupervisorOptions,
} from '../src/gateway/supervisor';

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function fakeSpecs(): ChildSpec[] {
  return ['drawing', 'poker', 'gateway'].map((name) => ({
    name: name as ChildSpec['name'],
    command: `/fake/${name}`,
    args: [],
    cwd: '/fake',
    env: {},
    readyUrl: `http://127.0.0.1:0/${name}`,
  }));
}

function fixture(
  events: string[],
  overrides: Partial<SupervisorOptions> = {},
): SupervisorOptions {
  let nextPid = 10_000;
  return {
    specs: fakeSpecs(),
    pidFile: join(tmpdir(), `shared-supervisor-${process.pid}-${Math.random()}.pid`),
    stopAfterReady: true,
    spawnChild(spec) {
      events.push(`spawn:${spec.name}`);
      const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
      let stopped = false;
      return {
        pid: nextPid++,
        exited: exit.promise,
        signal(signal) {
          if (stopped) return;
          stopped = true;
          events.push(`stop:${spec.name}`);
          exit.resolve({ code: null, signal });
        },
      };
    },
    async waitUntilReady(url) {
      events.push(`ready:${url.slice(url.lastIndexOf('/') + 1)}`);
    },
    ...overrides,
  };
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe('runSupervisor', () => {
  it('excludes a contender while the owner pauses before publishing its PID file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-publication-'));
    temporaryPaths.push(root);
    const pidFile = join(root, 'supervisor.pid');
    const publicationEntered = deferred<void>();
    const releasePublication = deferred<void>();
    const readyGate = deferred<void>();
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];

    const first = runSupervisor(fixture(firstEvents, {
      pidFile,
      beforePidFilePublication: async () => {
        publicationEntered.resolve(undefined);
        await releasePublication.promise;
      },
      waitUntilReady: async () => readyGate.promise,
    }));
    await publicationEntered.promise;
    const unpublishedContents = await readFile(pidFile, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    expect(unpublishedContents).not.toBe(`${process.pid}\n`);

    const second = runSupervisor(fixture(secondEvents, {
      pidFile,
      waitUntilReady: async () => readyGate.promise,
    }));
    const secondOutcome = second.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    );
    let observedSecondOutcome: Awaited<typeof secondOutcome> | undefined;
    void secondOutcome.then((outcome) => {
      observedSecondOutcome = outcome;
    });

    try {
      await waitFor(() => observedSecondOutcome !== undefined ||
        secondEvents.some((event) => event.startsWith('spawn:')));
      expect(observedSecondOutcome).toBe('rejected');
      expect(secondEvents.filter((event) => event.startsWith('spawn:'))).toEqual([]);
    } finally {
      releasePublication.resolve(undefined);
      readyGate.resolve(undefined);
      await Promise.allSettled([first, second]);
    }
    expect(firstEvents.filter((event) => event.startsWith('spawn:'))).toHaveLength(3);
  });

  it('atomically allows only one concurrent supervisor to spawn Drawing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-race-'));
    temporaryPaths.push(root);
    const pidFile = join(root, 'supervisor.pid');
    const readyGate = deferred<void>();
    const events: string[] = [];
    const outcomes: Array<'fulfilled' | 'rejected'> = [];
    const makeOptions = (): SupervisorOptions => fixture(events, {
      pidFile,
      stopAfterReady: true,
      waitUntilReady: async () => readyGate.promise,
    });

    const first = runSupervisor(makeOptions()).then(
      () => outcomes.push('fulfilled'),
      () => outcomes.push('rejected'),
    );
    const second = runSupervisor(makeOptions()).then(
      () => outcomes.push('fulfilled'),
      () => outcomes.push('rejected'),
    );

    try {
      await waitFor(() => outcomes.includes('rejected') ||
        events.filter((event) => event === 'spawn:drawing').length > 1);
      expect(events.filter((event) => event === 'spawn:drawing')).toHaveLength(1);
      expect(outcomes).toEqual(['rejected']);
    } finally {
      readyGate.resolve(undefined);
      await Promise.all([first, second]);
    }
    expect(events.filter((event) => event.startsWith('spawn:'))).toHaveLength(3);
  });

  it('starts drawing, poker, then gateway only after each service is ready', async () => {
    const events: string[] = [];

    await runSupervisor(fixture(events));

    expect(events).toEqual([
      'spawn:drawing', 'ready:drawing',
      'spawn:poker', 'ready:poker',
      'spawn:gateway', 'ready:gateway',
      'stop:gateway', 'stop:poker', 'stop:drawing',
    ]);
  });

  it('stops already-started children in reverse order when readiness fails', async () => {
    const events: string[] = [];
    const options = fixture(events, {
      async waitUntilReady(url) {
        const name = url.slice(url.lastIndexOf('/') + 1);
        if (name === 'poker') throw new Error('poker readiness failed');
        events.push(`ready:${name}`);
      },
    });

    await expect(runSupervisor(options)).rejects.toThrow(/poker readiness failed/);
    expect(events).toEqual([
      'spawn:drawing', 'ready:drawing',
      'spawn:poker', 'stop:poker', 'stop:drawing',
    ]);
  });

  it('aborts Poker readiness when an already-ready Drawing child exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-prior-exit-'));
    temporaryPaths.push(root);
    const events: string[] = [];
    const exits = new Map<ChildSpec['name'], ReturnType<typeof deferred<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>>>();

    const running = runSupervisor({
      specs: fakeSpecs(),
      pidFile: join(root, 'supervisor.pid'),
      stopAfterReady: true,
      spawnChild(spec) {
        events.push(`spawn:${spec.name}`);
        const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
        exits.set(spec.name, exit);
        return {
          pid: 40_000 + exits.size,
          exited: exit.promise,
          signal(signal) {
            events.push(`stop:${spec.name}`);
            exit.resolve({ code: null, signal });
          },
        };
      },
      async waitUntilReady(url) {
        const name = url.slice(url.lastIndexOf('/') + 1) as ChildSpec['name'];
        if (name === 'drawing') {
          events.push('ready:drawing');
          return;
        }
        if (name === 'poker') {
          queueMicrotask(() => {
            events.push('exit:drawing');
            exits.get('drawing')?.resolve({ code: 9, signal: null });
          });
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
      },
    });

    await expect(running).rejects.toThrow(/drawing.*9/i);
    expect(events).toEqual([
      'spawn:drawing', 'ready:drawing', 'spawn:poker',
      'exit:drawing', 'stop:poker',
    ]);
  });

  it('propagates a bounded readiness timeout and cleans up', async () => {
    const events: string[] = [];
    const options = fixture(events, {
      async waitUntilReady(url, timeoutMs) {
        const name = url.slice(url.lastIndexOf('/') + 1);
        events.push(`timeout:${name}:${timeoutMs}`);
        throw new Error(`${name} readiness timed out`);
      },
    });

    await expect(runSupervisor(options)).rejects.toThrow(/drawing readiness timed out/);
    expect(events).toEqual(['spawn:drawing', 'timeout:drawing:60000', 'stop:drawing']);
  });

  it('rejects an unexpected child exit and stops remaining children in reverse order', async () => {
    const events: string[] = [];
    const gatewayExit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const base = fixture(events, { stopAfterReady: false });
    const baseSpawner = base.spawnChild!;
    const options = {
      ...base,
      spawnChild(spec: ChildSpec): OwnedChild {
        const child = baseSpawner(spec);
        if (spec.name !== 'gateway') return child;
        queueMicrotask(() => gatewayExit.resolve({ code: 7, signal: null }));
        return { ...child, exited: gatewayExit.promise };
      },
    };

    await expect(runSupervisor(options)).rejects.toThrow(/gateway.*7/i);
    expect(events).toEqual([
      'spawn:drawing', 'ready:drawing',
      'spawn:poker', 'ready:poker',
      'spawn:gateway', 'ready:gateway',
      'stop:poker', 'stop:drawing',
    ]);
  });

  it('handles repeated SIGTERM notifications idempotently', async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const options = fixture(events, {
      signalSource: signals,
      stopAfterReady: false,
      async waitUntilReady(url) {
        const name = url.slice(url.lastIndexOf('/') + 1);
        events.push(`ready:${name}`);
        if (name === 'gateway') {
          queueMicrotask(() => {
            signals.emit('SIGTERM');
            signals.emit('SIGTERM');
          });
        }
      },
    });

    await runSupervisor(options);

    expect(events.filter((event) => event.startsWith('stop:'))).toEqual([
      'stop:gateway', 'stop:poker', 'stop:drawing',
    ]);
  });

  it('waits for three TERM-resistant children to exit after KILL in reverse order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-kill-'));
    temporaryPaths.push(root);
    const pidFile = join(root, 'supervisor.pid');
    const events: string[] = [];
    let nextPid = 20_000;

    await runSupervisor({
      specs: fakeSpecs(),
      pidFile,
      stopAfterReady: true,
      shutdownTimeoutMs: 2,
      killTimeoutMs: 100,
      waitUntilReady: async () => undefined,
      spawnChild(spec) {
        const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
        let killed = false;
        return {
          pid: nextPid++,
          exited: exit.promise,
          signal(signal) {
            events.push(`${signal}:${spec.name}`);
            if (signal === 'SIGKILL' && !killed) {
              killed = true;
              setTimeout(() => {
                events.push(`exit:${spec.name}`);
                exit.resolve({ code: null, signal });
              }, 10);
            }
          },
        };
      },
    });

    expect(events).toEqual([
      'SIGTERM:gateway', 'SIGKILL:gateway', 'exit:gateway',
      'SIGTERM:poker', 'SIGKILL:poker', 'exit:poker',
      'SIGTERM:drawing', 'SIGKILL:drawing', 'exit:drawing',
    ]);
    await expect(access(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails shutdown and keeps PID ownership when a child survives SIGKILL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-stuck-'));
    temporaryPaths.push(root);
    const pidFile = join(root, 'supervisor.pid');
    const events: string[] = [];

    await expect(runSupervisor({
      specs: [fakeSpecs()[0]!],
      pidFile,
      stopAfterReady: true,
      shutdownTimeoutMs: 1,
      killTimeoutMs: 1,
      waitUntilReady: async () => undefined,
      spawnChild(spec) {
        return {
          pid: 30_000,
          exited: new Promise(() => undefined),
          signal(signal) {
            events.push(`${signal}:${spec.name}`);
          },
        };
      },
    })).rejects.toThrow(/drawing.*SIGKILL.*未退出/i);

    expect(events).toEqual(['SIGTERM:drawing', 'SIGKILL:drawing']);
    expect(await readFile(pidFile, 'utf8')).toBe(`${process.pid}\n`);
  });

  it.each([
    { failingIndex: 1, expected: [
      'spawn:drawing', 'ready:drawing', 'spawn:poker', 'stop:drawing',
    ] },
    { failingIndex: 2, expected: [
      'spawn:drawing', 'ready:drawing', 'spawn:poker', 'ready:poker',
      'spawn:gateway', 'stop:poker', 'stop:drawing',
    ] },
  ])('cleans prior owned children when service $failingIndex spawn has no PID', async ({
    failingIndex,
    expected,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-spawn-error-'));
    temporaryPaths.push(root);
    const events: string[] = [];
    let index = 0;

    await expect(runSupervisor({
      specs: fakeSpecs(),
      pidFile: join(root, 'supervisor.pid'),
      stopAfterReady: true,
      async waitUntilReady(url) {
        events.push(`ready:${url.slice(url.lastIndexOf('/') + 1)}`);
      },
      spawnChild(spec) {
        const currentIndex = index++;
        events.push(`spawn:${spec.name}`);
        const emitter = new EventEmitter();
        const child = emitter as unknown as SpawnedChildLike;
        child.pid = currentIndex === failingIndex ? undefined : 50_000 + currentIndex;
        child.kill = (signal) => {
          events.push(`stop:${spec.name}`);
          queueMicrotask(() => emitter.emit('exit', null, signal));
          return true;
        };
        if (child.pid === undefined) {
          queueMicrotask(() => emitter.emit('error', new Error(`${spec.name} spawn failed`)));
        }
        return trackSpawnedChild(spec, child);
      },
    })).rejects.toThrow(new RegExp(`无法启动 ${fakeSpecs()[failingIndex]?.name}`));

    expect(events).toEqual(expected);
  });

  it('uses the explicit production commands, loopback binds, and existing Drawing data paths', async () => {
    const repositoryRoot = resolve(import.meta.dirname, '..');
    const specs = createDefaultChildSpecs(repositoryRoot, {});

    expect(specs.map(({ name, command, args, cwd, readyUrl }) => ({
      name, command, args, cwd, readyUrl,
    }))).toEqual([
      {
        name: 'drawing',
        command: './scripts/start_local_961.sh',
        args: [],
        cwd: '/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961',
        readyUrl: 'http://127.0.0.1:18080/ready',
      },
      {
        name: 'poker',
        command: join(repositoryRoot, 'node_modules/.bin/tsx'),
        args: ['src/server/index.ts'],
        cwd: repositoryRoot,
        readyUrl: 'http://127.0.0.1:3000/poker/health',
      },
      {
        name: 'gateway',
        command: join(repositoryRoot, 'node_modules/.bin/tsx'),
        args: ['src/gateway/index.ts'],
        cwd: repositoryRoot,
        readyUrl: 'http://127.0.0.1:8080/poker/health',
      },
    ]);
    expect(specs[0]?.env).toMatchObject({
      DRAWING_API_HOST: '127.0.0.1',
      DRAWING_API_PORT: '18080',
      DRAWING_API_DATA_DIR: '/root/workspace/12.autoresearch/drawing_api_961/var',
      DRAWING_API_QDRANT_LOCAL_PATH: '/root/workspace/12.autoresearch/drawing_api_961/var/qdrant',
    });
    expect(specs[1]?.env).toMatchObject({
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3000', BASE_PATH: '/poker',
    });
    expect(specs[2]?.env).toMatchObject({
      GATEWAY_HOST: '0.0.0.0',
      GATEWAY_PORT: '8080',
      DRAWING_UPSTREAM: 'http://127.0.0.1:18080',
      POKER_UPSTREAM: 'http://127.0.0.1:3000',
      POKER_BASE_PATH: '/poker',
    });
  });

  it('rejects and preserves a malformed PID file without spawning children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-invalid-pid-'));
    temporaryPaths.push(root);
    const pidFile = join(root, 'supervisor.pid');
    await writeFile(pidFile, 'not-a-pid\n');
    const signals = new EventEmitter();
    const events: string[] = [];

    await expect(runSupervisor(fixture(events, {
      pidFile,
      signalSource: signals,
    }))).rejects.toThrow(/PID.*格式无效/i);

    expect(events.filter((event) => event.startsWith('spawn:'))).toEqual([]);
    expect(await readFile(pidFile, 'utf8')).toBe('not-a-pid\n');
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('reclaims a well-formed PID file only after its process has exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-stale-pid-'));
    temporaryPaths.push(root);
    const pidFile = join(root, 'supervisor.pid');
    const formerOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    if (formerOwner.pid === undefined) throw new Error('missing former owner PID');
    await once(formerOwner, 'exit');
    await writeFile(pidFile, `${formerOwner.pid}\n`);
    const lockFile = `${pidFile}.lock`;
    await link(pidFile, lockFile);
    const events: string[] = [];

    await runSupervisor(fixture(events, { pidFile }));

    expect(events.filter((event) => event.startsWith('spawn:'))).toHaveLength(3);
    await expect(access(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('shared-8080.sh', () => {
  it('starts, reports, and stops only its fake owned supervisor and children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-8080-test-'));
    temporaryPaths.push(root);
    const stateDir = join(root, 'state');
    const childPidFile = join(root, 'children.json');
    const entrypoint = join(root, 'fake-supervisor.mjs');
    await writeFile(entrypoint, `
      import { spawn } from 'node:child_process';
      import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
      const pidFile = process.env.SHARED_STATE_DIR + '/supervisor.pid';
      try {
        const descriptor = openSync(pidFile, 'wx', 0o600);
        writeFileSync(descriptor, process.pid + '\\n');
        closeSync(descriptor);
      } catch {
        process.exit(17);
      }
      const children = ['drawing', 'poker', 'gateway'].map(() =>
        spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
      writeFileSync(process.env.FAKE_CHILD_PID_FILE,
        JSON.stringify(children.map((child) => child.pid)));
      let stopping = false;
      const releasePid = () => {
        try {
          if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile);
        } catch {}
      };
      const stop = () => {
        if (stopping) return;
        stopping = true;
        for (const child of children) child.kill('SIGTERM');
        Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', resolve))))
          .then(() => { releasePid(); process.exit(0); });
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      setInterval(() => {}, 1000);
    `);
    const healthServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const healthBase = await listen(healthServer);
    const script = resolve(import.meta.dirname, '../scripts/shared-8080.sh');
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      SHARED_SUPERVISOR_ENTRY: entrypoint,
      SHARED_STATE_DIR: stateDir,
      SHARED_GATEWAY_READY_URL: `${healthBase}/ready`,
      SHARED_POKER_READY_URL: `${healthBase}/poker/health`,
      SHARED_START_TIMEOUT_SECONDS: '5',
      SHARED_STOP_TIMEOUT_SECONDS: '5',
      FAKE_CHILD_PID_FILE: childPidFile,
    };

    try {
      const started = await execFileAsync('bash', [script, 'start'], { env });
      expect(started.stdout).toMatch(/已启动/);
      await waitFor(async () => {
        try {
          await access(childPidFile);
          return true;
        } catch {
          return false;
        }
      });
      const childPids = JSON.parse(await readFile(childPidFile, 'utf8')) as number[];
      expect(childPids).toHaveLength(3);
      expect(await Promise.all(childPids.map(processExists))).toEqual([true, true, true]);

      const status = await execFileAsync('bash', [script, 'status'], { env });
      expect(status.stdout).toMatch(/运行中/);

      const stopStartedAt = Date.now();
      const stopped = await execFileAsync('bash', [script, 'stop'], { env });
      expect(stopped.stdout).toMatch(/已停止/);
      expect(Date.now() - stopStartedAt).toBeLessThan(2_000);
      await waitFor(async () => (await Promise.all(childPids.map(processExists))).every((alive) => !alive));
    } finally {
      await execFileAsync('bash', [script, 'stop'], { env }).catch(() => undefined);
      healthServer.close();
      await once(healthServer, 'close');
    }
  }, 15_000);

  it('allows only one of two concurrent start commands to publish and spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-8080-start-race-'));
    temporaryPaths.push(root);
    const stateDir = join(root, 'state');
    const marker = join(root, 'drawing-starts.log');
    const entrypoint = join(root, 'fake-racing-supervisor.mjs');
    await writeFile(entrypoint, `
      import {
        appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
      } from 'node:fs';
      mkdirSync(process.env.SHARED_STATE_DIR, { recursive: true });
      const pidFile = process.env.SHARED_STATE_DIR + '/supervisor.pid';
      try {
        const descriptor = openSync(pidFile, 'wx', 0o600);
        writeFileSync(descriptor, process.pid + '\\n');
        closeSync(descriptor);
      } catch {
        process.exit(17);
      }
      appendFileSync(process.env.FAKE_DRAWING_MARKER, 'spawn:drawing\\n');
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        try {
          if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile);
        } catch {}
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      setInterval(() => {}, 1000);
    `);
    const healthServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const healthBase = await listen(healthServer);
    const script = resolve(import.meta.dirname, '../scripts/shared-8080.sh');
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      SHARED_SUPERVISOR_ENTRY: entrypoint,
      SHARED_STATE_DIR: stateDir,
      SHARED_GATEWAY_READY_URL: `${healthBase}/ready`,
      SHARED_POKER_READY_URL: `${healthBase}/poker/health`,
      SHARED_START_TIMEOUT_SECONDS: '5',
      SHARED_STOP_TIMEOUT_SECONDS: '5',
      FAKE_DRAWING_MARKER: marker,
    };

    try {
      const starts = await Promise.allSettled([
        execFileAsync('bash', [script, 'start'], { env }),
        execFileAsync('bash', [script, 'start'], { env }),
      ]);
      expect(starts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['spawn:drawing']);
      const status = await execFileAsync('bash', [script, 'status'], { env });
      expect(status.stdout).toMatch(/运行中/);
    } finally {
      await execFileAsync('bash', [script, 'stop'], { env }).catch(() => undefined);
      healthServer.close();
      await once(healthServer, 'close');
    }
  }, 15_000);

  it('refuses to signal a live unrelated PID from the state file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-8080-unrelated-'));
    temporaryPaths.push(root);
    const stateDir = join(root, 'state');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(stateDir));
    await writeFile(join(stateDir, 'supervisor.pid'), `${process.pid}\n`);
    const entrypoint = join(root, 'not-this-process.mjs');
    await writeFile(entrypoint, 'setInterval(() => {}, 1000);\n');
    const script = resolve(import.meta.dirname, '../scripts/shared-8080.sh');

    await expect(execFileAsync('bash', [script, 'stop'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SHARED_SUPERVISOR_ENTRY: entrypoint,
        SHARED_STATE_DIR: stateDir,
      },
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/不属于.*supervisor/i) });
    expect(await readFile(join(stateDir, 'supervisor.pid'), 'utf8')).toBe(`${process.pid}\n`);
  });

  it('is executable and parses as valid Bash', async () => {
    const script = resolve(import.meta.dirname, '../scripts/shared-8080.sh');
    await execFileAsync('bash', ['-n', script]);
    expect((await stat(script)).mode & 0o111).not.toBe(0);
  });
});
