#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=shared-8080-ops.sh
source "${script_dir}/shared-8080-ops.sh"

baseline_total=''
cutover_started=no

on_error() {
  local status=$?
  local line="$1"
  trap - ERR
  echo "cutover 门禁失败（line=${line}, status=${status}）" >&2
  if [[ "$cutover_started" == yes ]]; then
    if ! "${script_dir}/shared-8080-rollback.sh" "$baseline_total"; then
      echo '自动 rollback 失败；禁止继续启动任何 Drawing' >&2
      exit 90
    fi
  fi
  exit "$status"
}
trap 'on_error "$LINENO"' ERR

cd "$ops_repository_root"
if ops_shared status; then
  ops_fail 'shared supervisor 已运行；拒绝重复 cutover'
else
  status_rc=$?
  [[ "$status_rc" -eq 1 ]] || ops_fail 'shared supervisor status 检查失败'
fi

npm test
VITE_BASE_PATH=/poker/ npm run build
bash -n scripts/shared-8080.sh scripts/shared-8080-ops.sh \
  scripts/shared-8080-cutover.sh scripts/shared-8080-rollback.sh
git diff --check
npm audit --omit=dev

old_pids=()
ops_collect_pids old_pids "$ops_old_pattern"
[[ "${#old_pids[@]}" -eq 1 ]] || ops_fail 'Drawing PID 必须恰好一个'
old_pid="${old_pids[0]}"
ops_verify_pid_identity "$old_pid" "$ops_drawing_repo" "$ops_expected_old_cmdline" 'original Drawing'
if ! ops_run_idle_check; then
  ops_fail 'Drawing idle gate 失败'
fi
ops_assert_live 'http://127.0.0.1:8080/live' 'baseline Drawing'
ops_assert_ready 'http://127.0.0.1:8080/ready' 'baseline Drawing'
baseline_total="$(ops_drawing_total 'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1')"
if [[ "$ops_test_mode" == yes && -n "${SHARED_TEST_EXPECTED_TOTAL:-}" ]]; then
  [[ "$baseline_total" == "$SHARED_TEST_EXPECTED_TOTAL" ]] || ops_fail 'baseline Drawing total 不匹配'
fi

immediate_pids=()
ops_collect_pids immediate_pids "$ops_old_pattern"
[[ "${#immediate_pids[@]}" -eq 1 && "${immediate_pids[0]}" == "$old_pid" ]] ||
  ops_fail 'immediate Drawing PID 不匹配'
ops_verify_pid_identity "$old_pid" "$ops_drawing_repo" "$ops_expected_old_cmdline" 'immediate Drawing'
if ! ops_run_idle_check; then
  ops_fail 'immediate Drawing idle gate 失败'
fi
ops_assert_live 'http://127.0.0.1:8080/live' 'immediate Drawing'
ops_assert_ready 'http://127.0.0.1:8080/ready' 'immediate Drawing'
immediate_total="$(ops_drawing_total 'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1')"
[[ "$immediate_total" == "$baseline_total" ]] || ops_fail 'immediate Drawing total 已变化'

cutover_started=yes
ops_send_term "$old_pid"
for _ in $(seq 1 300); do
  ! ops_pid_is_running "$old_pid" && break
  sleep 0.1
done
! ops_pid_is_running "$old_pid" || ops_fail 'original Drawing 未在期限内退出'
remaining_old=()
premature_shared=()
remaining_any_drawing=()
ops_collect_pids remaining_old "$ops_old_pattern"
ops_collect_pids premature_shared "$ops_shared_pattern"
ops_collect_pids remaining_any_drawing "$ops_any_drawing_pattern"
[[ "${#remaining_old[@]}" -eq 0 && "${#premature_shared[@]}" -eq 0 && "${#remaining_any_drawing[@]}" -eq 0 ]] ||
  ops_fail 'original Drawing 退出后仍检测到 Drawing process'

ops_shared start
supervisor_pid="$(<"${ops_state_dir}/supervisor.pid")"
[[ "$supervisor_pid" =~ ^[1-9][0-9]*$ ]] || ops_fail 'supervisor PID 文件无效'
shared_drawing=()
ops_collect_pids shared_drawing "$ops_shared_pattern"
[[ "${#shared_drawing[@]}" -eq 1 ]] || ops_fail 'shared Drawing PID 必须恰好一个'
drawing_pid="${shared_drawing[0]}"
ops_verify_pid_identity "$drawing_pid" "$ops_drawing_repo" "$ops_expected_shared_cmdline" 'shared Drawing'

ops_assert_live 'http://127.0.0.1:8080/live' 'shared Drawing'
ops_assert_ready 'http://127.0.0.1:8080/ready' 'shared Drawing'
final_total="$(ops_drawing_total 'http://127.0.0.1:8080/api/v1/drawings?page=1&page_size=1')"
[[ "$final_total" == "$baseline_total" ]] || ops_fail 'shared Drawing total 不匹配'
curl --noproxy '*' --fail --silent http://127.0.0.1:8080/poker/ >/dev/null || ops_fail 'poker 页面检查失败'
[[ "$(curl --noproxy '*' --fail --silent http://127.0.0.1:8080/poker/health)" == '{"ok":true}' ]] ||
  ops_fail 'poker health 检查失败'
ops_run_socket_smoke
ops_assert_listeners "$supervisor_pid" "$drawing_pid"
ops_shared status
printf 'shared 8080 cutover 完成（baseline_total=%s, final_total=%s）\n' "$baseline_total" "$final_total"
trap - ERR
