#!/usr/bin/env bash
set -euo pipefail

LEDGER_BRANCH="${LEDGER_BRANCH:-ledger/loop-fleet}"

write_overlay_status() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'overlay_status=%s\n' "$1" >> "$GITHUB_OUTPUT"
  fi
}

overlay_durable_loop_fleet_ledger() {
  local profile="${1:-}"
  local checkout_timeout fetch_timeout=180 probe_status=0 fetch_status checkout_status
  local ledger_blob_filter='blob:limit=1g'
  local -a ledger_paths
  case "$profile" in
    l10)
      checkout_timeout=120
      ledger_paths=(':(glob)data/loop-fleet/ledger/loop-health-history*.jsonl')
      ;;
    lifecycle)
      checkout_timeout=120
      ledger_paths=(':(glob)data/loop-fleet/ledger/lifecycle-events*.jsonl')
      ;;
    status)
      checkout_timeout=240
      ledger_paths=(
        ':(glob)data/loop-fleet/ledger/loop-health-history*.jsonl'
        ':(glob)data/loop-fleet/ledger/lifecycle-events*.jsonl'
      )
      ;;
    full)
      checkout_timeout=360
      ledger_paths=(
        ':(glob)data/loop-fleet/ledger/loop-observations*.jsonl'
        ':(glob)data/loop-fleet/ledger/loop-decisions*.jsonl'
        ':(glob)data/loop-fleet/ledger/loop-health-history*.jsonl'
        ':(glob)data/loop-fleet/ledger/lifecycle-events*.jsonl'
      )
      ;;
    *)
      echo 'Usage: overlay-durable-loop-fleet-ledger.sh {l10|status|full}' >&2
      return 2
      ;;
  esac

  if timeout --signal=TERM --kill-after=5s 15s \
    git ls-remote --exit-code --heads origin "refs/heads/$LEDGER_BRANCH" >/dev/null 2>&1; then
    :
  else
    probe_status=$?
  fi

  if [[ "$probe_status" -eq 2 ]]; then
    write_overlay_status ready
    echo "::notice::durable ledger branch $LEDGER_BRANCH does not exist; using the in-tree ledger."
    return 0
  elif [[ "$probe_status" -ne 0 ]]; then
    write_overlay_status failed
    echo "::error::could not verify durable ledger branch $LEDGER_BRANCH (exit $probe_status)." >&2
    return "$probe_status"
  fi

  # Actions uses a blobless partial clone. A normal fetch therefore leaves the
  # ledger blobs remote and the checkout lazily downloads every shard one by
  # one. The durable branch is JSONL-only, so request its blobs in one bounded
  # filtered pack before materializing the selected profile.
  if timeout --signal=TERM --kill-after=5s "${fetch_timeout}s" \
    git fetch --depth 1 --filter="$ledger_blob_filter" origin "$LEDGER_BRANCH"; then
    :
  else
    fetch_status=$?
    write_overlay_status failed
    echo "::error::could not fetch durable ledger branch $LEDGER_BRANCH (exit $fetch_status)." >&2
    return "$fetch_status"
  fi

  mkdir -p data/loop-fleet/ledger
  if timeout --signal=TERM --kill-after=5s "${checkout_timeout}s" \
    git checkout FETCH_HEAD -- "${ledger_paths[@]}"; then
    write_overlay_status ready
    echo "::notice::overlaid durable ledger inputs for $profile from $LEDGER_BRANCH"
  else
    checkout_status=$?
    write_overlay_status failed
    echo "::error::could not overlay durable ledger inputs for $profile (exit $checkout_status)." >&2
    return "$checkout_status"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  overlay_durable_loop_fleet_ledger "$@"
fi
