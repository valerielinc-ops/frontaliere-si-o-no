#!/usr/bin/env bash
# Publish a generated data snapshot through a pull request.
#
# Scheduled refreshes cannot push directly to this repository's main branch:
# the main ruleset requires the vitest status check, which only exists on a
# pull-request head. Keep the branch/PR plumbing here so sibling refresh jobs
# cannot drift back to a direct main push.
#
# Required environment:
#   GH_TOKEN            PAT or GitHub App token that can push and open PRs
#   GITHUB_REPOSITORY   owner/repository
#
# Usage:
#   bash scripts/lib/open-data-refresh-pr.sh \
#     --path data/example.json [--path data/example.meta.json] \
#     [--force] \
#     --branch chore/example-refresh \
#     --commit-message "chore(data): refresh example" \
#     --title "chore(data): refresh example" \
#     --body-file "$RUNNER_TEMP/example-pr-body.md"

set -euo pipefail

BRANCH=""
COMMIT_MESSAGE=""
TITLE=""
BODY_FILE=""
FORCE_ADD=false
RECONCILE_COMPAT=false
PATHS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --path)
      [ "$#" -ge 2 ] || { echo "::error::--path requires a value"; exit 2; }
      PATHS+=("$2")
      case "$2" in
        data/seo-404-compat|data/seo-404-compat/*)
          RECONCILE_COMPAT=true
          ;;
      esac
      shift 2
      ;;
    --branch)
      [ "$#" -ge 2 ] || { echo "::error::--branch requires a value"; exit 2; }
      BRANCH="$2"
      shift 2
      ;;
    --commit-message)
      [ "$#" -ge 2 ] || { echo "::error::--commit-message requires a value"; exit 2; }
      COMMIT_MESSAGE="$2"
      shift 2
      ;;
    --title)
      [ "$#" -ge 2 ] || { echo "::error::--title requires a value"; exit 2; }
      TITLE="$2"
      shift 2
      ;;
    --body-file)
      [ "$#" -ge 2 ] || { echo "::error::--body-file requires a value"; exit 2; }
      BODY_FILE="$2"
      shift 2
      ;;
    --force)
      FORCE_ADD=true
      shift
      ;;
    *)
      echo "::error::Unknown argument: $1"
      exit 2
      ;;
  esac
done

[ "${#PATHS[@]}" -gt 0 ] || { echo "::error::At least one --path is required"; exit 2; }
[ -n "$BRANCH" ] || { echo "::error::--branch is required"; exit 2; }
[ -n "$COMMIT_MESSAGE" ] || { echo "::error::--commit-message is required"; exit 2; }
[ -n "$TITLE" ] || { echo "::error::--title is required"; exit 2; }
[ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ] || {
  echo "::error::--body-file must point to an existing file"
  exit 2
}

REPOSITORY="${GITHUB_REPOSITORY:-}"
[ -n "$REPOSITORY" ] || {
  echo "::error::GITHUB_REPOSITORY is required"
  exit 2
}
[ -n "${GH_TOKEN:-}" ] || {
  echo "::error::GH_TOKEN is required; the ambient GITHUB_TOKEN cannot publish a refresh PR"
  exit 1
}

# Validate the exact PR contract before creating a commit or remote branch.
node scripts/ci/pr-body-check-gate.mjs --body-file "$BODY_FILE"

git checkout -B "$BRANCH"
if [ "$FORCE_ADD" = true ]; then
  # Some refreshes intentionally publish generated cache paths that remain
  # ignored in the normal checkout (for example the fuel cache/history). Keep
  # the force explicit at the publisher boundary so an ignored path can never
  # disappear silently from an otherwise successful refresh PR.
  git add -A -f -- "${PATHS[@]}"
else
  git add -A -- "${PATHS[@]}"
fi
if git diff --cached --quiet; then
  echo "No refresh changes to publish."
  exit 0
fi

# Data-refresh commits belong to the installed site automation identity, not a
# personal account. Keep the author stable across scheduled PRs.
git config user.name "frontaliere-automation[bot]"
git config user.email "296434481+frontaliere-automation[bot]@users.noreply.github.com"
git commit -m "$COMMIT_MESSAGE"

# A stable branch lets the next scheduled run update one in-flight PR instead
# of opening an unbounded queue of equivalent data PRs. Protect an existing
# branch with an explicit lease: a surprising concurrent writer is a failure,
# not a reason to overwrite its head.
REMOTE_HEAD="$(git ls-remote origin "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"

if [ "$RECONCILE_COMPAT" = true ]; then
  # The 404 producers share the sharded compat accumulator but publish through
  # two independent stable PR branches. Reconcile both the pending stable
  # branch and the newest main before pushing, otherwise this run starts from
  # the checkout's main snapshot and force-replaces an unmerged sweep. The
  # custom driver performs the store's deterministic 3-way SET merge, keeping
  # distinct additions in the same shard deduped and sorted.
  git fetch --no-tags origin main
  git config merge.compat-shard.driver 'node scripts/ci/merge-compat-shard.mjs %O %A %B'

  COMPAT_SHARD_ATTR="$(git check-attr merge -- data/seo-404-compat/part-00.json)"
  if [ "$COMPAT_SHARD_ATTR" != "data/seo-404-compat/part-00.json: merge: compat-shard" ]; then
    echo "::error::data/seo-404-compat shards are not assigned merge=compat-shard: ${COMPAT_SHARD_ATTR}" >&2
    exit 1
  fi

  merge_refresh_ref() {
    local ref="$1"
    if ! git merge --no-edit "$ref"; then
      git merge --abort 2>/dev/null || true
      echo "::error::Unable to reconcile refresh branch with ${ref}" >&2
      exit 1
    fi
  }

  if [ -n "$REMOTE_HEAD" ]; then
    git fetch --no-tags origin "refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
    merge_refresh_ref "origin/${BRANCH}"
  fi
  merge_refresh_ref origin/main
fi

PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPOSITORY}.git"
if [ -n "$REMOTE_HEAD" ]; then
  git -c http.https://github.com/.extraheader= push \
    --force-with-lease="refs/heads/${BRANCH}:${REMOTE_HEAD}" \
    "$PUSH_URL" "HEAD:${BRANCH}"
else
  git -c http.https://github.com/.extraheader= push "$PUSH_URL" "HEAD:${BRANCH}"
fi

OPEN_PR="$(gh pr list \
  --repo "$REPOSITORY" \
  --state open \
  --base main \
  --head "$BRANCH" \
  --json number \
  --jq '.[0].number // empty')"

if [ -n "$OPEN_PR" ]; then
  # Keep the body linked to the latest successful refresh run when the stable
  # branch already has an open PR. The branch update above re-triggers tests.
  gh pr edit "$OPEN_PR" --repo "$REPOSITORY" --title "$TITLE" --body-file "$BODY_FILE"
  echo "Updated refresh PR #$OPEN_PR"
  exit 0
fi

gh pr create \
  --repo "$REPOSITORY" \
  --base main \
  --head "$BRANCH" \
  --title "$TITLE" \
  --body-file "$BODY_FILE"
