#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'shared-8080-ops.sh 只能由受控运维脚本加载' >&2
  exit 2
fi

ops_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ops_repository_root="$(cd -- "${ops_script_dir}/.." && pwd -P)"
ops_proc_root='/proc'
ops_state_dir="${ops_repository_root}/var/shared-8080"
ops_drawing_repo='/home/sxy/.worktrees/drawing-api-annotator-proxy/drawing_api_961'
ops_database='/root/workspace/12.autoresearch/drawing_api_961/var/drawing_api.sqlite3'
ops_rollback_log="${ops_state_dir}/drawing-rollback.log"
ops_node_executable="$(command -v node)"
ops_tsx_preflight="${ops_repository_root}/node_modules/tsx/dist/preflight.cjs"
ops_tsx_loader="${ops_repository_root}/node_modules/tsx/dist/loader.mjs"
ops_tsx_loader_url="file://${ops_tsx_loader}"
ops_supervisor_entry="${ops_repository_root}/src/gateway/supervisor.ts"
ops_old_pattern='^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main --host 0\.0\.0\.0 --port 8080 --workers 1$'
ops_shared_pattern='^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main --host 127\.0\.0\.1 --port 18080 --workers 1$'
ops_any_drawing_pattern='^/root/workspace/12.autoresearch/\.venv/bin/python -m drawing_api_961\.main '
ops_expected_old_cmdline='/root/workspace/12.autoresearch/.venv/bin/python -m drawing_api_961.main --host 0.0.0.0 --port 8080 --workers 1 '
ops_expected_shared_cmdline='/root/workspace/12.autoresearch/.venv/bin/python -m drawing_api_961.main --host 127.0.0.1 --port 18080 --workers 1 '
ops_test_mode=no

if [[ "${NODE_ENV:-}" == test ]]; then
  ops_test_mode=yes
  : "${SHARED_TEST_ROOT:?}"
  : "${SHARED_TEST_PROC_ROOT:?}"
  : "${SHARED_TEST_STATE_DIR:?}"
  : "${SHARED_TEST_DRAWING_REPO:?}"
  : "${SHARED_TEST_DATABASE:?}"
  : "${SHARED_TEST_SIGNAL_COMMAND:?}"
  : "${SHARED_TEST_IDLE_COMMAND:?}"
  : "${SHARED_TEST_ORIGINAL_START_COMMAND:?}"
  : "${SHARED_TEST_SOCKET_SMOKE_COMMAND:?}"
  ops_proc_root="${SHARED_TEST_PROC_ROOT}"
  ops_state_dir="${SHARED_TEST_STATE_DIR}"
  ops_drawing_repo="${SHARED_TEST_DRAWING_REPO}"
  ops_database="${SHARED_TEST_DATABASE}"
  ops_rollback_log="${SHARED_TEST_ROLLBACK_LOG:-${ops_state_dir}/drawing-rollback.log}"
  ops_old_pattern="${SHARED_TEST_OLD_PATTERN:-${ops_old_pattern}}"
  ops_shared_pattern="${SHARED_TEST_SHARED_PATTERN:-${ops_shared_pattern}}"
  ops_any_drawing_pattern="${SHARED_TEST_ANY_DRAWING_PATTERN:-${ops_any_drawing_pattern}}"
  ops_expected_old_cmdline="${SHARED_TEST_EXPECTED_OLD_CMDLINE:-${ops_expected_old_cmdline}}"
  ops_expected_shared_cmdline="${SHARED_TEST_EXPECTED_SHARED_CMDLINE:-${ops_expected_shared_cmdline}}"
else
  while IFS= read -r variable_name; do
    if [[ "$variable_name" == SHARED_TEST_* ]]; then
      echo '生产运行拒绝 SHARED_TEST_* 覆盖' >&2
      return 2
    fi
  done < <(compgen -e)
fi

ops_fail() {
  echo "$*" >&2
  return 1
}

ops_collect_pids() {
  local target_name="$1"
  local pattern="$2"
  local output rc
  if output="$(pgrep -f "$pattern")"; then
    rc=0
  else
    rc=$?
    if [[ "$rc" -eq 1 ]]; then
      output=''
    else
      echo "pgrep 执行失败（rc=${rc}）" >&2
      return "$rc"
    fi
  fi

  local -n target="$target_name"
  target=()
  if [[ -n "$output" ]]; then
    mapfile -t target <<< "$output"
  fi
  local pid
  for pid in "${target[@]}"; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || ops_fail 'pgrep 返回了无效 PID'
  done
}

ops_pid_is_running() {
  local pid="$1"
  [[ -r "${ops_proc_root}/${pid}/stat" ]] || return 1
  local process_stat process_tail
  process_stat="$(<"${ops_proc_root}/${pid}/stat")"
  process_tail="${process_stat#*) }"
  [[ "${process_tail%% *}" != Z ]]
}

ops_cmdline() {
  tr '\0' ' ' < "${ops_proc_root}/$1/cmdline"
}

ops_verify_pid_identity() {
  local pid="$1"
  local expected_cwd="$2"
  local expected_cmdline="$3"
  local label="$4"
  [[ "$(readlink -f "${ops_proc_root}/${pid}/cwd")" == "$expected_cwd" ]] ||
    ops_fail "${label} cwd 不匹配"
  [[ "$(ops_cmdline "$pid")" == "$expected_cmdline" ]] ||
    ops_fail "${label} cmdline 不匹配"
}

ops_curl() {
  curl --noproxy '*' --fail --silent --max-time 5 "$@"
}

ops_assert_live() {
  local url="$1"
  local label="$2"
  ops_curl "$url" >/dev/null || ops_fail "${label} live 检查失败"
}

ops_assert_ready() {
  local url="$1"
  local label="$2"
  local body
  if ! body="$(ops_curl "$url")"; then
    ops_fail "${label} ready HTTP 检查失败"
    return
  fi
  if ! python3 -c '
import json, sys
value = json.load(sys.stdin)
components = value.get("components")
valid = (
    value.get("status") == "ready"
    and isinstance(components, dict)
    and bool(components)
    and all(
        isinstance(component, dict)
        and (not component.get("required") or component.get("ready") is True)
        for component in components.values()
    )
)
if not valid:
    sys.exit(1)
' <<< "$body"; then
    ops_fail "${label} ready JSON 检查失败"
  fi
}

ops_drawing_total() {
  local url="$1"
  local body
  if ! body="$(ops_curl "$url")"; then
    ops_fail 'Drawing total HTTP 检查失败'
    return
  fi
  python3 -c '
import json, sys
value = json.load(sys.stdin)["total"]
if not (isinstance(value, int) and not isinstance(value, bool) and value >= 0):
    sys.exit(1)
print(value)
' <<< "$body" || ops_fail 'Drawing total JSON 检查失败'
}

ops_run_idle_check() {
  if [[ "$ops_test_mode" == yes ]]; then
    "${SHARED_TEST_IDLE_COMMAND}" "$ops_database"
  else
    python3 "${ops_repository_root}/scripts/check-drawing-idle.py" "$ops_database"
  fi
}

ops_send_term() {
  local pid="$1"
  if [[ "$ops_test_mode" == yes ]]; then
    "${SHARED_TEST_SIGNAL_COMMAND}" -TERM "$pid"
  else
    kill -TERM "$pid"
  fi
}

ops_shared() {
  npm run shared -- "$1"
}

ops_run_socket_smoke() {
  if [[ "$ops_test_mode" == yes ]]; then
    "${SHARED_TEST_SOCKET_SMOKE_COMMAND}"
  else
    node "${ops_repository_root}/scripts/shared-8080-socket-smoke.mjs"
  fi
}

ops_parent_pid() {
  awk '/^PPid:/{print $2}' "${ops_proc_root}/$1/status"
}

ops_direct_child_for() {
  local supervisor_pid="$1"
  local descendant_pid="$2"
  local child="$descendant_pid"
  local current="$descendant_pid"
  local parent
  for _ in $(seq 1 32); do
    parent="$(ops_parent_pid "$current")" || return 1
    if [[ "$parent" == "$supervisor_pid" ]]; then
      printf '%s\n' "$child"
      return 0
    fi
    [[ "$parent" =~ ^[1-9][0-9]*$ ]] || return 1
    child="$parent"
    current="$parent"
  done
  return 1
}

ops_assert_exact_argv() {
  local pid="$1"
  shift
  local actual=()
  mapfile -d '' -t actual < "${ops_proc_root}/${pid}/cmdline"
  [[ "${#actual[@]}" -eq "$#" ]] || return 1
  local index=0 expected
  for expected in "$@"; do
    [[ "${actual[index]}" == "$expected" ]] || return 1
    ((index += 1))
  done
}

ops_assert_listeners() {
  local supervisor_pid="$1"
  local expected_drawing_pid="$2"
  local listeners
  listeners="$(netstat -ltnp 2>/dev/null | awk '$4 ~ /:(8080|18080|3000)$/')"
  [[ "$(printf '%s\n' "$listeners" | sed '/^$/d' | wc -l)" -eq 3 ]] ||
    ops_fail 'listener 集合不是恰好三个端口'

  local gateway_line drawing_line poker_line
  gateway_line="$(printf '%s\n' "$listeners" | awk '$4 == "0.0.0.0:8080"')"
  drawing_line="$(printf '%s\n' "$listeners" | awk '$4 == "127.0.0.1:18080"')"
  poker_line="$(printf '%s\n' "$listeners" | awk '$4 == "127.0.0.1:3000"')"
  [[ "$(printf '%s\n' "$gateway_line" | sed '/^$/d' | wc -l)" -eq 1 ]] || ops_fail '8080 listener 不唯一'
  [[ "$(printf '%s\n' "$drawing_line" | sed '/^$/d' | wc -l)" -eq 1 ]] || ops_fail '18080 listener 不唯一'
  [[ "$(printf '%s\n' "$poker_line" | sed '/^$/d' | wc -l)" -eq 1 ]] || ops_fail '3000 listener 不唯一'

  local gateway_pid drawing_pid poker_pid
  gateway_pid="$(awk '{ split($7,a,"/"); print a[1] }' <<< "$gateway_line")"
  drawing_pid="$(awk '{ split($7,a,"/"); print a[1] }' <<< "$drawing_line")"
  poker_pid="$(awk '{ split($7,a,"/"); print a[1] }' <<< "$poker_line")"
  [[ "$gateway_pid" =~ ^[1-9][0-9]*$ ]] || ops_fail 'gateway listener PID 为空或无效'
  [[ "$drawing_pid" =~ ^[1-9][0-9]*$ ]] || ops_fail 'Drawing 18080 listener PID 为空或无效'
  [[ "$poker_pid" =~ ^[1-9][0-9]*$ ]] || ops_fail 'poker listener PID 为空或无效'
  [[ "$gateway_pid" != "$drawing_pid" && "$gateway_pid" != "$poker_pid" && "$drawing_pid" != "$poker_pid" ]] ||
    ops_fail 'listener PID 必须互不相同'
  [[ "$drawing_pid" == "$expected_drawing_pid" ]] || ops_fail 'Drawing 18080 listener 归属不匹配'

  ops_verify_pid_identity "$drawing_pid" "$ops_drawing_repo" "$ops_expected_shared_cmdline" 'Drawing 18080 listener'
  [[ "$(readlink -f "${ops_proc_root}/${gateway_pid}/cwd")" == "$ops_repository_root" ]] || ops_fail 'gateway cwd 不匹配'
  [[ "$(readlink -f "${ops_proc_root}/${poker_pid}/cwd")" == "$ops_repository_root" ]] || ops_fail 'poker cwd 不匹配'
  ops_assert_exact_argv "$gateway_pid" "$ops_node_executable" --require "$ops_tsx_preflight" --import "$ops_tsx_loader_url" 'src/gateway/index.ts' ||
    ops_fail 'gateway exact argv 不匹配'
  ops_assert_exact_argv "$poker_pid" "$ops_node_executable" --require "$ops_tsx_preflight" --import "$ops_tsx_loader_url" 'src/server/index.ts' ||
    ops_fail 'poker exact argv 不匹配'
  [[ "$(readlink -f "${ops_proc_root}/${supervisor_pid}/cwd")" == "$ops_repository_root" ]] || ops_fail 'supervisor cwd 不匹配'
  ops_assert_exact_argv "$supervisor_pid" "$ops_node_executable" --import "$ops_tsx_loader" "$ops_supervisor_entry" ||
    ops_fail 'supervisor exact argv 不匹配'

  local drawing_child poker_child gateway_child
  drawing_child="$(ops_direct_child_for "$supervisor_pid" "$drawing_pid")" || ops_fail 'Drawing 不属于 supervisor'
  poker_child="$(ops_direct_child_for "$supervisor_pid" "$poker_pid")" || ops_fail 'poker 不属于 supervisor'
  gateway_child="$(ops_direct_child_for "$supervisor_pid" "$gateway_pid")" || ops_fail 'gateway 不属于 supervisor'
  [[ "$drawing_child" != "$poker_child" && "$drawing_child" != "$gateway_child" && "$poker_child" != "$gateway_child" ]] ||
    ops_fail 'supervisor child 归属不唯一'

  local children_file="${ops_proc_root}/${supervisor_pid}/task/${supervisor_pid}/children"
  [[ -r "$children_file" ]] || ops_fail '无法读取 supervisor child 集合'
  local actual_children expected_children
  actual_children="$(tr ' ' '\n' < "$children_file" | sed '/^$/d' | sort -n | paste -sd ' ' -)"
  expected_children="$(printf '%s\n' "$drawing_child" "$poker_child" "$gateway_child" | sort -n | paste -sd ' ' -)"
  [[ "$actual_children" == "$expected_children" ]] || ops_fail 'supervisor child 集合不匹配'

  printf 'supervisor_pid=%s\ndrawing_pid=%s\npoker_pid=%s\ngateway_pid=%s\n' \
    "$supervisor_pid" "$drawing_pid" "$poker_pid" "$gateway_pid"
}
