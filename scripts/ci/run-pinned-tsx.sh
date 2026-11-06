#!/usr/bin/env bash
# Run an uninstalled, pinned tsx entrypoint on a fast-publish path.
#
# These workflows deliberately skip npm ci, so resolving the pinned tsx package
# is a small external npm bootstrap in front of the real gate. Retry only that
# harmless version probe: once the entrypoint starts, it is invoked exactly once
# because it may already have performed a remote side effect before failing.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "::error::[tsx-bootstrap] an entrypoint is required" >&2
  exit 2
fi

readonly TSX_SPEC='tsx@4.23.15'
readonly MAX_ATTEMPTS=3
readonly ATTEMPT_TIMEOUT_SECONDS=120
readonly ENTRYPOINT_TIMEOUT_SECONDS="${PINNED_TSX_ENTRYPOINT_TIMEOUT_SECONDS:-$ATTEMPT_TIMEOUT_SECONDS}"
readonly KILL_AFTER_SECONDS=15
readonly RETRY_DELAYS_SECONDS=(5 15)

if ! [[ "$ENTRYPOINT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::[tsx-bootstrap] PINNED_TSX_ENTRYPOINT_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi

entrypoint="$1"
shift
attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "[tsx-bootstrap] resolving ${TSX_SPEC} (attempt ${attempt}/${MAX_ATTEMPTS})"
  exit_code=0
  if timeout --kill-after="${KILL_AFTER_SECONDS}s" "${ATTEMPT_TIMEOUT_SECONDS}s" \
    npx --yes "$TSX_SPEC" --version; then
    break
  else
    exit_code=$?
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "::error::[tsx-bootstrap] resolving ${TSX_SPEC} failed after ${MAX_ATTEMPTS} attempts (exit ${exit_code})" >&2
    exit "$exit_code"
  fi

  retry_delay="${RETRY_DELAYS_SECONDS[$((attempt - 1))]}"
  echo "::warning::[tsx-bootstrap] resolving ${TSX_SPEC} failed (exit ${exit_code}); retrying in ${retry_delay}s (attempt $((attempt + 1))/${MAX_ATTEMPTS})" >&2
  sleep "$retry_delay"
  attempt=$((attempt + 1))
done

echo "[tsx-bootstrap] running ${entrypoint} once"
exit_code=0
if timeout --kill-after="${KILL_AFTER_SECONDS}s" "${ENTRYPOINT_TIMEOUT_SECONDS}s" \
  npx --yes "$TSX_SPEC" "$entrypoint" "$@"; then
  exit 0
else
  exit_code=$?
fi

echo "::error::[tsx-bootstrap] ${entrypoint} failed after its single invocation (exit ${exit_code}); entrypoints are not retried after start" >&2
exit "$exit_code"
