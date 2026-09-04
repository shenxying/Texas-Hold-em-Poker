import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve('.');
const cutoverScript = resolve('scripts/shared-8080-cutover.sh');
const rollbackScript = resolve('scripts/shared-8080-rollback.sh');
const temporaryRoots: string[] = [];

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  actions(): string[];
  set(name: string, value: string): void;
  replaceCwd(pid: number, target: string): void;
}

function executable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function createProc(
  procRoot: string,
  pid: number,
  ppid: number,
  cwd: string,
  args: string[],
  children: number[] = [],
): void {
  const directory = join(procRoot, String(pid));
  mkdirSync(join(directory, 'task', String(pid)), { recursive: true });
  writeFileSync(join(directory, 'stat'), `${pid} (fixture) S ${ppid} 0 0 0\n`);
  writeFileSync(join(directory, 'status'), `Name:\tfixture\nPPid:\t${ppid}\n`);
  writeFileSync(join(directory, 'cmdline'), Buffer.from(`${args.join('\0')}\0`));
  writeFileSync(join(directory, 'task', String(pid), 'children'), `${children.join(' ')}\n`);
  symlinkSync(cwd, join(directory, 'cwd'));
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'shared-cutover-safety-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  const procRoot = join(root, 'proc');
  const stateDir = join(root, 'state');
  const drawingRepo = join(root, 'drawing-repo');
  mkdirSync(bin, { recursive: true });
  mkdirSync(procRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(drawingRepo, { recursive: true });
  writeFileSync(join(root, 'database.sqlite3'), 'fixture');
  writeFileSync(join(root, 'actions'), '');
  writeFileSync(join(root, 'old-pids'), '101\n');
  writeFileSync(join(root, 'shared-pids'), '');
  writeFileSync(join(root, 'any-pids'), '101\n');
  writeFileSync(join(root, 'pgrep-rc'), '0\n');
  writeFileSync(join(root, 'idle-rc'), '0\n');
  writeFileSync(join(root, 'ready.json'), JSON.stringify({
    status: 'ready',
    components: { sqlite: { required: true, ready: true } },
  }));
  writeFileSync(join(root, 'total.json'), '{"total":962}\n');
  writeFileSync(join(root, 'shared-status-rc'), '1\n');
  writeFileSync(join(root, 'shared-stop-rc'), '0\n');
  writeFileSync(join(root, 'curl-mode'), 'ok\n');

  createProc(procRoot, 101, 1, drawingRepo, ['old-python', '--serve-old']);
  createProc(procRoot, 200, 1, repositoryRoot, ['node', 'src/gateway/supervisor.ts'], [201, 202, 204]);
  createProc(procRoot, 201, 200, drawingRepo, ['shared-python', '--serve-shared']);
  createProc(procRoot, 202, 200, repositoryRoot, ['node', 'poker-wrapper'], [203]);
  createProc(procRoot, 203, 202, repositoryRoot, ['node', 'src/server/index.ts']);
  createProc(procRoot, 204, 200, repositoryRoot, ['node', 'gateway-wrapper'], [205]);
  createProc(procRoot, 205, 204, repositoryRoot, ['node', 'src/gateway/index.ts']);
  createProc(procRoot, 301, 1, drawingRepo, ['old-python', '--serve-old']);

  writeFileSync(join(root, 'listeners'), [
    'tcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN 205/node',
    'tcp 0 0 127.0.0.1:3000 0.0.0.0:* LISTEN 203/node',
    'tcp 0 0 127.0.0.1:18080 0.0.0.0:* LISTEN 201/python',
    '',
  ].join('\n').replace('0.0.0.0:8080', '0.0.0.0:8080'));

  executable(join(bin, 'pgrep'), `#!/usr/bin/env bash
set -u
root="$SHARED_TEST_ROOT"
configured_rc="$(<"$root/pgrep-rc")"
if [[ "$configured_rc" -gt 1 ]]; then exit "$configured_rc"; fi
pattern="\${*: -1}"
case "$pattern" in
  OLD_PATTERN) file=old-pids ;;
  SHARED_PATTERN) file=shared-pids ;;
  ANY_PATTERN) file=any-pids ;;
  *) exit 2 ;;
esac
if [[ -s "$root/$file" ]]; then cat "$root/$file"; exit 0; fi
exit 1
`);
  executable(join(bin, 'curl'), `#!/usr/bin/env bash
set -u
root="$SHARED_TEST_ROOT"
url="\${*: -1}"
mode="$(<"$root/curl-mode")"
if [[ "$mode" == live-fail && "$url" == */live ]]; then exit 22; fi
if [[ "$mode" == ready-http-fail && "$url" == */ready ]]; then exit 22; fi
case "$url" in
  */ready) cat "$root/ready.json" ;;
  */api/v1/drawings*) cat "$root/total.json" ;;
  */poker/health) printf '{"ok":true}' ;;
  *) : ;;
esac
`);
  executable(join(bin, 'netstat'), `#!/usr/bin/env bash
cat "$SHARED_TEST_ROOT/listeners"
`);
  executable(join(bin, 'npm'), `#!/usr/bin/env bash
set -u
root="$SHARED_TEST_ROOT"
printf 'npm %s\n' "$*" >> "$root/actions"
case "$*" in
  'run shared -- status') exit "$(<"$root/shared-status-rc")" ;;
  'run shared -- start')
    printf '200\n' > "$SHARED_TEST_STATE_DIR/supervisor.pid"
    printf '201\n' > "$root/shared-pids"
    printf '201\n' > "$root/any-pids"
    exit 0
    ;;
  'run shared -- stop')
    rc="$(<"$root/shared-stop-rc")"
    if [[ "$rc" -eq 0 ]]; then
      : > "$root/shared-pids"
      if [[ "\${SHARED_TEST_PRESERVE_REMAINING_DRAWING:-}" != 1 ]]; then
        : > "$root/any-pids"
      fi
      rm -f "$SHARED_TEST_STATE_DIR/supervisor.pid"
    fi
    exit "$rc"
    ;;
  *) exit 0 ;;
esac
`);
  executable(join(bin, 'socket-smoke'), `#!/usr/bin/env bash
printf 'socket-smoke\n' >> "$SHARED_TEST_ROOT/actions"
`);
  executable(join(bin, 'idle-check'), `#!/usr/bin/env bash
root="$SHARED_TEST_ROOT"
rc="$(<"$root/idle-rc")"
printf '{"result":"%s","ingestion_tasks":%s,"parse_tasks":0}\n' "$([[ "$rc" -eq 0 ]] && echo idle || echo active)" "$([[ "$rc" -eq 0 ]] && echo 0 || echo 1)"
exit "$rc"
`);
  executable(join(bin, 'signal'), `#!/usr/bin/env bash
printf 'signal %s\n' "$*" >> "$SHARED_TEST_ROOT/actions"
: > "$SHARED_TEST_ROOT/old-pids"
: > "$SHARED_TEST_ROOT/any-pids"
sed -i 's/) S /) Z /' "$SHARED_TEST_PROC_ROOT/101/stat"
`);
  executable(join(bin, 'original-start'), `#!/usr/bin/env bash
printf 'original-start\n' >> "$SHARED_TEST_ROOT/actions"
printf '301\n' > "$SHARED_TEST_ROOT/old-pids"
printf '301\n' > "$SHARED_TEST_ROOT/any-pids"
printf '301\n' > "$SHARED_TEST_STATE_DIR/drawing-rollback.pid"
`);

  return {
    root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PATH: `${bin}:${process.env.PATH}`,
      SHARED_TEST_ROOT: root,
      SHARED_TEST_PROC_ROOT: procRoot,
      SHARED_TEST_STATE_DIR: stateDir,
      SHARED_TEST_DRAWING_REPO: drawingRepo,
      SHARED_TEST_DATABASE: join(root, 'database.sqlite3'),
      SHARED_TEST_SIGNAL_COMMAND: join(bin, 'signal'),
      SHARED_TEST_IDLE_COMMAND: join(bin, 'idle-check'),
      SHARED_TEST_ORIGINAL_START_COMMAND: join(bin, 'original-start'),
      SHARED_TEST_SOCKET_SMOKE_COMMAND: join(bin, 'socket-smoke'),
      SHARED_TEST_OLD_PATTERN: 'OLD_PATTERN',
      SHARED_TEST_SHARED_PATTERN: 'SHARED_PATTERN',
      SHARED_TEST_ANY_DRAWING_PATTERN: 'ANY_PATTERN',
      SHARED_TEST_EXPECTED_OLD_CMDLINE: 'old-python --serve-old ',
      SHARED_TEST_EXPECTED_SHARED_CMDLINE: 'shared-python --serve-shared ',
      SHARED_TEST_EXPECTED_TOTAL: '962',
      SHARED_TEST_ROLLBACK_LOG: join(root, 'rollback.log'),
    },
    actions: () => readFileSync(join(root, 'actions'), 'utf8').trim().split('\n').filter(Boolean),
    set: (name, value) => writeFileSync(join(root, name), `${value}\n`),
    replaceCwd(pid, target) {
      unlinkSync(join(procRoot, String(pid), 'cwd'));
      symlinkSync(target, join(procRoot, String(pid), 'cwd'));
    },
  };
}

function run(script: string, environment: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync('bash', [script, ...args], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
  });
}

function expectNoDestructiveAction(subject: Fixture): void {
  expect(subject.actions()).not.toEqual(expect.arrayContaining([
    expect.stringMatching(/^signal /),
    'npm run shared -- start',
    'original-start',
  ]));
}

function expectRejectedAt(result: ReturnType<typeof run>, pattern: RegExp): void {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(pattern);
  expect(result.stderr).not.toMatch(/No such file|cannot open/i);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fail-closed shared cutover', () => {
  it('does not signal or start Drawing when the idle gate is active', () => {
    const subject = fixture();
    subject.set('idle-rc', '2');
    expectRejectedAt(run(cutoverScript, subject.env), /idle/i);
    expectNoDestructiveAction(subject);
  });

  it('does not signal or start Drawing when exact PID identity is missing', () => {
    const subject = fixture();
    subject.set('old-pids', '');
    expectRejectedAt(run(cutoverScript, subject.env), /Drawing PID/i);
    expectNoDestructiveAction(subject);
  });

  it('does not signal or start Drawing when cwd does not match', () => {
    const subject = fixture();
    subject.replaceCwd(101, subject.root);
    expectRejectedAt(run(cutoverScript, subject.env), /cwd/i);
    expectNoDestructiveAction(subject);
  });

  it('does not signal or start Drawing when cmdline does not match', () => {
    const subject = fixture();
    subject.env.SHARED_TEST_EXPECTED_OLD_CMDLINE = 'different ';
    expectRejectedAt(run(cutoverScript, subject.env), /cmdline/i);
    expectNoDestructiveAction(subject);
  });

  it('does not signal or start Drawing when live health fails', () => {
    const subject = fixture();
    subject.set('curl-mode', 'live-fail');
    expectRejectedAt(run(cutoverScript, subject.env), /live/i);
    expectNoDestructiveAction(subject);
  });

  it('does not signal or start Drawing when ready JSON is not fully ready', () => {
    const subject = fixture();
    subject.set('ready.json', '{"status":"ready","components":{"sqlite":{"required":true,"ready":false}}}');
    expectRejectedAt(run(cutoverScript, subject.env), /ready/i);
    expectNoDestructiveAction(subject);
  });

  it('does not signal or start Drawing when the total changes', () => {
    const subject = fixture();
    subject.set('total.json', '{"total":961}');
    expectRejectedAt(run(cutoverScript, subject.env), /total/i);
    expectNoDestructiveAction(subject);
  });

  it('rejects pgrep execution errors instead of treating them as zero matches', () => {
    const subject = fixture();
    subject.set('pgrep-rc', '3');
    expectRejectedAt(run(cutoverScript, subject.env), /pgrep/i);
    expectNoDestructiveAction(subject);
  });

  it('treats pgrep exit 1 as an empty set during rollback', () => {
    const subject = fixture();
    subject.set('old-pids', '');
    subject.set('any-pids', '');
    const result = run(rollbackScript, subject.env, ['962']);
    expect(result.status).toBe(0);
    expect(subject.actions()).toContain('original-start');
  });

  it('does not start original Drawing when supervisor stop fails', () => {
    const subject = fixture();
    subject.set('shared-stop-rc', '9');
    expectRejectedAt(run(rollbackScript, subject.env, ['962']), /stop/i);
    expect(subject.actions()).not.toContain('original-start');
  });

  it('does not start original Drawing while any Drawing process remains', () => {
    const subject = fixture();
    subject.set('shared-stop-rc', '0');
    subject.set('any-pids', '777');
    subject.env.SHARED_TEST_PRESERVE_REMAINING_DRAWING = '1';
    expectRejectedAt(run(rollbackScript, subject.env, ['962']), /remaining Drawing/i);
    expect(subject.actions()).not.toContain('original-start');
  });

  it('rejects a wrong 18080 listener owner and rolls back after signaling', () => {
    const subject = fixture();
    subject.set('listeners', [
      'tcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN 205/node',
      'tcp 0 0 127.0.0.1:3000 0.0.0.0:* LISTEN 203/node',
      'tcp 0 0 127.0.0.1:18080 0.0.0.0:* LISTEN 999/python',
    ].join('\n'));
    const result = run(cutoverScript, subject.env);
    expectRejectedAt(result, /18080/i);
    expect(subject.actions()).toEqual(expect.arrayContaining([
      'signal -TERM 101',
      'npm run shared -- start',
      'npm run shared -- stop',
      'original-start',
    ]));
  });
});
