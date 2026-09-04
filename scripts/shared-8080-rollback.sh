#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=shared-8080-ops.sh
source "${script_dir}/shared-8080-ops.sh"

[[ $# -eq 1 && "$1" =~ ^[0-9]+$ ]] || {
  echo '用法：scripts/shared-8080-rollback.sh EXPECTED_DRAWING_TOTAL' >&2
  exit 2
}
expected_total="$1"

if ! ops_shared stop; then
  ops_fail 'supervisor stop 失败；拒绝启动 original Drawing'
  exit 1
fi

remaining_drawing=()
ops_collect_pids remaining_drawing "$ops_any_drawing_pattern"
if [[ "${#remaining_drawing[@]}" -ne 0 ]]; then
  ops_fail 'remaining Drawing process 存在；拒绝启动 original Drawing'
  exit 1
fi

mkdir -p -- "$ops_state_dir"
if [[ "$ops_test_mode" == yes ]]; then
  "${SHARED_TEST_ORIGINAL_START_COMMAND}"
  rollback_pid="$(<"${ops_state_dir}/drawing-rollback.pid")"
else
  cd "$ops_drawing_repo"
  nohup env \
    DRAWING_API_HOST=0.0.0.0 \
    DRAWING_API_PORT=8080 \
    DRAWING_API_DATA_DIR=/root/workspace/12.autoresearch/drawing_api_961/var \
    DRAWING_API_QDRANT_LOCAL_PATH=/root/workspace/12.autoresearch/drawing_api_961/var/qdrant \
    ./scripts/start_local_961.sh > "$ops_rollback_log" 2>&1 &
  rollback_pid=$!
  printf '%s\n' "$rollback_pid" > "${ops_state_dir}/drawing-rollback.pid"
fi

for _ in $(seq 1 300); do
  if ops_assert_live 'http://127.0.0.1:8080/live' 'rollback Drawing' 2>/dev/null; then
    break
  fi
  sleep 0.1
done
ops_assert_live 'http://127.0.0.1:8080/live' 'rollback Drawing'
ops_assert_ready 'http://127.0.0.1:8080/ready' 'rollback Drawing'

restored=()
ops_collect_pids restored "$ops_old_pattern"
[[ "${#restored[@]}" -eq 1 ]] || ops_fail 'rollback Drawing PID 不是恰好一个'
[[ "${restored[0]}" == "$rollback_pid" ]] || ops_fail 'rollback Drawing PID 与启动 PID 不匹配'
ops_verify_pid_identity "$rollback_pid" "$ops_drawing_repo" "$ops_expected_old_cmdline" 'rollback Drawing'
restored_total="$(ops_drawing_total 'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1')"
[[ "$restored_total" == "$expected_total" ]] || ops_fail 'rollback Drawing total 不匹配'
printf 'rollback Drawing 已恢复（PID %s，total=%s）\n' "$rollback_pid" "$restored_total"
