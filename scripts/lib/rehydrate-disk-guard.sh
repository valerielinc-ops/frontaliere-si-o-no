#!/usr/bin/env bash
# Disk guard for the shard rehydrate (validate-dist out-of-space, runs
# 36595840668, 36670912411, 36687304462, 36810296662, 36830161110; the
# 5-hour timeouts 36566812671, 36656159822, 36706643053 are the same wall).
#
# The section rehydrate is the largest writer on the hosted runner: on the
# last green run (job 109312684750) it took the root filesystem from 45G to
# 134G of 145G (4.95M files), and its PEAK is that final tree plus the batch
# tars still waiting to be extracted. When the peak crosses the disk the
# casualty is not this script but the runner's own diagnostic log on the same
# filesystem ("System.IO.IOException: No space left on device"): the job dies
# with no step result, no gate row and no outputs, so integrity-verdict can
# only report `__UNKNOWN__:dist` — or the wedged runner sits until the
# 300-minute job timeout.
#
# The guard refuses a write it can size BEFORE starting it (a tar about to be
# extracted, a batch artifact or a shard clone about to be transferred) when
# the filesystem would drop below a reserve. The first refusal is recorded in
# a marker file; every worker stops at its next check, and the caller exits
# with a NAMED failure while the runner still has room for the `if: always()`
# steps. It never deletes site content, never changes what a validator reads,
# and never turns a failure into a pass.
#
# Fail-open on measurement only: if `df` cannot be read the guard returns 0 —
# it must not invent a failure on an unusual local filesystem; the crash it
# replaces is the pre-existing behaviour in that case.
#
# Sourced by scripts/lib/rehydrate-section-shards.sh; kept separate (like
# rehydrate-trunk-guard.sh) so tests can source it without the fan-out.

# Room the runner keeps for itself after a guarded write: its own logs, the
# `if: always()` gate-result steps, and the drift of up to three other bounded
# workers whose writes are already in flight when this one is sized.
REHYDRATE_DISK_RESERVE_MB="${REHYDRATE_DISK_RESERVE_MB:-4096}"
case "$REHYDRATE_DISK_RESERVE_MB" in
  ''|*[!0-9]*) REHYDRATE_DISK_RESERVE_MB=4096 ;;
esac

# Upper bound for a transfer whose size is only known after it lands (a batch
# artifact download, a shard git clone). Batch 5 / de was the largest on the
# last green run: ticino de alone extracted 534,652 files, ~10 GB of tars for
# the whole batch at ~18 KB per file. Recalibrate from the `[disk-guard]`
# lines if the corpus grows.
REHYDRATE_DISK_TRANSFER_MB="${REHYDRATE_DISK_TRANSFER_MB:-12288}"
case "$REHYDRATE_DISK_TRANSFER_MB" in
  ''|*[!0-9]*) REHYDRATE_DISK_TRANSFER_MB=12288 ;;
esac

REHYDRATE_DISK_GUARD_FILE="${REHYDRATE_DISK_GUARD_FILE:-${RUNNER_TEMP:-/tmp}/rehydrate-disk-exhausted}"

# Free KiB on the filesystem holding $1. `df -Pk` is the POSIX form (field 4),
# portable to macOS for scripts/ci/revalidate-dist-locally.sh.
rehydrate_disk_avail_kb() {
  df -Pk "${1:-.}" 2>/dev/null | awk 'NR==2 {print $4}'
}

# Allocated KiB of one file. `du -k`, not stat: GNU and BSD spell stat
# differently and this script also runs locally on macOS.
rehydrate_disk_file_kb() {
  du -k "$1" 2>/dev/null | awk '{print $1; exit}'
}

rehydrate_disk_guard_init() {
  rm -f "$REHYDRATE_DISK_GUARD_FILE" 2>/dev/null || true
}

rehydrate_disk_exhausted() {
  [ -f "$REHYDRATE_DISK_GUARD_FILE" ]
}

# rehydrate_disk_guard <what> <need_kb> <path>
# 0 when the filesystem holding <path> can take <need_kb> and still keep the
# reserve; otherwise records the refusal, emits ::error:: and returns 1.
rehydrate_disk_guard() {
  local what="$1" need_kb="${2:-0}" path="${3:-.}"
  local avail_kb reserve_kb mount
  case "$need_kb" in
    ''|*[!0-9]*) need_kb=0 ;;
  esac
  reserve_kb=$((REHYDRATE_DISK_RESERVE_MB * 1024))
  avail_kb="$(rehydrate_disk_avail_kb "$path")"
  case "$avail_kb" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$avail_kb" -ge $((need_kb + reserve_kb)) ]; then
    return 0
  fi
  mount="$(df -P "$path" 2>/dev/null | awk 'NR==2 {print $6}')"
  # First refusal wins (noclobber): concurrent workers can miss together, and
  # the marker must name the write that actually hit the wall first.
  ( set -C
    printf '%s need_mb=%s avail_mb=%s reserve_mb=%s mount=%s\n' \
      "$what" "$((need_kb / 1024))" "$((avail_kb / 1024))" \
      "$REHYDRATE_DISK_RESERVE_MB" "${mount:-?}" > "$REHYDRATE_DISK_GUARD_FILE"
  ) 2>/dev/null || true
  echo "::error::[disk-guard] $what needs ~$((need_kb / 1024)) MB plus a ${REHYDRATE_DISK_RESERVE_MB} MB reserve, but only $((avail_kb / 1024)) MB are free on ${mount:-?} — refused before the runner dies with ENOSPC"
  return 1
}
