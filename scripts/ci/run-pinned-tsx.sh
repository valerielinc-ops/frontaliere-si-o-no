#!/usr/bin/env bash
# Run an uninstalled, pinned tsx entrypoint on a fast-publish path.
#
# These workflows deliberately skip npm ci, so the first npx invocation has a
# small external npm bootstrap in front of the real gate. A transient registry
# or runner failure must not strand one matrix leg while its sibling proceeds.
# The wrapped entrypoints are idempotent/fail-closed: retrying them cannot
# publish HTML after a failed ensure, and the final exit code is preserved.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "::error::[tsx-bootstrap] an entrypoint is required" >&2
  exit 2
fi

readonly TSX_SPEC='tsx@4.23.15'
readonly MAX_ATTEMPTS=3
readonly ATTEMPT_TIMEOUT_SECONDS=120
readonly KILL_AFTER_SECONDS=15
readonly RETRY_DELAYS_SECONDS=(5 15)

entrypoint="$1"
attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "[tsx-bootstrap] running ${entrypoint} (attempt ${attempt}/${MAX_ATTEMPTS})"
  exit_code=0
  if timeout --kill-after="${KILL_AFTER_SECONDS}s" "${ATTEMPT_TIMEOUT_SECONDS}s" \
    npx --yes "$TSX_SPEC" "$@"; then
    exit 0
  else
    exit_code=$?
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "::error::[tsx-bootstrap] ${entrypoint} failed after ${MAX_ATTEMPTS} attempts (exit ${exit_code})" >&2
    exit "$exit_code"
  fi

  retry_delay="${RETRY_DELAYS_SECONDS[$((attempt - 1))]}"
  echo "::warning::[tsx-bootstrap] ${entrypoint} failed (exit ${exit_code}); retrying in ${retry_delay}s (attempt $((attempt + 1))/${MAX_ATTEMPTS})" >&2
  sleep "$retry_delay"
  attempt=$((attempt + 1))
done

echo "::error::[tsx-bootstrap] retry loop ended without a verdict" >&2
exit 1
