# Shared Port 8080 Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every existing Drawing API URL on external port `8080` while exposing the poker application at `/poker/` through the same port.

**Architecture:** Add explicit `/poker` base-path support to the poker server and browser, then place a small Node HTTP/WebSocket gateway in front of two loopback-only upstreams: Drawing API on `127.0.0.1:18080` and poker on `127.0.0.1:3000`. A supervised runtime and transactional runbook provide bounded startup, exact-PID shutdown, health checks, and rollback to the original Drawing API command.

**Tech Stack:** TypeScript, Node.js HTTP, Express 5, Socket.IO 4, Vite 7, React 19, `http-proxy` 1.18.1, Vitest 4, Bash, Python 3.10 standard-library SQLite.

**Spec:** `docs/superpowers/specs/2026-09-03-shared-8080-gateway-design.md`

## Global Constraints

- Do not modify `/home/sxy/.worktrees/drawing-api-annotator-proxy` or `/root/workspace/12.autoresearch`; both contain existing user work and data.
- Never run two Drawing API processes against `/root/workspace/12.autoresearch/drawing_api_961/var/qdrant` concurrently.
- Preserve all Drawing API external paths and payloads; only the upstream bind changes from `0.0.0.0:8080` to `127.0.0.1:18080`.
- Poker is public only under the segment-safe `/poker` prefix; `/pokerface` and every other path belong to Drawing API.
- Poker Socket.IO uses `/poker/socket.io`; invitation links use `/poker/?room=CODE` and never contain a session token.
- Do not change firewall rules, platform port mappings, Drawing API data, models, secrets, or uncommitted source files.
- Stop only PIDs created by this runtime or the one exact preflight-verified Drawing API PID during the approved cutover.
- If any post-cutover Drawing API or poker check fails, restore the original Drawing API listener on `0.0.0.0:8080` before reporting.
- Every production-code behavior change follows RED → GREEN TDD; configuration-only shell syntax still receives an executable integration check.

---

### Task 1: Add an explicit poker public base path

**Files:**
- Create: `src/shared/basePath.ts`
- Create: `src/vite-env.d.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Modify: `src/client/socket.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/main.tsx`
- Modify: `vite.config.ts`
- Modify: `tests/support/socket.ts`
- Modify: `tests/socket.integration.test.ts`
- Modify: `tests/client-socket.test.tsx`
- Modify: `tests/client-lobby.test.tsx`
- Test: `tests/base-path.test.ts`

**Interfaces:**
- Produces: `normalizeBasePath(value?: string): string`, returning `''` for root or a slash-prefixed value without a trailing slash.
- Produces: `pathWithinBase(basePath: string, suffix: string): string` for health and Socket.IO paths.
- Extends: `PokerServerOptions` with `basePath?: string`.
- Extends: `createPokerClient(options?: { socket?: PokerSocket; basePath?: string })` and `AppProps.basePath?` while keeping root defaults backward-compatible.
- Consumes: Vite `base` from `VITE_BASE_PATH`, with `/` as the development/default build value.

- [ ] **Step 1: Write failing base-path and server mount tests**

Add focused assertions before production code exists:

```ts
// tests/base-path.test.ts
expect(normalizeBasePath(undefined)).toBe('');
expect(normalizeBasePath('/')).toBe('');
expect(normalizeBasePath('/poker/')).toBe('/poker');
expect(() => normalizeBasePath('poker')).toThrow(/BASE_PATH/);
expect(() => normalizeBasePath('/poker?room=x')).toThrow(/BASE_PATH/);

// tests/socket.integration.test.ts
const server = await startTestServer({ staticDir, basePath: '/poker' });
await request(server.url).get('/poker/health').expect(200, { ok: true });
await request(server.url).get('/health').expect(404);
await request(server.url).get('/poker/rooms/ABCD23').expect(200, /测试牌桌/);
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm test -- tests/base-path.test.ts tests/socket.integration.test.ts
```

Expected: FAIL because `basePath.ts` and `PokerServerOptions.basePath` do not exist.

- [ ] **Step 3: Implement normalized server mounting**

Implement the shared helper with exact validation:

```ts
export function normalizeBasePath(value: string | undefined): string {
  if (value === undefined || value === '' || value === '/') return '';
  if (!value.startsWith('/') || /[?#]/.test(value)) {
    throw new Error('BASE_PATH 必须是以 / 开头的 URL 路径');
  }
  const normalized = value.replace(/\/+$/, '');
  if (normalized === '' || normalized.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('BASE_PATH 必须是安全的 URL 路径');
  }
  return normalized;
}

export function pathWithinBase(basePath: string, suffix: string): string {
  return `${normalizeBasePath(basePath)}/${suffix.replace(/^\/+/, '')}`;
}
```

In `createPokerServer`, mount an Express router under the normalized base, set Socket.IO `path` to `pathWithinBase(basePath, 'socket.io')`, add a permanent `/poker` → `/poker/` redirect for non-root bases, and keep root behavior unchanged. `startLanServer` reads `BASE_PATH` and logs URLs with the base suffix.

- [ ] **Step 4: Add failing browser URL and transport-path tests**

```tsx
render(<App
  client={client}
  basePath="/poker"
  locationHref="http://host:8080/poker/?room=abcd23"
/>);
// after room creation
expect(screen.getByDisplayValue('http://host:8080/poker/?room=ABCD23')).toBeInTheDocument();
expect(screen.queryByDisplayValue(/session-secret/)).not.toBeInTheDocument();

expect(socketPathFor('/poker/')).toBe('/poker/socket.io');
expect(socketPathFor('/')).toBe('/socket.io');
```

- [ ] **Step 5: Run and verify browser RED**

Run:

```bash
npm test -- tests/client-lobby.test.tsx tests/client-socket.test.tsx
```

Expected: FAIL because invitations reset to `/` and the default client has no configurable Socket.IO path.

- [ ] **Step 6: Implement browser and Vite base-path behavior**

Set Vite `base` from `VITE_BASE_PATH ?? '/'`. Add `/// <reference types="vite/client" />`. In `main.tsx`, normalize `import.meta.env.BASE_URL`, pass it to `createPokerClient` and `App`, and export/test:

```ts
export function socketPathFor(basePath: string): string {
  return pathWithinBase(basePath, 'socket.io');
}

export function createPokerClient(options: {
  socket?: PokerSocket;
  basePath?: string;
} = {}): PokerClient {
  const basePath = normalizeBasePath(options.basePath ?? import.meta.env.BASE_URL);
  const socket = options.socket ?? io({ path: socketPathFor(basePath) });
  return new SocketPokerClient(socket);
}
```

Make `inviteFor` retain the normalized base path and only replace the `room` query parameter.

- [ ] **Step 7: Verify Task 1 and commit**

Run:

```bash
npm test -- tests/base-path.test.ts tests/socket.integration.test.ts tests/client-socket.test.tsx tests/client-lobby.test.tsx
npm test
VITE_BASE_PATH=/poker/ npm run build
rg -n '/poker/assets/' dist/index.html
git diff --check
```

Expected: all tests PASS; built HTML references `/poker/assets/`; no whitespace errors.

Commit:

```bash
git add src tests vite.config.ts
git commit -m "feat: support poker public base path"
```

---

### Task 2: Implement the HTTP and WebSocket gateway

**Files:**
- Create: `src/gateway/app.ts`
- Create: `src/gateway/index.ts`
- Create: `tests/gateway.integration.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `isPathWithinBase(requestUrl: string, basePath: string): boolean` with segment-safe matching.
- Produces: `createGateway(options: GatewayOptions): GatewayServer`.
- Produces: `startGateway(options?: GatewayStartOptions): Promise<RunningGateway>`.
- Consumes: `drawingUpstream`, `pokerUpstream`, and `pokerBasePath` without rewriting the selected request path.

- [ ] **Step 1: Install the pinned proxy dependency**

Run:

```bash
npm install http-proxy@1.18.1
npm install --save-dev @types/http-proxy@1.17.17
```

Expected: lockfile records the two compatible versions and `npm audit` output is captured rather than silently ignored.

- [ ] **Step 2: Write failing HTTP routing and preservation tests**

Create two ephemeral upstream HTTP servers that echo method, URL, headers, and body. Assert:

```ts
expect(isPathWithinBase('/poker', '/poker')).toBe(true);
expect(isPathWithinBase('/poker/?room=ABCD23', '/poker')).toBe(true);
expect(isPathWithinBase('/pokerface', '/poker')).toBe(false);

await request(gateway.url).post('/api/v1/search?top_k=3')
  .set('content-type', 'application/json')
  .send({ query: '齿轮' })
  .expect(200)
  .expect(({ body }) => {
    expect(body.upstream).toBe('drawing');
    expect(body.url).toBe('/api/v1/search?top_k=3');
    expect(body.body).toEqual({ query: '齿轮' });
  });

await request(gateway.url).get('/poker/health')
  .expect(200)
  .expect(({ body }) => expect(body.upstream).toBe('poker'));
```

- [ ] **Step 3: Run and verify HTTP RED**

Run:

```bash
npm test -- tests/gateway.integration.test.ts
```

Expected: FAIL because the gateway factory does not exist.

- [ ] **Step 4: Implement request routing and bounded errors**

Use one `http-proxy` instance per gateway and choose the target per request. Preserve the URL and streaming body. On upstream error, return status `502`, `content-type: application/json`, and `{"error":"上游服务暂不可用"}` only when headers have not already been sent. Never include upstream credentials or stack traces in the response.

The gateway close method is idempotent and closes the proxy plus HTTP listener:

```ts
export interface GatewayOptions {
  drawingUpstream: URL;
  pokerUpstream: URL;
  pokerBasePath?: string;
}

export interface GatewayServer {
  httpServer: HttpServer;
  close(): Promise<void>;
}

export interface GatewayStartOptions {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface RunningGateway {
  host: string;
  port: number;
  gateway: GatewayServer;
  close(): Promise<void>;
}
```

- [ ] **Step 5: Write a failing real Socket.IO upgrade test**

Start a real `createPokerServer({ basePath: '/poker' })` backend and connect through the gateway:

```ts
const client = io(gateway.url, {
  path: '/poker/socket.io',
  transports: ['websocket'],
  forceNew: true,
});
await once(client, 'connect');
const created = await emitAck(client, 'room:create', { nickname: '房主' });
expect(created.roomCode).toMatch(/^[A-Z0-9]{6}$/);
```

- [ ] **Step 6: Run and verify WebSocket RED**

Run:

```bash
npm test -- tests/gateway.integration.test.ts -t "Socket.IO"
```

Expected: FAIL because no `upgrade` handler forwards WebSocket traffic.

- [ ] **Step 7: Implement WebSocket forwarding and the gateway entrypoint**

Handle `httpServer.on('upgrade')` with the same segment-safe target selection. `startGateway` validates absolute `http:` upstream URLs, `GATEWAY_PORT` using the existing strict port parser, and `GATEWAY_HOST`; default to:

```text
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=8080
DRAWING_UPSTREAM=http://127.0.0.1:18080
POKER_UPSTREAM=http://127.0.0.1:3000
POKER_BASE_PATH=/poker
```

Register and remove `SIGINT`/`SIGTERM` handlers exactly once.

- [ ] **Step 8: Verify Task 2 and commit**

Run:

```bash
npm test -- tests/gateway.integration.test.ts tests/socket.integration.test.ts
npm test
npm run build
git diff --check
```

Expected: HTTP, WebSocket, upstream failure, shutdown, full tests, and TypeScript build all PASS.

Commit:

```bash
git add src/gateway tests/gateway.integration.test.ts package.json package-lock.json
git commit -m "feat: add shared HTTP and WebSocket gateway"
```

---

### Task 3: Add a supervised shared-port runtime

**Files:**
- Create: `src/gateway/supervisor.ts`
- Create: `scripts/shared-8080.sh`
- Create: `tests/gateway-supervisor.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Produces: `runSupervisor(options: SupervisorOptions): Promise<void>` with injectable child launcher, readiness fetcher, clock, paths, and log sink.
- Produces: `npm run shared:run` for the foreground supervisor.
- Produces: `npm run shared -- start|stop|status|run` for controlled detached operation.
- Stores: `var/shared-8080/supervisor.pid` and `var/shared-8080/shared.log`; `var/` is ignored.

- [ ] **Step 1: Write failing lifecycle tests**

Use fake child processes to prove exact behavior:

```ts
it('starts drawing, poker, then gateway only after readiness', async () => {
  const events: string[] = [];
  await runSupervisor(fixture({
    spawnChild: fakeSpawner(events),
    waitUntilReady: fakeReadiness(events),
    stopAfterReady: true,
  }));
  expect(events).toEqual([
    'spawn:drawing', 'ready:drawing',
    'spawn:poker', 'ready:poker',
    'spawn:gateway', 'ready:gateway',
    'stop:gateway', 'stop:poker', 'stop:drawing',
  ]);
});

it('stops already-started children in reverse order when readiness fails', async () => {
  await expect(runSupervisor(failingPokerFixture())).rejects.toThrow(/poker/);
  expect(events).toEqual(['spawn:drawing', 'ready:drawing', 'spawn:poker', 'stop:poker', 'stop:drawing']);
});
```

Also cover SIGTERM idempotency, unexpected child exit, timeout, and refusal to treat an unrelated PID as owned.

- [ ] **Step 2: Run and verify lifecycle RED**

Run:

```bash
npm test -- tests/gateway-supervisor.test.ts
```

Expected: FAIL because `runSupervisor` and the control script do not exist.

- [ ] **Step 3: Implement the foreground supervisor**

Keep process orchestration behind these explicit seams so tests never start the real Drawing API:

```ts
export interface ChildSpec {
  name: 'drawing' | 'poker' | 'gateway';
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

export interface SupervisorOptions {
  specs?: readonly ChildSpec[];
  spawnChild?: (spec: ChildSpec) => OwnedChild;
  waitUntilReady?: (url: string, timeoutMs: number) => Promise<void>;
  log?: (message: string) => void;
  pidFile?: string;
}
```

Production defaults must be explicit:

```ts
const drawing = {
  cwd: '/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961',
  command: './scripts/start_local_961.sh',
  env: {
    DRAWING_API_HOST: '127.0.0.1',
    DRAWING_API_PORT: '18080',
    DRAWING_API_DATA_DIR: '/root/workspace/12.autoresearch/drawing_api_961/var',
    DRAWING_API_QDRANT_LOCAL_PATH: '/root/workspace/12.autoresearch/drawing_api_961/var/qdrant',
  },
  readyUrl: 'http://127.0.0.1:18080/ready',
};
```

Spawn poker with `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`, `BASE_PATH=/poker`, and gateway with the Task 2 defaults. Use argument arrays and `shell: false`. Poll readiness with a bounded 60-second timeout and condition-based intervals. Forward SIGINT/SIGTERM, wait a bounded interval, then use SIGKILL only for still-running owned child PIDs.

- [ ] **Step 4: Implement the control script and executable integration test**

`scripts/shared-8080.sh` accepts only `start`, `stop`, `status`, or `run`. `start` uses the repository's absolute path, refuses a live owned PID, removes only a stale validated PID file, starts the supervisor with `nohup`, and waits for both `http://127.0.0.1:8080/ready` and `/poker/health`. `stop` reads the PID file and validates `/proc/${supervisor_pid}/cmdline` contains the exact supervisor entrypoint before signaling it. It never uses `pkill`, `killall`, a wildcard, or a port-based kill. For the executable test only, `NODE_ENV=test` permits `SHARED_SUPERVISOR_ENTRY` to name a temporary fake entrypoint; production rejects that override.

The integration test runs the script against temporary fake commands through documented test-only environment overrides, confirms all three child PIDs disappear after `stop`, and runs:

```bash
bash -n scripts/shared-8080.sh
```

- [ ] **Step 5: Verify Task 3 and commit**

Run:

```bash
npm test -- tests/gateway-supervisor.test.ts tests/gateway.integration.test.ts
npm test
VITE_BASE_PATH=/poker/ npm run build
bash -n scripts/shared-8080.sh
git diff --check
```

Expected: lifecycle and integration tests PASS, production build passes, and the shell script parses cleanly.

Commit:

```bash
git add .gitignore package.json src/gateway/supervisor.ts scripts/shared-8080.sh tests/gateway-supervisor.test.ts
git commit -m "feat: supervise shared 8080 services"
```

---

### Task 4: Add the preflight, rollback runbook, and perform cutover

**Files:**
- Create: `scripts/check-drawing-idle.py`
- Create: `tests/check-drawing-idle.test.ts`
- Create: `docs/shared-8080-runbook.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `check-drawing-idle.py DATABASE_PATH`, a read-only SQLite preflight that exits `0` only when both task tables contain no nonterminal rows.
- Documents: exact baseline, cutover, verification, rollback, status, stop, and restart commands.
- Produces: deployed poker URL `/poker/` while preserving Drawing API paths.

- [ ] **Step 1: Write failing read-only preflight tests**

Create temporary SQLite databases with `ingestion_tasks` and `parse_tasks` status columns. Assert:

```ts
expect(runCheck(databaseWith(['completed', 'failed']))).toMatchObject({ status: 0 });
expect(runCheck(databaseWith(['queued']))).toMatchObject({ status: 2, stdout: expect.stringMatching(/queued/) });
expect(runCheck(databaseWith(['processing']))).toMatchObject({ status: 2, stdout: expect.stringMatching(/processing/) });
```

The script must open `file:/root/workspace/12.autoresearch/drawing_api_961/var/drawing_api.sqlite3?mode=ro` (or the absolute argument supplied by the test) with URI mode enabled, treat `completed`, `completed_with_warnings`, `failed_retryable`, and `failed` as terminal, and print counts only—never task payloads or secrets.

- [ ] **Step 2: Run and verify preflight RED**

Run:

```bash
npm test -- tests/check-drawing-idle.test.ts
```

Expected: FAIL because the preflight script does not exist.

- [ ] **Step 3: Implement the preflight and operational documentation**

Implement the read-only query without importing Drawing API code or opening a writable connection:

```py
TERMINAL = ('completed', 'completed_with_warnings', 'failed_retryable', 'failed')

def nonterminal_counts(database_path: Path) -> dict[str, int]:
    absolute = database_path.resolve(strict=True)
    uri = f"file:{quote(str(absolute), safe='/')}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        return {
            table: connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE status NOT IN (?, ?, ?, ?)",
                TERMINAL,
            ).fetchone()[0]
            for table in ('ingestion_tasks', 'parse_tasks')
        }
```

Exit `0` only when both counts are zero, `2` when work is active, and `1` for an unreadable/malformed database. Print JSON containing only table counts and the high-level result.

Document these exact guarded phases:

```bash
# Baseline and idle gate
python3 scripts/check-drawing-idle.py /root/workspace/12.autoresearch/drawing_api_961/var/drawing_api.sqlite3
curl --noproxy '*' --fail http://127.0.0.1:8080/live
curl --noproxy '*' --fail http://127.0.0.1:8080/ready

# Build before outage
VITE_BASE_PATH=/poker/ npm run build
npm test

# Approved exact-PID cutover (drawing_pid is resolved and verified immediately before use)
kill -TERM "$drawing_pid"
npm run shared -- start

# Shared entry verification
curl --noproxy '*' --fail http://127.0.0.1:8080/live
curl --noproxy '*' --fail http://127.0.0.1:8080/ready
curl --noproxy '*' --fail http://127.0.0.1:8080/api/v1/drawings?page=1\&page_size=1
curl --noproxy '*' --fail http://127.0.0.1:8080/poker/health
```

The runbook's rollback stops only the supervisor, then restarts the original Drawing API with the same source worktree and data paths:

```bash
cd /home/sxy/lan-texas-holdem/.worktrees/lan-poker
npm run shared -- stop

cd /home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961
nohup env \
  DRAWING_API_HOST=0.0.0.0 \
  DRAWING_API_PORT=8080 \
  DRAWING_API_DATA_DIR=/root/workspace/12.autoresearch/drawing_api_961/var \
  DRAWING_API_QDRANT_LOCAL_PATH=/root/workspace/12.autoresearch/drawing_api_961/var/qdrant \
  ./scripts/start_local_961.sh \
  > /home/sxy/lan-texas-holdem/.worktrees/lan-poker/var/shared-8080/drawing-rollback.log 2>&1 &
rollback_pid=$!
printf '%s\n' "$rollback_pid" > /home/sxy/lan-texas-holdem/.worktrees/lan-poker/var/shared-8080/drawing-rollback.pid

curl --noproxy '*' --retry 30 --retry-delay 1 --retry-connrefused --fail http://127.0.0.1:8080/live
curl --noproxy '*' --fail http://127.0.0.1:8080/ready
```

- [ ] **Step 4: Verify code before touching the live Drawing API**

Run:

```bash
npm test
VITE_BASE_PATH=/poker/ npm run build
bash -n scripts/shared-8080.sh
git diff --check
npm audit --omit=dev
```

Expected: all tests and build PASS; audit has no high/critical production vulnerability. If audit reports high/critical severity, stop before cutover and replace or mitigate the dependency.

- [ ] **Step 5: Re-read live state and execute the bounded cutover**

From the poker repository, record fresh outputs without secrets:

```bash
mapfile -t drawing_pids < <(pgrep -f '^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main --host 0\.0\.0\.0 --port 8080 --workers 1$')
test "${#drawing_pids[@]}" -eq 1
drawing_pid="${drawing_pids[0]}"
test "$(readlink -f "/proc/${drawing_pid}/cwd")" = '/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961'
test "$(tr '\0' ' ' < "/proc/${drawing_pid}/cmdline")" = '/root/workspace/12.autoresearch/.venv/bin/python -m drawing_api_961.main --host 0.0.0.0 --port 8080 --workers 1 '
python3 scripts/check-drawing-idle.py /root/workspace/12.autoresearch/drawing_api_961/var/drawing_api.sqlite3
```

Proceed only when there is exactly one matching PID, its cwd is `/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961`, both baseline health calls pass, and the idle check exits `0`. Then signal that exact PID and start the supervisor. On any mismatch, do not signal anything.

- [ ] **Step 6: Run post-cutover acceptance and rollback on failure**

Verify Drawing API and poker through the shared gateway. In addition to the curl checks, run a real Socket.IO client against `http://127.0.0.1:8080` with `path: '/poker/socket.io'` and perform create, join, plain/HTML-like chat, start, and one server-legal action. Confirm:

```text
Drawing /live status = 200
Drawing /ready status = 200 and all required components ready
Drawing list total equals the fresh pre-cutover baseline total
Poker /poker/ status = 200
Poker /poker/health = {"ok":true}
Poker WebSocket two-client smoke = PASS
External listener 8080 = gateway only
Loopback listener 18080 = Drawing API only
Loopback listener 3000 = poker only
```

If any assertion fails, run the documented rollback immediately and verify the restored Drawing API before investigating.

- [ ] **Step 7: Final verification and commit**

Run:

```bash
npm test
VITE_BASE_PATH=/poker/ npm run build
npm run shared -- status
curl --noproxy '*' --fail http://127.0.0.1:8080/ready
curl --noproxy '*' --fail http://127.0.0.1:8080/poker/health
git diff --check
git status --short
```

Update `README.md` with the externally mapped Drawing URL unchanged (`http://10.191.46.7:8091` in the existing deployment documentation), the poker URL `http://10.191.46.7:8091/poker/`, shared runtime commands, data-safety constraints, and rollback link. State that the mapping is environment-specific and local gateway checks still use container port `8080`.

Commit:

```bash
git add README.md docs/shared-8080-runbook.md scripts/check-drawing-idle.py tests/check-drawing-idle.test.ts
git commit -m "docs: deploy poker behind shared 8080 gateway"
```

Expected final state: Drawing API remains healthy at all old paths, poker is playable at `/poker/`, shared runtime status is healthy, no task was interrupted, and the feature worktree has no tracked changes.
