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

# Target repo: prefer the owner/repo already encoded in the CURRENT origin
# URL over $GITHUB_REPOSITORY. A cross-repo `workflow_call` (e.g. the
# crawler-group-NN-logic.yml reusable workflows physically hosted here but
# invoked from nanakokyobashi-rgb/frontaliere-articles, #6537) sees
# $GITHUB_REPOSITORY resolve to the CALLER's repo, not this one — callers
# that explicitly pointed origin at a different repo (e.g. an earlier
# "Bootstrap write auth" step targeting valerielinc-ops/frontaliere-si-o-no)
# had that override silently clobbered back to the ambient repo on the very
# first ensure_git_auth() call, so every push in that context landed in the
# wrong repository (issue #6701: two days of crawler pushes vanished into
# frontaliere-articles instead of updating data/jobs.json here, freezing
# data/jobs-stats-history.json). Falls back to $GITHUB_REPOSITORY only when
# origin has no parseable owner/repo path (e.g. a fresh checkout whose
# origin was never explicitly overridden).
target_repo=""
case "$origin_url" in
  https://*github.com/*/*)
    _path="${origin_url#https://}"
    _path="${_path#*github.com/}"
    _path="${_path%.git}"
    _path="${_path%/}"
    case "$_path" in
      */*/*) ;; # more than one path segment after owner/repo — not parseable
      */*) target_repo="$_path" ;;
    esac
    ;;
esac
if [ -z "$target_repo" ]; then
  target_repo="${GITHUB_REPOSITORY:-}"
fi
if [ -z "$target_repo" ]; then
  echo "::error::Could not determine target owner/repo from origin ('${origin_url}') or \$GITHUB_REPOSITORY; cannot configure origin for a main push."
  exit 1
fi

# actions/checkout persists AUTHORIZATION: basic <GITHUB_TOKEN> on
# http.https://github.com/.extraheader. That header wins over credentials
# embedded in the remote URL, so a rewrite without this unset silently
# pushes back as github-actions[bot].
git config --local --unset-all http.https://github.com/.extraheader 2>/dev/null || true
git remote set-url origin "https://x-access-token:${PUSH_TOKEN}@github.com/${target_repo}.git"
