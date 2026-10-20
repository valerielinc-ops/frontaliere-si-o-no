#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCKED_HTML_ENTITIES_VERSION="$(
  node -e '
    const lock = require(process.argv[1]);
    const version = lock.packages?.["node_modules/html-entities"]?.version;
    if (!version) process.exit(1);
    process.stdout.write(version);
  ' "$ROOT_DIR/package-lock.json"
)"

npm install \
  --prefix "$ROOT_DIR/packages/articles" \
  --workspaces=false \
  --omit=peer \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --no-save \
  --package-lock=false \
  "html-entities@$LOCKED_HTML_ENTITIES_VERSION"
