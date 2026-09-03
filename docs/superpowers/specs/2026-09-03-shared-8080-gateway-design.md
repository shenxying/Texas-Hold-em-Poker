# Shared Port 8080 Gateway Design

## Goal

Expose the existing Drawing API and the LAN Texas Hold'em application through the machine's single externally mapped port `8080`, while preserving every existing Drawing API URL and its data.

## Current state

- PID `928773` runs the Drawing API directly on `0.0.0.0:8080` from `/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961`.
- The Drawing API uses its existing SQLite/Qdrant data under `/root/workspace/12.autoresearch/drawing_api_961/var` and an embedded single worker. A second Drawing API process must not open the same local Qdrant concurrently.
- The Drawing API baseline is healthy: `/live`, `/ready`, and `/api/v1/drawings` return successful responses.
- The poker production app is built and tested but is not currently running. Its verified standalone port is `3000`.
- No general-purpose reverse proxy is installed.

## Chosen architecture

A small Node gateway owned by the poker repository becomes the only listener on `0.0.0.0:8080`:

```text
LAN client :8080
        |
        +-- /poker/* and /poker/socket.io/* --> Poker 127.0.0.1:3000
        |
        +-- every other path ----------------> Drawing API 127.0.0.1:18080
```

The gateway uses a maintained HTTP proxy library and supports both ordinary HTTP streaming and WebSocket upgrades. It does not parse, store, or rewrite Drawing API payloads. The Drawing API keeps all current external paths (`/api/v1/*`, `/live`, `/ready`, `/docs`, `/openapi.json`, and future paths) because the default route is forwarded unchanged.

The Drawing API business repository, uncommitted worktree, models, SQLite database, Qdrant files, uploads, and environment secrets are not modified.

## Poker sub-path contract

- Public entry: `/poker/`.
- Public health: `/poker/health`.
- Socket.IO transport: `/poker/socket.io`.
- Built assets use `/poker/assets/*`.
- Invite URLs retain `/poker/` and add only the `room` query parameter. Session tokens remain excluded.
- The poker server accepts an explicit normalized base path and mounts health, static assets, SPA fallback, and Socket.IO under that path.
- Standalone development remains supported at `/`; shared-port production sets the base path to `/poker` during build and start.

The gateway preserves the `/poker` prefix when proxying to the poker backend. This keeps browser URLs, generated assets, health checks, Socket.IO handshakes, and server routing aligned without ambiguous rewrite rules.

## Components

### Gateway library and entrypoint

`src/gateway/app.ts` exposes a testable factory that accepts Drawing and poker upstream URLs. It routes by a segment-safe `/poker` prefix, proxies HTTP and WebSocket traffic, returns a Chinese `502` response when an upstream is unavailable, and has idempotent shutdown.

`src/gateway/index.ts` validates `GATEWAY_HOST`, `GATEWAY_PORT`, `DRAWING_UPSTREAM`, and `POKER_UPSTREAM`, listens on `0.0.0.0:8080` by default, logs the public poker URL, and handles `SIGINT`/`SIGTERM` once.

### Poker base-path support

The server and Socket.IO client share one normalized public base-path rule. `/` remains the default for existing tests and ordinary standalone use. Shared-port build/runtime explicitly use `/poker` so there is no environment-dependent guess based on browser location.

Vite emits assets for `/poker/` in the shared build. The invitation helper uses the configured base path instead of replacing the URL with `/`.

### Process supervisor

`scripts/shared-8080.sh` provides `start`, `stop`, `status`, and foreground `run` operations. It uses explicit paths and PID files under the poker project's ignored `var/shared-8080/` directory.

The foreground supervisor starts exactly these children:

1. Existing Drawing API script from its current worktree, with only `DRAWING_API_HOST=127.0.0.1` and `DRAWING_API_PORT=18080` overridden.
2. Poker production server on `127.0.0.1:3000` with base path `/poker`.
3. Gateway on `0.0.0.0:8080`.

If any child exits, the supervisor terminates the others and returns a failure status. `stop` targets only PIDs recorded by this deployment and never searches broadly or kills unknown processes.

## Cutover and rollback

Because local Qdrant permits only one Drawing API process, the old and new Drawing API instances cannot overlap. The cutover is therefore deliberately short and transactional:

1. Record the exact current Drawing API command, cwd, safe non-secret environment, PID, and baseline responses.
2. Build poker for `/poker/` and run its tests before touching port `8080`.
3. Confirm no nonterminal Drawing API ingestion job is active. If activity cannot be ruled out, stop and ask rather than interrupt it.
4. Send `SIGTERM` only to the known Drawing API PID and wait for `8080` to close.
5. Start the shared supervisor.
6. Require all of these checks to pass within a bounded timeout:
   - `/live` and `/ready` through gateway;
   - a representative Drawing API list request through gateway;
   - `/openapi.json` through gateway;
   - `/poker/`, `/poker/health`, built assets, and SPA fallback;
   - a two-client Socket.IO room/create/join/chat/game action through `/poker/socket.io`.
7. If any check fails, stop the new process group and restart the original Drawing API on `0.0.0.0:8080` from the same cwd with the recorded environment. Verify `/live` and `/ready` before reporting the rollback.

The cutover never deletes data, changes firewall rules, or kills processes by name or port.

## Testing

Automated tests cover:

- exact segment routing: `/poker`, `/poker/`, assets and SPA to poker; lookalikes such as `/pokerface` to Drawing API;
- preservation of method, query, body, status, headers, and streaming for Drawing API requests;
- Socket.IO/WebSocket upgrade through `/poker/socket.io`;
- upstream failure returns `502` without crashing the gateway;
- base-path normalization and rejection of unsafe values;
- poker health/static/SPA and invite URLs under `/poker`;
- default root behavior remains unchanged;
- idempotent signal shutdown and child-process cleanup contracts.

Acceptance repeats the full poker suite and production build, validates the Drawing API before and after the switch, performs a real two-client poker smoke test through port `8080`, and checks that only the intended gateway owns external port `8080` afterward.

## Operational result

- Existing Drawing API users continue using the same base URL and paths.
- Poker users open `http://<mapped-host>:8080/poker/` (or the platform's external mapping of port `8080`).
- A brief Drawing API interruption is expected during the one-time cutover.
- The supervisor log and PID files provide local diagnostics and controlled restart/stop commands.
