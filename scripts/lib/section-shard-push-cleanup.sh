#!/usr/bin/env bash
# Cleanup scoped scratch state after a section-shard worker is interrupted.
# The deploy timeout signals the whole worker process group; this trap waits
# for its direct helper jobs before deleting their staging and verification
# paths, so bounded-parallel does not release the slot while they still run.

section_shard_push_cleanup_artifacts() {
  local runner_temp="${1:-}" section="${2:-}" loc="${3:-}"
  local path cleanup_failed=0

  case "$runner_temp" in
    ''|/)
      echo "::error::[section-push-cleanup] refusing unsafe RUNNER_TEMP '$runner_temp'" >&2
      return 2
      ;;
  esac
  if [ ! -d "$runner_temp" ] || [ -z "$section" ] || [ -z "$loc" ]; then
    echo "::error::[section-push-cleanup] missing scoped cleanup inputs" >&2
    return 2
  fi

  for path in \
    "$runner_temp/shard-$section-$loc" \
    "$runner_temp/${section}-src-$loc" \
    "$runner_temp/shard-push-verify-stage-$section-$loc" \
    "$runner_temp/shard-push-verify-plan-$section-$loc" \
    "$runner_temp/shard-delta-$section-$loc" \
    "$runner_temp/shard_${section}_${loc}_key" \
    "$runner_temp/shard-srcn-$section-$loc" \
    "$runner_temp/shard-ok-$section-$loc" \
    "$runner_temp/shard-fail-reason-$section-$loc" \
    "$runner_temp/shard-cdn-partial-$section-$loc" \
    "$runner_temp/shard-cdn-done-$section-$loc" \
    "$runner_temp/shard-cdn-done-$section-$loc.tmp" \
    "$runner_temp/shard-cdn-rewrite-$section-$loc.log" \
    "$runner_temp/section-shard-push-tmp-$section-$loc"; do
    if ! rm -rf -- "$path"; then
      echo "::error::[section-push-cleanup] failed to remove $path" >&2
      cleanup_failed=1
    fi
  done

  # SHARD_STAGE_RM_ASYNC renames this worker's stage before deleting it. If a
  # signal arrives during that window, remove the renamed directory as well.
  for path in "$runner_temp/shard-$section-$loc.rm."*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    if ! rm -rf -- "$path"; then
      echo "::error::[section-push-cleanup] failed to remove $path" >&2
      cleanup_failed=1
    fi
  done

  return "$cleanup_failed"
}

section_shard_push_timeout_trap() {
  local signal="${1:-TERM}" runner_temp="${2:-}" section="${3:-}" loc="${4:-}"
  local exit_code=143 cleanup_status=0 pids pid
  case "$signal" in
    INT) exit_code=130 ;;
    HUP) exit_code=129 ;;
  esac

  # Do not re-enter cleanup if another TERM arrives while a large stage is
  # being removed. `timeout --kill-after` remains the hard upper bound.
  trap '' TERM INT HUP
  echo "[section-push-cleanup] event=start signal=$signal locale=$loc section=$section"

  # timeout sends the signal to the worker process group. Reap its direct
  # background jobs (CDN rewrite / async stage removal) before deleting their
  # paths, and before the caller's bounded-parallel slot can be reused.
  pids="$(jobs -pr)"
  for pid in $pids; do
    wait "$pid" 2>/dev/null || true
  done

  section_shard_push_cleanup_artifacts "$runner_temp" "$section" "$loc" || cleanup_status=$?
  if [ "$cleanup_status" -eq 0 ]; then
    echo "[section-push-cleanup] event=complete locale=$loc section=$section children_reaped=true artifacts_removed=true"
  else
    echo "::error::[section-push-cleanup] event=failed locale=$loc section=$section exit_code=$cleanup_status"
  fi
  exit "$exit_code"
}
