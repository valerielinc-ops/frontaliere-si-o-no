#!/usr/bin/env bash
# Start the Headroom proxy and route Claude through it via ANTHROPIC_BASE_URL.
# Counterpart of install.sh — see that file for why this lives in a script
# rather than inline in action.yml.
#
# Fail-open: every failure path exits 0 with ANTHROPIC_BASE_URL left unset.
#
# Arg 1: port (default 8787).
set -uo pipefail

PORT="${1:-8787}"
export PATH="$HOME/.local/bin:$PATH"

if ! command -v headroom >/dev/null 2>&1; then
  echo "::warning::HEADROOM-INACTIVE: headroom not installed — skipping compression (Claude runs direct)."
  exit 0
fi

# CCR must be disabled: claude-code-action is a streaming client that cannot
# resolve a dynamically-injected `headroom_retrieve` tool, and errors with "No
# such tool available" on any compressed output (observed run
# 28503800274/job 84487138871). Compression-only mode still saves tokens.
#
# The flag SPELLING moved between releases and a hard-coded flag fails closed in
# the worst way: `headroom proxy` exits with "Error: No such option
# '--no-ccr-inject-tool'", the readiness loop burns its full 30s, and the job
# proceeds uncompressed with only a buried warning. That is exactly what
# happened when CI drifted 0.27 → 0.32.1 — every review since ran uncompressed.
# Probing --help keeps this working across both spellings instead of pinning a
# version that would freeze us out of upstream fixes.
#   0.32+ : --no-ccr                              (single flag, supersedes both)
#   0.27  : --no-ccr-inject-tool --no-ccr-marker
# The `[[:space:]]` guard matters: a bare `--no-ccr` substring also matches
# `--no-ccr-inject-tool`, which would pick the wrong branch on old versions.
HELP="$(headroom proxy --help 2>&1 || true)"
CCR_FLAGS=()
if grep -qE -- '--no-ccr([[:space:]]|$)' <<<"$HELP"; then
  CCR_FLAGS=(--no-ccr)
elif grep -qE -- '--no-ccr-inject-tool([[:space:]]|$)' <<<"$HELP"; then
  CCR_FLAGS=(--no-ccr-inject-tool --no-ccr-marker)
else
  echo "::warning::HEADROOM-INACTIVE: no known CCR-disable flag in \`headroom proxy --help\` — starting without it; Claude may error on injected retrieve tools."
fi
echo "Headroom CCR flags: ${CCR_FLAGS[*]:-<none>}"

nohup headroom proxy --port "$PORT" --stateless "${CCR_FLAGS[@]}" \
  > "${RUNNER_TEMP:-/tmp}/headroom-proxy.log" 2>&1 &

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/readyz" >/dev/null 2>&1; then
    echo "Headroom proxy ready on port ${PORT}."
    echo "ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}" >> "${GITHUB_ENV:-/dev/null}"
    echo "Claude routed through Headroom (http://127.0.0.1:${PORT})."
    exit 0
  fi
  sleep 1
done

# Loud + greppable: the previous wording ("did not become ready") read as a
# benign notice and went unnoticed across many runs while the real cause (a
# rejected CLI flag) sat in the log below it.
echo "::warning::HEADROOM-INACTIVE: proxy not ready in 30s — Claude runs UNCOMPRESSED. Proxy log follows."
cat "${RUNNER_TEMP:-/tmp}/headroom-proxy.log" 2>/dev/null || true
exit 0
