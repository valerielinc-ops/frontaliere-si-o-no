#!/usr/bin/env bash
# Install Headroom into the runner. Extracted from action.yml so that a caller
# which wants the install to overlap other work can run it as a `background:`
# step (`run:` steps only — `background:` on a `uses:` step is unsupported and
# breaks the whole workflow file). The composite action and pr-review-loop.yml
# both source THIS script, so there is exactly one install implementation.
#
# Fail-open by design: every failure path exits 0. A missing Headroom must never
# block a review/fix gate — start.sh then leaves ANTHROPIC_BASE_URL unset and
# Claude talks to Anthropic directly (uncompressed).
#
# Arg 1: pip extras (default "proxy,code" — no heavy ML model in CI).
set -uo pipefail

EXTRAS="${1:-proxy,code}"

# pipx is preinstalled on GitHub-hosted runners; fall back to pip --user for
# self-hosted / externally-managed environments.
if pipx install "headroom-ai[${EXTRAS}]"; then
  :
else
  python3 -m pip install --user --break-system-packages "headroom-ai[${EXTRAS}]" || true
fi

echo "$HOME/.local/bin" >> "${GITHUB_PATH:-/dev/null}"

# Record the resolved version: the CCR flag rename that silently disabled
# compression for weeks (0.27 `--no-ccr-inject-tool` → 0.32 `--no-ccr`) was
# invisible because nothing logged which version was running.
export PATH="$HOME/.local/bin:$PATH"
if command -v headroom >/dev/null 2>&1; then
  echo "Headroom installed: $(headroom --version 2>&1 | head -1)"
else
  echo "::warning::HEADROOM-INACTIVE: install produced no \`headroom\` binary — Claude will run uncompressed."
fi

exit 0
