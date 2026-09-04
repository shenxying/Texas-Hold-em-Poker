# 共享 8080 网关运维手册

这套部署保留 Drawing API 的全部原路径，并只把德州扑克挂在 `/poker/`。环境当前把外部
`http://10.191.46.7:8091` 映射到容器 `8080`；该映射是环境特定的，本机检查始终使用
`http://127.0.0.1:8080`。

## 不可跨越的安全边界

- 不修改 Drawing 源工作树、数据、Qdrant、模型或密钥。
- 同一时刻只能有一个 Drawing 进程访问
  `/root/workspace/12.autoresearch/drawing_api_961/var/qdrant`。
- 只停止 supervisor 自己记录且验证归属的 PID，或切换前刚刚完整验证过的唯一旧 Drawing PID。
  禁止使用 `pkill`、`killall` 或按端口杀进程。
- 任何 PID、命令行、cwd、健康、空闲、安全或监听器门禁不符，都在发信号前停止。
- 切换后的任一断言失败，都立即执行“回滚”，并先恢复 Drawing 健康再调查。

以下命令均从 Poker 工作树开始：

```bash
cd /home/sxy/lan-texas-holdem/.worktrees/lan-poker
```

## 1. 基线与空闲门禁

先确认共享 supervisor 尚未运行；若已运行，应使用后面的“状态、停止与重启”流程，而不是重复
切换。

```bash
if npm run shared -- status; then
  echo '共享 supervisor 已运行；拒绝重复 cutover' >&2
  exit 1
fi

mapfile -t drawing_pids < <(pgrep -f '^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main --host 0\.0\.0\.0 --port 8080 --workers 1$' || true)
test "${#drawing_pids[@]}" -eq 1
drawing_pid="${drawing_pids[0]}"
test "$(readlink -f "/proc/${drawing_pid}/cwd")" = '/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961'
test "$(tr '\0' ' ' < "/proc/${drawing_pid}/cmdline")" = '/root/workspace/12.autoresearch/.venv/bin/python -m drawing_api_961.main --host 0.0.0.0 --port 8080 --workers 1 '

python3 scripts/check-drawing-idle.py /root/workspace/12.autoresearch/drawing_api_961/var/drawing_api.sqlite3
curl --noproxy '*' --fail http://127.0.0.1:8080/live >/dev/null
curl --noproxy '*' --fail http://127.0.0.1:8080/ready >/dev/null
baseline_total="$(curl --noproxy '*' --fail --silent \
  'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1' | \
  python3 -c 'import json, sys; value = json.load(sys.stdin)["total"]; assert isinstance(value, int) and not isinstance(value, bool) and value >= 0; print(value)')"
printf 'Drawing baseline total=%s\n' "$baseline_total"
```

空闲脚本以 SQLite URI `mode=ro` 打开数据库，仅输出任务表聚合计数和高层结果。退出码 `0` 表示
两张任务表都没有非终态行，`2` 表示仍有工作，`1` 表示数据库不可读或结构异常。终态仅包括
`completed`、`completed_with_warnings`、`failed_retryable` 和 `failed`。

## 2. 停机前构建与安全验证

```bash
VITE_BASE_PATH=/poker/ npm run build
npm test
bash -n scripts/shared-8080.sh
git diff --check
npm audit --omit=dev
```

测试、构建、shell 语法与 diff 必须全部通过；生产依赖审计不得有 high/critical。失败即停止，不触碰
旧 Drawing。

## 3. 已批准的 exact-PID 切换

切换前必须重新解析并立即复核 PID，不能沿用较早记录。复核后再运行一次空闲和健康门禁，并确认
baseline total 未变化：

```bash
mapfile -t immediate_pids < <(pgrep -f '^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main --host 0\.0\.0\.0 --port 8080 --workers 1$' || true)
test "${#immediate_pids[@]}" -eq 1
test "${immediate_pids[0]}" = "$drawing_pid"
test "$(readlink -f "/proc/${drawing_pid}/cwd")" = '/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961'
test "$(tr '\0' ' ' < "/proc/${drawing_pid}/cmdline")" = '/root/workspace/12.autoresearch/.venv/bin/python -m drawing_api_961.main --host 0.0.0.0 --port 8080 --workers 1 '
python3 scripts/check-drawing-idle.py /root/workspace/12.autoresearch/drawing_api_961/var/drawing_api.sqlite3
curl --noproxy '*' --fail http://127.0.0.1:8080/live >/dev/null
curl --noproxy '*' --fail http://127.0.0.1:8080/ready >/dev/null
immediate_total="$(curl --noproxy '*' --fail --silent \
  'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1' | \
  python3 -c 'import json, sys; value = json.load(sys.stdin)["total"]; assert isinstance(value, int) and not isinstance(value, bool) and value >= 0; print(value)')"
test "$immediate_total" = "$baseline_total"

kill -TERM "$drawing_pid"
pid_is_running() {
  kill -0 "$1" 2>/dev/null || return 1
  local process_stat process_tail
  process_stat="$(<"/proc/$1/stat")" || return 1
  process_tail="${process_stat#*) }"
  test "${process_tail%% *}" != Z
}
for _ in $(seq 1 300); do
  ! pid_is_running "$drawing_pid" && break
  sleep 0.1
done
! pid_is_running "$drawing_pid"
mapfile -t remaining_drawing_pids < <(pgrep -f '^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main ' || true)
test "${#remaining_drawing_pids[@]}" -eq 0

npm run shared -- start
```

如果旧进程未在期限内退出，不发送其他信号，也不启动共享服务；按现场状态人工处理。特别是 PID
identity 变化时不得对复用该 PID 的进程发送信号。

## 4. 共享入口验收

HTTP 与数据守恒：

```bash
curl --noproxy '*' --fail http://127.0.0.1:8080/live >/dev/null
curl --noproxy '*' --fail http://127.0.0.1:8080/ready >/dev/null
curl --noproxy '*' --fail 'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1' >/dev/null
curl --noproxy '*' --fail http://127.0.0.1:8080/poker/ >/dev/null
test "$(curl --noproxy '*' --fail --silent http://127.0.0.1:8080/poker/health)" = '{"ok":true}'
final_total="$(curl --noproxy '*' --fail --silent \
  'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1' | \
  python3 -c 'import json, sys; value = json.load(sys.stdin)["total"]; assert isinstance(value, int) and not isinstance(value, bool) and value >= 0; print(value)')"
test "$final_total" = "$baseline_total"
```

真实双客户端 Socket.IO smoke（只打印 `PASS`，不打印会话 token）：

```bash
node --input-type=module <<'JS'
import { io } from 'socket.io-client';

const clients = [];
const timeout = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 10_000)),
]);
const connect = async () => {
  const socket = io('http://127.0.0.1:8080', {
    path: '/poker/socket.io',
    transports: ['websocket'],
    forceNew: true,
  });
  clients.push(socket);
  await timeout(new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  }), 'connect');
  return socket;
};
const ack = (socket, event, payload) => timeout(new Promise((resolve, reject) => {
  socket.emit(event, payload, (response) => {
    if (response?.ok) resolve(response.data);
    else reject(new Error(`${event} rejected: ${response?.error?.code ?? 'unknown'}`));
  });
}), event);
const latest = new WeakMap();
const watch = (socket) => socket.on('table:snapshot', (view) => latest.set(socket, view));
const snapshot = (socket, predicate) => timeout(new Promise((resolve) => {
  const current = latest.get(socket);
  if (current && predicate(current)) return resolve(current);
  const listener = (view) => {
    if (!predicate(view)) return;
    socket.off('table:snapshot', listener);
    resolve(view);
  };
  socket.on('table:snapshot', listener);
}), 'table:snapshot');

try {
  const host = await connect();
  const guest = await connect();
  watch(host);
  watch(guest);
  const created = await ack(host, 'room:create', { nickname: 'smoke-host' });
  const joined = await ack(guest, 'room:join', {
    roomCode: created.roomCode,
    nickname: 'smoke-guest',
  });
  const plain = 'plain smoke message';
  const htmlLike = '<img src=x onerror=alert(1)> smoke';
  const plainResult = await ack(host, 'chat:send', { text: plain });
  const htmlResult = await ack(guest, 'chat:send', { text: htmlLike });
  if (plainResult.message.text !== plain || htmlResult.message.text !== htmlLike) {
    throw new Error('chat text mismatch');
  }
  await ack(host, 'game:start', {});
  const hostView = await snapshot(host, (view) => view.phase === 'playing');
  const actorSocket = hostView.actorId === created.playerId ? host
    : hostView.actorId === joined.playerId ? guest
      : undefined;
  if (!actorSocket) throw new Error('actor does not belong to either smoke client');
  const actorView = await snapshot(actorSocket, (view) =>
    view.phase === 'playing' && view.actorId !== undefined && view.legalActions !== undefined);
  const legal = actorView.legalActions;
  const action = legal.canCheck ? { type: 'check' }
    : legal.canCall ? { type: 'call' }
      : legal.canFold ? { type: 'fold' }
        : legal.canAllIn ? { type: 'all-in' }
          : legal.canBet ? { type: 'bet', amount: legal.minRaiseTo }
            : legal.canRaise ? { type: 'raise', amount: legal.minRaiseTo }
              : undefined;
  if (!action) throw new Error('no legal smoke action');
  await ack(actorSocket, 'game:act', action);
  console.log('Poker WebSocket two-client smoke=PASS');
} finally {
  for (const socket of clients) socket.disconnect();
}
JS
```

监听器必须精确符合：外部 `0.0.0.0:8080` 只有 gateway，loopback `127.0.0.1:18080`
只有 Drawing，loopback `127.0.0.1:3000` 只有 Poker。记录 `netstat` 输出并将 PID 与
`var/shared-8080/supervisor.pid` 及其子进程树交叉核对；任何额外或错误地址均失败：

```bash
npm run shared -- status
supervisor_pid="$(<var/shared-8080/supervisor.pid)"
ps -o pid=,ppid=,args= --forest -p "$supervisor_pid" --ppid "$supervisor_pid"
listeners="$(netstat -ltnp 2>/dev/null | awk 'NR > 2 && $4 ~ /:(8080|18080|3000)$/')"
printf '%s\n' "$listeners"
test "$(printf '%s\n' "$listeners" | sed '/^$/d' | wc -l)" -eq 3
gateway_pid="$(printf '%s\n' "$listeners" | awk '$4 == "0.0.0.0:8080" { split($7,a,"/"); print a[1] }')"
drawing_pid="$(printf '%s\n' "$listeners" | awk '$4 == "127.0.0.1:18080" { split($7,a,"/"); print a[1] }')"
poker_pid="$(printf '%s\n' "$listeners" | awk '$4 == "127.0.0.1:3000" { split($7,a,"/"); print a[1] }')"
test "$(readlink -f "/proc/${gateway_pid}/cwd")" = '/home/sxy/lan-texas-holdem/.worktrees/lan-poker'
test "$(readlink -f "/proc/${poker_pid}/cwd")" = '/home/sxy/lan-texas-holdem/.worktrees/lan-poker'
tr '\0' '\n' < "/proc/${gateway_pid}/cmdline" | grep -Fx 'src/gateway/index.ts'
tr '\0' '\n' < "/proc/${poker_pid}/cmdline" | grep -Fx 'src/server/index.ts'
```

## 5. 回滚

任何切换后断言失败，立即运行。`npm run shared -- stop` 只会向 PID 文件所指且验证属于 supervisor
的进程发信号；若停止失败，禁止启动旧 Drawing，以免两个进程同时访问本地 Qdrant。

```bash
cd /home/sxy/lan-texas-holdem/.worktrees/lan-poker
npm run shared -- stop
mapfile -t remaining_drawing_pids < <(pgrep -f '^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main ' || true)
test "${#remaining_drawing_pids[@]}" -eq 0

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

回滚健康后，再确认 drawings total 等于 `$baseline_total`。该启动命令继续使用原本的 dirty source
工作树和相同 data/Qdrant 路径。

## 6. 状态、停止与重启

```bash
cd /home/sxy/lan-texas-holdem/.worktrees/lan-poker
npm run shared -- status
npm run shared -- stop
npm run shared -- start
```

正常重启会清空 Poker 的内存房间；Drawing 数据仍在既有路径。不要手工停止 supervisor 子进程。
