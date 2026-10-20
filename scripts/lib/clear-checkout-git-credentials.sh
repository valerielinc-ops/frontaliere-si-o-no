#!/usr/bin/env bash
# Remove the ambient credential that actions/checkout persists in THIS
# repository's git config (`AUTHORIZATION: basic <GITHUB_TOKEN>` as an
# extraheader), so the credential a caller embeds in the remote URL (App token
# or PAT) is the one git actually sends.
#
# An extraheader is sent pre-emptively; credentials in the URL are only used
# after a 401 challenge, which never comes while the header authenticates. So
# a leftover header silently turns an App/PAT push into a github-actions[bot]
# push: GH013 on `main` (the ruleset only lets the bypass identities through),
# no downstream workflow triggered on PR branches.
#
# actions/checkout stores that header in one of two shapes:
#   - <= v5: `http.https://github.com/.extraheader` directly in .git/config;
#   - >= v6 (v7 here since fe85af95, 2026-09-30): a separate
#     `$RUNNER_TEMP/git-credentials-<uuid>.config`, pulled in by
#     `includeIf.gitdir:<repo>/.git.path` (plus `.git/worktrees/*` and the
#     container-path variants). `git config --local --unset-all` never sees it,
#     which is how every PAT push to main went back to github-actions[bot]
#     (persist-job-stats run 36784759656 and siblings, all GH013).
# Both are removed. For the second, only the includeIf entries whose value is
# a checkout credentials file are dropped — the same selection checkout's own
# post-step makes ("Removing includeIf entries pointing to credentials config
# files"); unrelated includes stay. The credentials file itself is left to
# checkout's post-step.
#
# Then the EFFECTIVE configuration (every scope, includes followed) is checked:
# if an AUTHORIZATION extraheader for https://github.com/ still survives, exit 1
# instead of letting the push go out under an identity nobody chose.
set -euo pipefail

# checkout <= v5 (and any caller that wrote the header locally).
git config --local --unset-all http.https://github.com/.extraheader 2>/dev/null || true

# checkout >= v6: includeIf → git-credentials-<uuid>.config.
include_keys="$(git config --local --name-only --get-regexp '^includeif\.gitdir:' 2>/dev/null | sort -u || true)"
while IFS= read -r include_key; do
  [ -n "$include_key" ] || continue
  include_values="$(git config --local --get-all "$include_key" 2>/dev/null || true)"
  while IFS= read -r include_path; do
    if [[ "$include_path" =~ (^|/)git-credentials-[0-9A-Fa-f-]+\.config$ ]]; then
      git config --local --fixed-value --unset-all "$include_key" "$include_path"
    fi
  done <<< "$include_values"
done <<< "$include_keys"

# Headers git would send to github.com: generic `http.extraheader` plus every
# `http.<github.com URL>.extraheader`, in config order (system → global →
# local with includes → worktree → command line), applying git's own list rule
# that an empty value resets the headers collected so far. Values are never
# printed.
authorization_key=""
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  key="${entry%% *}"
  value=""
  if [ "$entry" != "$key" ]; then value="${entry#* }"; fi
  # Case-insensitive match without ${value,,}: bash 3.2 (macOS) lacks it.
  case "$value" in
    '') authorization_key="" ;;
    [Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]:*) authorization_key="$key" ;;
  esac
done < <(git config --get-regexp '^http\.(https://github\.com[^[:space:]]*\.)?extraheader$' 2>/dev/null || true)

if [ -n "$authorization_key" ]; then
  echo "::error::An AUTHORIZATION extraheader for https://github.com/ (${authorization_key}) is still effective after removing the actions/checkout credential; it would override the token in the remote URL. Origins (values omitted):" >&2
  git config --show-origin --name-only --get-regexp '^http\..*extraheader$' >&2 || true
  exit 1
fi
