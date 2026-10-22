#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCKED_NOBLE_HASHES_VERSION="$(
  node -e '
    const lock = require(process.argv[1]);
    const version = lock.packages?.["node_modules/@noble/hashes"]?.version;
    if (!version) process.exit(1);
    process.stdout.write(version);
  ' "$ROOT_DIR/package-lock.json"
)"
LOCKED_HTML_ENTITIES_VERSION="$(
  node -e '
    const lock = require(process.argv[1]);
    const version = lock.packages?.["node_modules/html-entities"]?.version;
    if (!version) process.exit(1);
    process.stdout.write(version);
  ' "$ROOT_DIR/package-lock.json"
)"

NOBLE_DEPS_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/article-renderer-noble.XXXXXX")"
trap 'rm -rf -- "$NOBLE_DEPS_DIR"' EXIT

npm install \
  --prefix "$NOBLE_DEPS_DIR" \
  --workspaces=false \
  --omit=peer \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --no-save \
  --package-lock=false \
  "@noble/hashes@$LOCKED_NOBLE_HASHES_VERSION"

mkdir -p "$ROOT_DIR/node_modules/@noble"
rm -rf -- "$ROOT_DIR/node_modules/@noble/hashes"
cp -a -- "$NOBLE_DEPS_DIR/node_modules/@noble/hashes" "$ROOT_DIR/node_modules/@noble/hashes"

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
