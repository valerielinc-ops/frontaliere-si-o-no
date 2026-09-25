#!/usr/bin/env bash
# Retry only deterministic crawler setup: `npm ci` clears node_modules first;
# Playwright verifies completed browsers, discards partial downloads, and its
# dependency installation converges when repeated.
set -euo pipefail

attempts="${CRAWLER_RETRY_CMD_ATTEMPTS:-3}"
backoff_step="${CRAWLER_RETRY_CMD_BACKOFF:-10}"

if [ "$#" -eq 0 ]; then
  echo "::error::crawler-retry-cmd.sh chiamato senza comando." >&2
  exit 2
fi

if [ "$#" -ge 2 ] && [ "$1" = "npm" ] && [ "$2" = "ci" ]; then
  :
elif [ "$#" -eq 5 ] && [ "$1" = "npx" ] && [ "$2" = "playwright" ] \
  && [ "$3" = "install" ] && [ "$4" = "--with-deps" ] && [ "$5" = "chromium" ]; then
  :
else
  echo "::error::crawler-retry-cmd.sh rifiuta un comando non autorizzato." >&2
  exit 2
fi

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || ! [[ "$backoff_step" =~ ^[0-9]+$ ]]; then
  echo "::error::crawler-retry-cmd.sh richiede tentativi positivi e backoff non negativo." >&2
  exit 2
fi

attempt=1
while true; do
  if "$@"; then
    exit 0
  else
    status=$?
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::comando crawler fallito dopo ${attempt} tentativi (exit ${status})." >&2
    exit "$status"
  fi

  delay=$((attempt * backoff_step))
  echo "::warning::comando crawler fallito (tentativo ${attempt}/${attempts}); nuovo tentativo tra ${delay}s." >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
