#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_dir}/.." && pwd -P)"
default_entry="${repository_root}/src/gateway/supervisor.ts"
state_dir="${repository_root}/var/shared-8080"
supervisor_entry="${default_entry}"
gateway_ready_url="http://127.0.0.1:8080/ready"
poker_ready_url="http://127.0.0.1:8080/poker/health"
start_timeout_seconds=60
stop_timeout_seconds=40
runner=("${repository_root}/node_modules/.bin/tsx")

if [[ -n "${SHARED_SUPERVISOR_ENTRY:-}" && "${NODE_ENV:-}" != "test" ]]; then
  echo "生产环境拒绝 SHARED_SUPERVISOR_ENTRY 覆盖" >&2
  exit 2
fi

if [[ "${NODE_ENV:-}" == "test" ]]; then
  state_dir="${SHARED_STATE_DIR:-${state_dir}}"
  supervisor_entry="${SHARED_SUPERVISOR_ENTRY:-${supervisor_entry}}"
  gateway_ready_url="${SHARED_GATEWAY_READY_URL:-${gateway_ready_url}}"
  poker_ready_url="${SHARED_POKER_READY_URL:-${poker_ready_url}}"
  start_timeout_seconds="${SHARED_START_TIMEOUT_SECONDS:-${start_timeout_seconds}}"
  stop_timeout_seconds="${SHARED_STOP_TIMEOUT_SECONDS:-${stop_timeout_seconds}}"
  if [[ "${supervisor_entry}" != "${default_entry}" ]]; then
    runner=("$(command -v node)")
  fi
fi

pid_file="${state_dir}/supervisor.pid"
log_file="${state_dir}/shared.log"

usage() {
  echo "用法：npm run shared -- start|stop|status|run" >&2
  exit 2
}

read_supervisor_pid() {
  local value
  value="$(<"${pid_file}")"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "PID 文件格式无效：${pid_file}" >&2
    return 2
  fi
  printf '%s\n' "${value}"
}

pid_is_alive() {
  local pid="$1"
  kill -0 "${pid}" 2>/dev/null || return 1
  local process_stat process_state
  if [[ -r "/proc/${pid}/stat" ]]; then
    process_stat="$(<"/proc/${pid}/stat")"
    process_stat="${process_stat#*) }"
    process_state="${process_stat%% *}"
    [[ "${process_state}" != "Z" ]] || return 1
  fi
}

pid_is_owned() {
  local pid="$1"
  local argument
  [[ -r "/proc/${pid}/cmdline" ]] || return 1
  while IFS= read -r argument; do
    [[ "${argument}" == "${supervisor_entry}" ]] && return 0
  done < <(tr '\0' '\n' < "/proc/${pid}/cmdline")
  return 1
}

wait_until_gone() {
  local pid="$1"
  local deadline=$((SECONDS + stop_timeout_seconds))
  while pid_is_alive "${pid}"; do
    (( SECONDS >= deadline )) && return 1
    sleep 0.1
  done
}

stop_owned_pid() {
  local pid="$1"
  kill -TERM "${pid}"
  if ! wait_until_gone "${pid}"; then
    if pid_is_alive "${pid}" && pid_is_owned "${pid}"; then
      kill -KILL "${pid}"
      wait_until_gone "${pid}" || {
        echo "监督器 PID ${pid} 未能在期限内退出" >&2
        return 1
      }
    fi
  fi
}

wait_http() {
  local url="$1"
  local pid="$2"
  local deadline=$((SECONDS + start_timeout_seconds))
  while (( SECONDS < deadline )); do
    if ! pid_is_alive "${pid}"; then
      echo "监督器在服务就绪前退出，请检查 ${log_file}" >&2
      return 1
    fi
    if curl --silent --show-error --fail --noproxy '*' --max-time 1 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "等待 ${url} 就绪超时，请检查 ${log_file}" >&2
  return 1
}

wait_for_pid_publication() {
  local candidate_pid="$1"
  local deadline=$((SECONDS + start_timeout_seconds))
  while (( SECONDS < deadline )); do
    if [[ -f "${pid_file}" ]]; then
      local published_value published_pid
      published_value="$(<"${pid_file}")"
      if [[ "${published_value}" =~ ^[1-9][0-9]*$ ]]; then
        published_pid="${published_value}"
        if [[ "${published_pid}" == "${candidate_pid}" ]]; then
          return 0
        fi
        if pid_is_alive "${published_pid}"; then
          echo "另一共享 supervisor 已取得租约（PID ${published_pid}）" >&2
          return 2
        fi
      fi
    fi
    if ! pid_is_alive "${candidate_pid}"; then
      echo "本次 supervisor 未取得 PID 租约即退出，请检查 ${log_file}" >&2
      return 1
    fi
    sleep 0.05
  done
  echo "等待 supervisor 原子发布 PID 超时，请检查 ${log_file}" >&2
  return 1
}

start_services() {
  mkdir -p -- "${state_dir}"
  chmod 700 -- "${state_dir}"
  if [[ -f "${pid_file}" ]]; then
    local existing_value existing_pid
    existing_value="$(<"${pid_file}")"
    if [[ "${existing_value}" =~ ^[1-9][0-9]*$ ]] &&
       existing_pid="${existing_value}" && pid_is_alive "${existing_pid}"; then
      if pid_is_owned "${existing_pid}"; then
        echo "共享 8080 服务已在运行（PID ${existing_pid}）" >&2
      else
        echo "PID ${existing_pid} 不属于共享 supervisor，拒绝覆盖" >&2
      fi
      return 1
    fi
  fi

  umask 077
  nohup "${runner[@]}" "${supervisor_entry}" >>"${log_file}" 2>&1 &
  local supervisor_pid=$!

  if ! wait_for_pid_publication "${supervisor_pid}"; then
    return 1
  fi

  if ! wait_http "${gateway_ready_url}" "${supervisor_pid}" ||
     ! wait_http "${poker_ready_url}" "${supervisor_pid}"; then
    if [[ "$(<"${pid_file}")" == "${supervisor_pid}" ]] &&
       pid_is_alive "${supervisor_pid}" && pid_is_owned "${supervisor_pid}"; then
      stop_owned_pid "${supervisor_pid}" || true
    fi
    return 1
  fi
  echo "共享 8080 服务已启动（PID ${supervisor_pid}）"
}

stop_services() {
  if [[ ! -f "${pid_file}" ]]; then
    echo "共享 8080 服务未运行"
    return 0
  fi
  local supervisor_pid
  supervisor_pid="$(read_supervisor_pid)" || return $?
  if ! pid_is_alive "${supervisor_pid}"; then
    rm -f -- "${pid_file}"
    echo "共享 8080 服务未运行；已移除陈旧 PID 文件"
    return 0
  fi
  if ! pid_is_owned "${supervisor_pid}"; then
    echo "PID ${supervisor_pid} 不属于共享 supervisor，拒绝发送信号" >&2
    return 1
  fi
  stop_owned_pid "${supervisor_pid}"
  if [[ -f "${pid_file}" ]]; then
    local remaining_pid
    remaining_pid="$(read_supervisor_pid)" || return $?
    if [[ "${remaining_pid}" == "${supervisor_pid}" ]]; then
      echo "supervisor 未完成全部子进程清理；保留 PID 文件供诊断" >&2
      return 1
    fi
  fi
  echo "共享 8080 服务已停止"
}

status_services() {
  if [[ ! -f "${pid_file}" ]]; then
    echo "共享 8080 服务未运行"
    return 1
  fi
  local supervisor_pid
  supervisor_pid="$(read_supervisor_pid)" || return $?
  if ! pid_is_alive "${supervisor_pid}"; then
    echo "共享 8080 服务未运行（陈旧 PID ${supervisor_pid}）"
    return 1
  fi
  if ! pid_is_owned "${supervisor_pid}"; then
    echo "PID ${supervisor_pid} 不属于共享 supervisor" >&2
    return 2
  fi
  echo "共享 8080 服务运行中（PID ${supervisor_pid}）"
}

run_foreground() {
  mkdir -p -- "${state_dir}"
  exec "${runner[@]}" "${supervisor_entry}"
}

[[ $# -eq 1 ]] || usage
case "$1" in
  start) start_services ;;
  stop) stop_services ;;
  status) status_services ;;
  run) run_foreground ;;
  *) usage ;;
esac
