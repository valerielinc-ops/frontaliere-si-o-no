#!/usr/bin/env bash
# Configure an explicit owner/App credential for a direct write to this
# repo's GitHub `main`. The repository ruleset rejects the ambient Actions
# `GITHUB_TOKEN` / `github-actions[bot]` identity on those pushes (GH013).
#
# GITHUB_TOKEN / GH_TOKEN are intentionally not fallbacks. Long-lived
# `GITHUB_PAT` is preferred over `APP_TOKEN`: App installation tokens expire
# ~1h and some writers run for hours after minting.
#
# Origin URLs that are not github.com (local test remotes, file:// clones)
# are left alone so in-repo helper tests can still push to a temp bare repo.
set -euo pipefail

origin_url="$(git remote get-url origin 2>/dev/null || true)"
case "$origin_url" in
  *github.com*) ;;
  *) exit 0 ;;
esac

PUSH_TOKEN="${GITHUB_PAT:-${APP_TOKEN:-}}"
if [ -z "$PUSH_TOKEN" ]; then
  echo "::error::Neither GITHUB_PAT nor APP_TOKEN is available for a direct main push. The ambient GITHUB_TOKEN / github-actions[bot] identity is rejected by the main ruleset (GH013). Load Remote Config (GITHUB_PAT) or mint an App token before pushing."
  exit 1
fi

if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  echo "::error::GITHUB_REPOSITORY is not set; cannot configure origin for a main push."
  exit 1
fi

# actions/checkout persists AUTHORIZATION: basic <GITHUB_TOKEN> on
# http.https://github.com/.extraheader. That header wins over credentials
# embedded in the remote URL, so a rewrite without this unset silently
# pushes back as github-actions[bot].
git config --local --unset-all http.https://github.com/.extraheader 2>/dev/null || true
git remote set-url origin "https://x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
