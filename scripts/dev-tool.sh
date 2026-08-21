#!/usr/bin/env bash
# One-command dev services for the DeepSeek Harness repo.
#
#   dev-tool.sh start [service...]   start services (default: web + docs; mock
#                                    auto-starts when DEEPSEEK_API_KEY is unset)
#   dev-tool.sh stop  [service...]   stop services (default: all running)
#   dev-tool.sh restart [service...] stop, then start
#   dev-tool.sh status               per-service state, ports, and log paths
#   dev-tool.sh logs [service...]    tail -f service logs (default: all)
#
# Services: web (dsh web, http://127.0.0.1:3080), mock (mock LLM,
# http://127.0.0.1:8000/v1), docs (VitePress, http://127.0.0.1:5173).
#
# Logs live in logs/<service>.log (previous run rotated to .1), PIDs in
# logs/.pids/<service>.pid. The harness's own session logs (what the model
# sees) land in $DSH_HOME/sessions (default ~/.dsh/sessions) independently.
# The web service reads DEEPSEEK_API_KEY from the shell env or repo .env
# (gitignored; set it there, never hardcode keys in this script) — with a
# key it calls the real API, without it the mock LLM is used instead.
# First start runs pnpm install / pnpm run build automatically when the
# checkout lacks dependencies or built web artifacts (progress in setup.log).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
PID_DIR="$LOG_DIR/.pids"
SESSION_DIR="${DSH_HOME:-$HOME/.dsh}/sessions"
MOCK_BASE_URL="http://127.0.0.1:8000/v1"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

is_service() {
  case "$1" in web|mock|docs) return 0 ;; *) return 1 ;; esac
}

service_cmd() {
  case "$1" in
    web)  echo "node --import tsx apps/cli/src/bin.ts web" ;;
    mock) echo "node --import tsx packages/test-support/llm-mock-server/src/bin.ts --sequence success --repeat-last" ;;
    docs) echo "node node_modules/vitepress/bin/vitepress.js dev . --host 127.0.0.1 --port 5173" ;;
  esac
}

service_workdir() {
  case "$1" in docs) echo website ;; *) echo . ;; esac
}

service_port() {
  case "$1" in web) echo 3080 ;; mock) echo 8000 ;; docs) echo 5173 ;; esac
}

service_url() {
  case "$1" in
    web)  echo "http://127.0.0.1:3080" ;;
    mock) echo "$MOCK_BASE_URL" ;;
    docs) echo "http://127.0.0.1:5173" ;;
  esac
}

service_wait_tries() {
  case "$1" in web) echo 120 ;; docs) echo 60 ;; *) echo 40 ;; esac
}

# PID listening on a TCP port, or empty. lsof exits 1 when nothing listens;
# the `|| true` keeps the pipeline exit 0 under pipefail.
port_pid() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

service_pid() {
  cat "$PID_DIR/$1.pid" 2>/dev/null || true
}

service_running() {
  local pid
  pid=$(service_pid "$1")
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Recursively signal a process and its descendants (pnpm-style wrappers and
# vitepress spawn children), so no orphan survives a stop.
kill_tree() {
  local pid="$1" sig="${2:-TERM}"
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for c in $children; do kill_tree "$c" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null || true
}

stop_service() {
  local pidfile="$PID_DIR/$1.pid" pid
  if [[ ! -f "$pidfile" ]]; then
    echo "  $1: not running"
    return 0
  fi
  pid=$(service_pid "$1")
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid" TERM
    for _ in $(seq 1 16); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid" KILL
      echo "  $1: killed after TERM timeout (pid $pid)"
    else
      echo "  $1: stopped (pid $pid)"
    fi
  else
    echo "  $1: stale pidfile removed"
  fi
  rm -f "$pidfile"
}

rotate_log() {
  local f="$LOG_DIR/$1.log"
  if [[ -f "$f" ]]; then rm -f "$f.1"; mv "$f" "$f.1"; fi
}

launch() {
  local s="$1" extra="$2"
  shift 2
  ( cd "$ROOT/$(service_workdir "$s")"
    if [[ -n "$extra" ]]; then
      nohup env $extra "$@" </dev/null >>"$LOG_DIR/$s.log" 2>&1 &
    else
      nohup "$@" </dev/null >>"$LOG_DIR/$s.log" 2>&1 &
    fi
    echo $! >"$PID_DIR/$s.pid"
  )
}

wait_port() {
  local s="$1" port="$2" tries="$3" pid
  for _ in $(seq 1 "$tries"); do
    pid=$(service_pid "$s")
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      echo "  $s: exited during startup — last log lines:" >&2
      tail -n 15 "$LOG_DIR/$s.log" >&2 || true
      return 1
    fi
    if [[ -n "$(port_pid "$port")" ]]; then return 0; fi
    sleep 0.5
  done
  echo "  $s: port $port still not listening after $((tries / 2))s — see logs/$s.log" >&2
  return 1
}

ensure_tsx() {
  [[ -x "$ROOT/node_modules/.bin/tsx" ]] && return 0
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "  pnpm not found — install pnpm@^11 (e.g. npm i -g pnpm@11.7.0) first" >&2
    exit 1
  fi
  echo "  one-time setup: pnpm install (progress in logs/setup.log)"
  ( cd "$ROOT" && pnpm install >>"$LOG_DIR/setup.log" 2>&1 ) \
    || { echo "  pnpm install failed — tail logs/setup.log" >&2; exit 1; }
}

ensure_web_build() {
  [[ -f "$ROOT/apps/web/dist/index.html" ]] && return 0
  echo "  one-time setup: pnpm run build (progress in logs/setup.log)"
  ( cd "$ROOT" && pnpm run build >>"$LOG_DIR/setup.log" 2>&1 ) \
    || { echo "  build failed — tail logs/setup.log" >&2; exit 1; }
}

start_service() {
  local s="$1" port busy extra tries
  if service_running "$s"; then
    echo "  $s: already running (pid $(service_pid "$s"))"
    return 0
  fi
  port=$(service_port "$s")
  busy=$(port_pid "$port")
  if [[ -n "$busy" ]]; then
    echo "  $s: port $port already in use by pid $busy — stop it first or the pidfile is stale" >&2
    return 1
  fi
  rotate_log "$s"
  extra=""
  if [[ "$s" == web && -z "${DEEPSEEK_API_KEY:-}" ]]; then
    start_service mock || return 1
    extra="DEEPSEEK_API_KEY=dsh-dev-mock DEEPSEEK_BASE_URL=$MOCK_BASE_URL"
    echo "  web: DEEPSEEK_API_KEY unset — using mock LLM at $MOCK_BASE_URL"
  elif [[ "$s" == web ]]; then
    echo "  web: using DEEPSEEK_API_KEY from env/.env${DEEPSEEK_BASE_URL:+ (base $DEEPSEEK_BASE_URL)}"
    if service_running mock; then
      echo "  web: mock is still running but no longer needed — stop it with: dev-tool.sh stop mock"
    fi
  fi
  launch "$s" "$extra" $(service_cmd "$s")
  tries=$(service_wait_tries "$s")
  if wait_port "$s" "$port" "$tries"; then
    echo "  $s: up at $(service_url "$s") (pid $(service_pid "$s"), log logs/$s.log)"
  else
    return 1
  fi
}

# Export DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL from the repo .env (gitignored)
# when the shell env does not already carry them. Values are read raw, so keep
# them unquoted in .env.
load_env_keys() {
  local env_file="$ROOT/.env" line
  [[ -f "$env_file" ]] || return 0
  # grep exits 1 on no match; `|| true` keeps the pipeline 0 under pipefail.
  if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    line=$(grep -E '^DEEPSEEK_API_KEY=' "$env_file" | head -1 || true)
    if [[ -n "$line" ]]; then export "DEEPSEEK_API_KEY=${line#DEEPSEEK_API_KEY=}"; fi
  fi
  if [[ -z "${DEEPSEEK_BASE_URL:-}" ]]; then
    line=$(grep -E '^DEEPSEEK_BASE_URL=' "$env_file" | head -1 || true)
    if [[ -n "$line" ]]; then export "DEEPSEEK_BASE_URL=${line#DEEPSEEK_BASE_URL=}"; fi
  fi
}

do_start() {
  local svcs=() s failed=0
  if (( $# == 0 )); then
    svcs=(web docs)
    [[ -z "${DEEPSEEK_API_KEY:-}" ]] && svcs+=(mock)
  else
    for s in "$@"; do
      is_service "$s" || { echo "unknown service: $s" >&2; usage; exit 2; }
    done
    svcs=("$@")
  fi
  mkdir -p "$PID_DIR"
  ensure_tsx
  load_env_keys
  for s in "${svcs[@]}"; do
    [[ "$s" == web ]] && ensure_web_build
    start_service "$s" || failed=1
  done
  echo "session logs (model-visible activity): $SESSION_DIR"
  if (( failed )); then exit 1; fi
}

do_stop() {
  local svcs=() s
  if (( $# == 0 )); then
    for f in "$PID_DIR"/*.pid; do
      [[ -f "$f" ]] && svcs+=("$(basename "$f" .pid)")
    done
  else
    for s in "$@"; do
      is_service "$s" || { echo "unknown service: $s" >&2; exit 2; }
    done
    svcs=("$@")
  fi
  for s in "${svcs[@]}"; do stop_service "$s"; done
}

do_status() {
  local s pid port
  echo "services:"
  for s in web mock docs; do
    if service_running "$s"; then
      pid=$(service_pid "$s")
      port=$(port_pid "$(service_port "$s")")
      echo "  $s: RUNNING  pid=$pid  port_pid=${port:-?}  $(service_url "$s")"
    else
      echo "  $s: stopped  ($(service_url "$s"))"
    fi
  done
  echo "service logs:  $LOG_DIR/<service>.log (tail with: dev-tool.sh logs)"
  echo "session logs:  $SESSION_DIR"
}

do_logs() {
  local files=() s
  if (( $# == 0 )); then
    files=(web.log mock.log docs.log)
  else
    for s in "$@"; do
      is_service "$s" || { echo "unknown service: $s" >&2; exit 2; }
      files+=("$s.log")
    done
  fi
  exec tail -f "${files[@]/#/$LOG_DIR/}"
}

main() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)   do_start "$@" ;;
    stop)    do_stop "$@" ;;
    restart) do_stop "$@"; do_start "$@" ;;
    status)  do_status ;;
    logs)    do_logs "$@" ;;
    help|-h|--help) usage ;;
    *) echo "unknown command: $cmd" >&2; usage; exit 2 ;;
  esac
}

main "$@"
