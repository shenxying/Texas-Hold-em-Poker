# 共享 8080 网关运维手册

共享网关保留 Drawing API 的全部原路径，并只把德州扑克挂在 `/poker/`。当前环境把外部
`http://10.191.46.7:8091` 映射到容器 `8080`；该映射是环境特定的，本机检查始终使用
`http://127.0.0.1:8080`。

## 安全边界

- 不修改 Drawing 源工作树、数据、Qdrant、模型或密钥。
- 同一时刻只能有一个 Drawing 进程访问
  `/root/workspace/12.autoresearch/drawing_api_961/var/qdrant`。
- 只停止 supervisor 自己验证归属的 PID，或 cutover 脚本刚刚完整验证的唯一 original Drawing
  PID。禁止 `pkill`、`killall`、按端口杀进程或手工停止 supervisor 子进程。
- PID、cwd、完整 cmdline、idle、health、ready JSON、total、listener 或 parentage 的任一门禁失败，
  脚本都会 fail closed。不要把脚本内容拆成逐行命令执行。
- cutover 发出 TERM 后的任一失败都会自动调用 rollback。rollback 只有在 supervisor stop 成功且
  确认没有任何 Drawing 进程后，才会启动 original Drawing。

## 首次 cutover

只能在已批准维护窗口运行。不要先手工停止 Drawing；安全脚本必须亲自读取并立即复核 exact PID。

```bash
cd /home/sxy/lan-texas-holdem/.worktrees/lan-poker
scripts/shared-8080-cutover.sh
```

`shared-8080-cutover.sh` 默认启用 `set -Eeuo pipefail`，按顺序完成：

1. 确认 shared supervisor 尚未运行。
2. 在停机前运行全量测试、`VITE_BASE_PATH=/poker/` 构建、所有运维脚本语法检查、diff check 和
   production audit。
3. 只读检查唯一 original Drawing PID、cwd、完整 cmdline、`/live`、严格 `/ready` JSON、数据库 idle
   计数和 drawings total。
4. 在发信号前再次执行相同 identity、idle、health、ready 和 total 门禁。
5. 只向该 exact PID 发 TERM；确认它已经退出且没有任何 Drawing 后才启动 shared supervisor。
6. 验证 Drawing、Poker、真实双客户端 Socket.IO，以及三个 listener 的唯一 PID、cwd、exact argv、
   supervisor ancestry 和完整 direct-child 集合。

PID 查询 helper 明确区分 `pgrep` 退出码：`0` 表示匹配，`1` 表示空集合，任何大于 `1` 的执行错误
都会立即失败，绝不当成“没有进程”。

### 严格 readiness 语义

baseline、immediate、shared 和 rollback 全部复用同一个严格 helper。除 HTTP 必须成功外，JSON 的
顶层 `status` 必须为 `ready`，`components` 必须是非空对象，且每个 `required: true` 的 component
都必须 `ready: true`。HTTP 200 但 JSON 未 ready 仍是失败。

### 成功输出与 URL

成功时脚本输出 supervisor、Drawing、Poker、gateway PID 及 baseline/final total。外部入口为：

- Drawing：`http://10.191.46.7:8091`（原路径不变）
- Poker：`http://10.191.46.7:8091/poker/`

## 显式 rollback

cutover 自带自动 rollback。只有在运维人员需要显式恢复 original Drawing 时才直接调用 rollback
脚本，并传入 cutover 已记录的 baseline total。例如 baseline 为 `962`：

```bash
cd /home/sxy/lan-texas-holdem/.worktrees/lan-poker
scripts/shared-8080-rollback.sh 962
```

不要猜测或省略 expected total。脚本默认 `set -Eeuo pipefail`，严格执行：

1. `npm run shared -- stop` 必须成功；ownership mismatch 或停止失败会立即终止。
2. 使用保留真实退出码的 PID helper 确认没有任何 Drawing 进程。存在剩余进程或 `pgrep` 执行错误
   都会终止，且不会启动 original Drawing。
3. 从原 dirty source 工作树，以相同 data/Qdrant 路径启动 original Drawing：
   `0.0.0.0:8080`、`/root/workspace/12.autoresearch/drawing_api_961/var` 和其 `qdrant` 子目录。
4. 核对启动 PID、cwd、完整 cmdline、`/live`、严格 `/ready` JSON 和 drawings total。

rollback 日志与 PID 文件位于 `var/shared-8080/`，该目录不会进入 Git。

## 已完成首次 cutover 后的日常管理

以下命令只适用于首次安全 cutover 已经完成、当前已由 shared supervisor 管理的环境。它们不是首次
迁移步骤，也不能替代上面的 cutover/rollback 脚本。

```bash
cd /home/sxy/lan-texas-holdem/.worktrees/lan-poker
npm run shared -- status
npm run shared -- stop
npm run shared -- start
```

正常 stop/start 会清空 Poker 的内存房间；Drawing 数据仍使用既有路径。运行 `start` 前必须确认上次
`stop` 已成功，不得绕过 supervisor ownership 检查。
