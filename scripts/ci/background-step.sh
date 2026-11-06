#!/usr/bin/env bash
# Run a CI command in the background across GitHub Actions steps, then join it.
#
#   scripts/ci/background-step.sh start <name> -- <command> [args...]
#   scripts/ci/background-step.sh wait  <name>
#
# Why. The deploy `prep` job runs ~10 strictly sequential steps on a 4-vCPU
# runner, and most of them are single-threaded node scripts. A step whose
# inputs no other step writes (e.g. the thumbnail encoder, which reads only the
# checked-out public/images tree) can overlap with them instead of adding its
# own wall time to the critical path: deploy 39917633944 spent 116 s on it.
#
# Contract that keeps this from hiding a failure:
#   - `wait` prints the command's full log and exits with the command's own
#     exit code, so the job fails exactly as the foreground step used to;
#   - `wait` on a name that was never started fails (no silent pass);
#   - the runner kills orphan processes only at job end, so a background
#     command survives the step that started it.
set -euo pipefail

mode="${1:-}"
name="${2:-}"
[ -n "$mode" ] && [ -n "$name" ] || { echo "usage: $0 start|wait <name> [-- <command>...]" >&2; exit 2; }
case "$name" in *[!A-Za-z0-9._-]*) echo "invalid name: $name" >&2; exit 2 ;; esac

dir="${BACKGROUND_STEP_DIR:-${RUNNER_TEMP:-/tmp}}/background-steps"
log="$dir/$name.log"
rc_file="$dir/$name.exit"
started="$dir/$name.started"

case "$mode" in
  start)
    shift 2
    [ "${1:-}" = "--" ] && shift
    [ $# -gt 0 ] || { echo "start needs a command after --" >&2; exit 2; }
    mkdir -p "$dir"
    rm -f "$log" "$rc_file" "$dir/$name.pid"
    date +%s > "$started"
    # The child records "<exit code> <finish epoch>" even when the command
    # fails. Its own stdio is detached from the step (</dev/null, >/dev/null):
    # a background process that kept the step's stdout open would make the
    # runner wait for it at the end of THIS step, which is exactly the
    # serialization this script exists to remove. setsid (when present) puts
    # it in its own session so the step's process-group teardown spares it.
    runner=()
    if command -v setsid >/dev/null 2>&1; then runner=(setsid); fi
    # `${a[@]+...}`: bash 3.2 (macOS) treats an empty array as unset under -u.
    ${runner[@]+"${runner[@]}"} bash -c '
      log="$1"; rc_file="$2"; pid_file="$3"; shift 3
      # The child records its OWN pid: `$!` may be a setsid that forked.
      echo "$$" > "$pid_file"
      "$@" > "$log" 2>&1
      rc=$?
      printf "%s %s\n" "$rc" "$(date +%s)" > "$rc_file.tmp" && mv "$rc_file.tmp" "$rc_file"
    ' background-step "$log" "$rc_file" "$dir/$name.pid" "$@" < /dev/null > /dev/null 2>&1 &
    echo "[background-step] started $name (pid $!): $*"
    ;;
  wait)
    [ -f "$started" ] || { echo "[background-step] $name was never started" >&2; exit 1; }
    # The child writes its pid first thing; give it a moment to appear.
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$dir/$name.pid" ] && break; sleep 1; done
    pid="$(cat "$dir/$name.pid" 2>/dev/null || true)"
    [ -n "$pid" ] || [ -f "$rc_file" ] || { echo "[background-step] $name never reported a pid" >&2; exit 1; }
    while [ ! -f "$rc_file" ]; do
      # A child that died without writing its exit code (killed, OOM) must
      # fail the join, never hang it.
      if ! kill -0 "$pid" 2>/dev/null && [ ! -f "$rc_file" ]; then
        echo "[background-step] $name (pid $pid) exited without an exit code" >&2
        cat "$log" 2>/dev/null || true
        exit 1
      fi
      sleep 1
    done
    read -r rc finished < "$rc_file"
    elapsed=$(( finished - $(cat "$started") ))
    echo "::group::[background-step] $name log"
    cat "$log"
    echo "::endgroup::"
    echo "[background-step] $name finished rc=$rc wall_s=$elapsed"
    exit "$rc"
    ;;
  *)
    echo "unknown mode: $mode" >&2; exit 2 ;;
esac
