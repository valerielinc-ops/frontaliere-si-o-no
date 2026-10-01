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
#     [--force] [--resolve-symlinks] \
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
RESOLVE_SYMLINKS=false
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
    --resolve-symlinks)
      RESOLVE_SYMLINKS=true
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

# Build the authenticated endpoint before any remote lookup. `actions/checkout`
# intentionally uses `persist-credentials: false` in the protected refresh
# workflows, so `origin` is not allowed to be the authentication boundary.
PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPOSITORY}.git"

# Read the lease before changing the local checkout. A stable branch may back
# an open PR; its tree must be the base for this run instead of the workflow's
# main snapshot. The lease still protects the final push from a concurrent run.
REMOTE_HEAD="$(git ls-remote "$PUSH_URL" "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"
REFRESH_BASE="$(git rev-parse HEAD)"
REFRESH_COMMIT=""
MERGE_REFRESH_SCRIPT_DIR=""
REFRESH_PUBLISH_WORKTREE=""
REFRESH_SOURCE_ROOT="$(git rev-parse --show-toplevel)"

# Non-compat publishes never select the stable branch in the source checkout.
# Compat retains its existing restore behavior after its real Git merges.
cleanup_refresh_checkout() {
  if [ "$RECONCILE_COMPAT" = true ]; then
    local restore_ref="${REFRESH_COMMIT:-$REFRESH_BASE}"
    local current_ref
    current_ref="$(git -C "$REFRESH_SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$restore_ref" ] && [ "$current_ref" != "$restore_ref" ]; then
      git -C "$REFRESH_SOURCE_ROOT" checkout --detach --force "$restore_ref" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$REFRESH_PUBLISH_WORKTREE" ] && [ -f "$REFRESH_PUBLISH_WORKTREE/.git" ]; then
    if ! git -C "$REFRESH_SOURCE_ROOT" worktree remove --force "$REFRESH_PUBLISH_WORKTREE" >/dev/null 2>&1; then
      echo "::error::Unable to remove the isolated refresh worktree"
      return 1
    fi
  fi
  if [ -n "$MERGE_REFRESH_SCRIPT_DIR" ]; then
    rm -rf -- "$MERGE_REFRESH_SCRIPT_DIR"
  fi
}
trap 'cleanup_refresh_checkout || exit 1' EXIT

# The stable branch may have been created by an older workflow revision. Keep
# the reconciler from the current workflow checkout before creating its isolated
# publisher checkout, otherwise stale code can reintroduce a fixed merge rule.
if [ -n "$REMOTE_HEAD" ] && [ "$RECONCILE_COMPAT" = false ]; then
  MERGE_REFRESH_SCRIPT_DIR="$(mktemp -d)"
  mkdir -p "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci" "$MERGE_REFRESH_SCRIPT_DIR/scripts/lib"
  git show "${REFRESH_BASE}:scripts/ci/merge-open-data-refresh.mjs" \
    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/merge-open-data-refresh.mjs"
  git show "${REFRESH_BASE}:scripts/ci/open-data-refresh-merge.mjs" \
    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/open-data-refresh-merge.mjs"
  git show "${REFRESH_BASE}:scripts/lib/resolve-git-add-path.mjs" \
    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/lib/resolve-git-add-path.mjs"
  git show "${REFRESH_BASE}:scripts/lib/read-git-blob.mjs" \
    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/lib/read-git-blob.mjs"
fi

# Validate the exact PR contract before creating a commit or remote branch.
node scripts/ci/pr-body-check-gate.mjs --body-file "$BODY_FILE"

stage_paths() {
  if [ "$RESOLVE_SYMLINKS" = true ]; then
    # Generated article surfaces may be edited through historical symlink paths.
    # Resolve those paths before staging so the PR carries the real tracked blobs.
    node scripts/lib/git-add-resolved.mjs "${PATHS[@]}"
  elif [ "$FORCE_ADD" = true ]; then
    # Some refreshes intentionally publish generated cache paths that remain
    # ignored in the normal checkout (for example the fuel cache/history). Keep
    # the force explicit at the publisher boundary so an ignored path can never
    # disappear silently from an otherwise successful refresh PR.
    git add -A -f -- "${PATHS[@]}"
  else
    git add -A -- "${PATHS[@]}"
  fi
}

stage_paths
if git diff --cached --quiet; then
  echo "No refresh changes to publish."
  exit 0
fi

# Data-refresh commits belong to the installed site automation identity, not a
# personal account. Keep the author stable across scheduled PRs.
git config user.name "frontaliere-automation[bot]"
git config user.email "296434481+frontaliere-automation[bot]@users.noreply.github.com"
git commit -m "$COMMIT_MESSAGE"
REFRESH_COMMIT="$(git rev-parse HEAD)"

# A stable branch lets the next scheduled run update one in-flight PR instead
# of opening an unbounded queue of equivalent data PRs. Start from the remote
# tree when it exists, then apply this run's commit on top of it. This keeps
# earlier append-only/state records in an unmerged PR without changing the
# workflow checkout for non-compat refreshes.
if [ -n "$REMOTE_HEAD" ]; then
  # The workflow checkout is intentionally shallow. Fetch only the stable
  # branch tip for the non-compat reconciler; the compat path performs real
  # Git merges and therefore needs the branch history and merge-base.
  if [ "$RECONCILE_COMPAT" = true ]; then
    git fetch --no-tags "$PUSH_URL" \
      "+refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"
    git checkout -B "$BRANCH" "refs/remotes/refresh/${BRANCH}"
  else
    git fetch --no-tags --depth=1 "$PUSH_URL" \
      "+refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"
    # Reconcile in a separate, sparse checkout. A data branch may carry old
    # crawlers/helpers; selecting it in the workflow checkout would change the
    # code used by every later step, including after a best-effort failure.
    PUBLISH_PATHS=()
    while IFS= read -r -d '' refresh_path; do
      PUBLISH_PATHS+=("$refresh_path")
    done < <(git diff --name-only -z "$REFRESH_BASE" "$REFRESH_COMMIT")
    REFRESH_PUBLISH_WORKTREE="$MERGE_REFRESH_SCRIPT_DIR/publish"
    git worktree add --detach --no-checkout "$REFRESH_PUBLISH_WORKTREE" "$REMOTE_HEAD"
    cd "$REFRESH_PUBLISH_WORKTREE"
    printf '/%s\n' "${PUBLISH_PATHS[@]}" | git sparse-checkout set --no-cone --stdin
    git checkout --quiet
    # These are the real committed paths, already resolved through symlinks
    # by the initial stage. The sparse checkout need not include alias paths.
    PATHS=("${PUBLISH_PATHS[@]}")
    RESOLVE_SYMLINKS=false
  fi
fi

if [ "$RECONCILE_COMPAT" = true ]; then
  # The 404 producers share the sharded compat accumulator but publish through
  # two independent stable PR branches. Reconcile both the pending stable
  # branch and the newest main before pushing, otherwise this run starts from
  # the checkout's main snapshot and force-replaces an unmerged sweep. The
  # custom driver performs the store's deterministic 3-way SET merge, keeping
  # distinct additions in the same shard deduped and sorted.
  git fetch --no-tags "$PUSH_URL" \
    "refs/heads/main:refs/remotes/origin/main"
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
    merge_refresh_ref "$REFRESH_COMMIT"
  fi
  merge_refresh_ref origin/main
elif [ -n "$REMOTE_HEAD" ]; then
  # The current refresh was committed from the workflow checkout before the
  # isolated stable-branch checkout was created. Reconcile with path-aware rules:
  # JSONL histories and Telegram ledgers union both runs, while complete
  # snapshots use the current run as the authoritative value.
  MERGE_ARGS=(
    --base "$REFRESH_BASE"
    --remote "$REMOTE_HEAD"
    --refresh "$REFRESH_COMMIT"
  )
  for refresh_path in "${PATHS[@]}"; do
    MERGE_ARGS+=(--path "$refresh_path")
  done
  node "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/merge-open-data-refresh.mjs" "${MERGE_ARGS[@]}"
  stage_paths
  if git diff --cached --quiet; then
    echo "No new refresh changes after stable-branch reconciliation."
    exit 0
  fi
  git commit -m "$COMMIT_MESSAGE"
fi

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
