#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 1 ] && [ "$1" = '--version' ]; then
  exec "${CODEX_GH_REAL:?Codex GitHub CLI path unavailable}" "$@"
fi
exec node "${CODEX_GH_CLIENT:?Codex GitHub bridge client unavailable}" "$@"
