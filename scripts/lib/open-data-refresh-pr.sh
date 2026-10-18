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
#     [--optional-path data/example-dir] \
#     [--force] [--resolve-symlinks] [--reconcile-main] \
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
RECONCILE_MAIN=false
REQUIRE_NEW_BRANCH="${EVENTS_REFRESH_REQUIRE_NEW_BRANCH:-false}"
PATHS=()
OPTIONAL_PATHS=()

case "$REQUIRE_NEW_BRANCH" in
  true|false) ;;
  *) echo "::error::EVENTS_REFRESH_REQUIRE_NEW_BRANCH must be true or false"; exit 2 ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --optional-path)
      [ "$#" -ge 2 ] || { echo "::error::--optional-path requires a value"; exit 2; }
      OPTIONAL_PATHS+=("$2")
      shift 2
      ;;
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
    --reconcile-main)
      RECONCILE_MAIN=true
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

# An optional path is one the producer may not have created yet — typically a
# directory that gets its first file only when the upstream starts publishing
# that artifact. `git add` aborts on a pathspec that matches nothing (run
# 37515283217 of the article sync: `fatal: pathspec ... did not match any
# files`, and the whole refresh was lost with it). A tracked path that
# disappeared must still be staged, as a deletion. A required `--path` keeps
# failing loudly — a typo there must not turn into a silent, empty refresh.
#
# Do not spell real repository directories in the comments of this helper:
# scripts/ci/checkout-profile-analyzer.mjs reads this file as part of every
# job that calls it, comments included, and a literal bucket path here would
# make each of those sparse checkouts look like a reader of that bucket.
#
# "Exists" is not enough either: a producer may create the directory before it
# writes the first file. The path enters the staging set only when git has
# something to do there — an entry already in the index, or an untracked file
# it would add (ignored files count only under --force). An alias reached
# through a symlink is judged at its real path, the one staging will use. When
# the question cannot be answered the path is kept and git speaks for itself
# at staging time.
optional_path_is_stageable() {
  local candidate="$1" untracked
  if [ "$RESOLVE_SYMLINKS" = true ]; then
    candidate="$(node scripts/lib/git-add-resolved.mjs --print-only "$candidate")" || return 0
  fi
  if git ls-files --error-unmatch -- "$candidate" > /dev/null 2>&1; then return 0; fi
  if [ "$FORCE_ADD" = true ]; then
    untracked="$(git ls-files --others -- "$candidate" 2> /dev/null)" || return 0
  else
    untracked="$(git ls-files --others --exclude-standard -- "$candidate" 2> /dev/null)" || return 0
  fi
  [ -n "$untracked" ]
}

path_is_listed() {
  local candidate="$1" listed
  for listed in "${PATHS[@]}"; do
    if [ "$listed" = "$candidate" ]; then return 0; fi
  done
  return 1
}

if [ "${#OPTIONAL_PATHS[@]}" -gt 0 ]; then
  for optional_path in "${OPTIONAL_PATHS[@]}"; do
    if path_is_listed "$optional_path"; then
      continue
    elif optional_path_is_stageable "$optional_path"; then
      PATHS+=("$optional_path")
    elif [ -e "$optional_path" ] || [ -L "$optional_path" ]; then
      echo "::notice::Optional refresh path has nothing to stage: $optional_path"
    else
      echo "::notice::Optional refresh path absent and untracked, nothing to stage: $optional_path"
    fi
  done
fi

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
OLD_HISTORY_GUARD_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/old-history-guard.mjs"
BOUNDED_COMMAND_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-bounded-command.mjs"

# These are deliberately conservative starting ceilings. The ls-remote, API
# and gh pr values reuse the existing 60-second remote-branch API ceiling; the
# fetch value is a five-minute allowance for a filtered graph read. Issue 12175
# measured completion of that commit graph at 61.6, 62.6, 83.0 and 95.1
# seconds, so 300 seconds leaves room for ordinary variance. The other read
# values have not been measured in CI yet.
# The namespaced override exists only so the offline fixture can replay a stuck
# read; normal jobs leave it unset and keep the 60-second default.
LS_REMOTE_TIMEOUT_SECONDS="${OPEN_DATA_REFRESH_LS_REMOTE_TIMEOUT_SECONDS:-60}"
FETCH_TIMEOUT_SECONDS=300
API_TIMEOUT_SECONDS=60
GH_PR_TIMEOUT_SECONDS=60

# This is the 180-second push ceiling introduced for issue 12262 / PR 12318.
PUSH_TIMEOUT_SECONDS=180

# No network command here may run until the job timeout: past its cap the
# command is stopped and the log names it.
run_bounded() {
  local seconds="$1" label="$2"
  shift 2
  node "$BOUNDED_COMMAND_SCRIPT" --timeout-seconds "$seconds" --label "$label" -- "$@"
}

compat_merge_base() {
  local left="$1" right="$2" label="$3" base
  base="$(run_bounded "$API_TIMEOUT_SECONDS" "$label" \
    gh api "repos/${REPOSITORY}/compare/${left}...${right}" --jq '.merge_base_commit.sha')"
  [ -n "$base" ] && [ "$base" != null ] || {
    echo "::error::Missing compatibility merge base for ${left}...${right}" >&2
    return 1
  }
  if ! GIT_NO_LAZY_FETCH=1 git cat-file -e "${base}^{commit}" 2>/dev/null; then
    run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch compatibility merge base" \
      git fetch --no-tags --depth=1 "$PUSH_URL" "$base"
  fi
  printf '%s\n' "$base"
}

reconcile_compat_ref() {
  local merge_base="$1" theirs="$2"
  node "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/reconcile-data-refresh-main.mjs" \
    --compat \
    --base "$merge_base" --main "$theirs" --message "$COMMIT_MESSAGE"
}

check_old_history_ref() {
  local head_ref="$1"
  node "$OLD_HISTORY_GUARD_SCRIPT" \
    --head "$head_ref" \
    --base refs/remotes/origin/main \
    --refresh-base \
    --remote "$PUSH_URL" \
    --branch main
}

# Prima di creare commit, worktree o branch remoto: se il checkout corrente
# conserva la storia precedente e main è già riscritto, fermarsi qui evita di
# pubblicare un PR dati che la reintroduca. Il fetch è treeless e non tocca il
# worktree.
check_old_history_ref HEAD

# Read the lease before changing the local checkout. A stable branch may back
# an open PR, while an orphaned branch must be replaced from the workflow's
# main snapshot. The lease still protects the final push from a concurrent run.
REMOTE_HEAD="$(run_bounded "$LS_REMOTE_TIMEOUT_SECONDS" "git ls-remote stable refresh branch" \
  git ls-remote "$PUSH_URL" "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"
if [ "$REQUIRE_NEW_BRANCH" = true ]; then
  if [ -n "$REMOTE_HEAD" ]; then
    echo "::error::Refusing to reuse ${BRANCH}: this events refresh requires a new branch, but the remote already has ${REMOTE_HEAD}."
    exit 1
  fi
  # This state is shared by later publisher steps in the same workflow run.
  # Once the fresh branch is verified absent, only the first publisher needs
  # the guard; subsequent steps may safely continue that run's own branch.
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'EVENTS_REFRESH_REQUIRE_NEW_BRANCH=false\n' >> "$GITHUB_ENV"
  fi
fi
REFRESH_BASE="$(git rev-parse HEAD)"
REFRESH_COMMIT=""
MERGE_REFRESH_SCRIPT_DIR=""
REFRESH_PUBLISH_WORKTREE=""
REFRESH_SOURCE_ROOT="$(git rev-parse --show-toplevel)"
RESET_STALE_STABLE_BRANCH=false
STALE_REMOTE_HEAD=""

# Non-compat publishes never select the stable branch in the source checkout.
# Compat retains its existing restore behavior after tree-level reconciliation.
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

# The stable branch may have been created by an older workflow revision. Pin
# the merge tools to this run's refresh snapshot before selecting that branch;
# a stale branch must not supply either the merge policy or its CLI contract.
MERGE_REFRESH_SCRIPT_DIR="$(mktemp -d)"
mkdir -p "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci" "$MERGE_REFRESH_SCRIPT_DIR/scripts/lib"
git show "${REFRESH_BASE}:scripts/ci/open-data-refresh-merge.mjs" \
  > "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/open-data-refresh-merge.mjs"
git show "${REFRESH_BASE}:scripts/lib/read-git-blob.mjs" \
  > "$MERGE_REFRESH_SCRIPT_DIR/scripts/lib/read-git-blob.mjs"

if [ "$RECONCILE_COMPAT" = true ] || [ "$RECONCILE_MAIN" = true ]; then
  git show "${REFRESH_BASE}:scripts/ci/reconcile-data-refresh-main.mjs" \
    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/reconcile-data-refresh-main.mjs"
fi

if [ "$RECONCILE_COMPAT" = false ]; then
  git show "${REFRESH_BASE}:scripts/ci/merge-open-data-refresh.mjs" \
    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/merge-open-data-refresh.mjs"
  git show "${REFRESH_BASE}:scripts/lib/resolve-git-add-path.mjs" \
    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/lib/resolve-git-add-path.mjs"
fi

# Validate the exact PR contract before creating a commit or remote branch.
node scripts/ci/pr-body-check-gate.mjs --body-file "$BODY_FILE"

stage_paths() {
  local target resolved_target changed_path
  local target_has_changes
  local -a stageable_paths=()

  # Never pass a whole sparse-excluded directory to `git add -A`: Git would
  # interpret every absent tracked archive entry as a deletion. Build the
  # producer-owned file list from real worktree changes and untracked output,
  # while still letting a required missing path fail with Git's own error.
  for target in "${PATHS[@]}"; do
    resolved_target="$target"
    if [ "$RESOLVE_SYMLINKS" = true ]; then
      # Generated article surfaces may be edited through historical symlink
      # paths. Resolve them before collecting the actual files to stage.
      resolved_target="$(node scripts/lib/git-add-resolved.mjs --print-only "$target")" || return 1
    fi
    target_has_changes=false
    while IFS= read -r -d '' changed_path; do
      stageable_paths+=("$changed_path")
      target_has_changes=true
    done < <(git diff --name-only -z --diff-filter=ACDMRTUXB -- "$resolved_target")
    if [ "$FORCE_ADD" = true ]; then
      while IFS= read -r -d '' changed_path; do
        stageable_paths+=("$changed_path")
        target_has_changes=true
      done < <(git ls-files --others -z -- "$resolved_target")
    else
      while IFS= read -r -d '' changed_path; do
        stageable_paths+=("$changed_path")
        target_has_changes=true
      done < <(git ls-files --others --exclude-standard -z -- "$resolved_target")
    fi
    if [ "$target_has_changes" = false ] \
      && [ ! -e "$resolved_target" ] \
      && [ ! -L "$resolved_target" ] \
      && ! git ls-files --error-unmatch -- "$resolved_target" > /dev/null 2>&1; then
      # Preserve the required-path contract for typos and missing producers.
      git add --sparse -A -- "$resolved_target"
    fi
  done

  if [ "${#stageable_paths[@]}" -gt 0 ]; then
    if [ "$FORCE_ADD" = true ]; then
      # Keep force explicit so ignored generated cache files can be published.
      git add --sparse -A -f -- "${stageable_paths[@]}"
    else
      git add --sparse -A -- "${stageable_paths[@]}"
    fi
  fi
}

stage_paths
# Data-refresh commits belong to the installed site automation identity, not a
# personal account. Keep the author stable across scheduled PRs.
git config user.name "frontaliere-automation[bot]"
git config user.email "296434481+frontaliere-automation[bot]@users.noreply.github.com"

# A stable branch lets the next scheduled run update one in-flight PR instead
# of opening an unbounded queue of equivalent data PRs. A branch left behind
# without that PR is not an in-flight snapshot: its generated files may be
# older than the current main tree. Start that run from main and replace the
# orphaned tip with a lease, rather than carrying the stale tree forward.
if [ "$RECONCILE_COMPAT" = false ] && [ -n "$REMOTE_HEAD" ]; then
  OPEN_PR="$(run_bounded "$GH_PR_TIMEOUT_SECONDS" "gh pr list stable refresh PR before reconciliation" \
    gh pr list \
    --repo "$REPOSITORY" \
    --state open \
    --base main \
    --head "$BRANCH" \
    --json number \
    --jq '.[0].number // empty')"
  if [ -z "$OPEN_PR" ]; then
    RESET_STALE_STABLE_BRANCH=true
    STALE_REMOTE_HEAD="$REMOTE_HEAD"
  fi
fi

reset_orphaned_stable_branch_to_main() {
  local main_head remote_after_failure
  run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch current main for orphaned stable branch" \
    git fetch --no-tags --depth=1 "$PUSH_URL" \
    "+refs/heads/main:refs/remotes/origin/main"
  main_head="$(git rev-parse refs/remotes/origin/main)"
  echo "No open refresh PR for ${BRANCH}; rebuilding from the current main snapshot ${main_head} instead of stale tip ${STALE_REMOTE_HEAD}."

  if run_bounded "$PUSH_TIMEOUT_SECONDS" "git push orphaned stable branch ${BRANCH} to current main snapshot" \
    git -c http.https://github.com/.extraheader= push \
    --force-with-lease="refs/heads/${BRANCH}:${STALE_REMOTE_HEAD}" \
    "$PUSH_URL" "${main_head}:${BRANCH}"; then
    echo "Synchronized ${BRANCH} with the current main snapshot ${main_head}; no refresh PR will be opened."
    return 0
  fi

  if ! remote_after_failure="$(run_bounded "$LS_REMOTE_TIMEOUT_SECONDS" "git ls-remote orphaned stable branch after lease loss" \
    git ls-remote "$PUSH_URL" "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"; then
    echo "::error::Unable to determine whether the orphaned stable branch lease was lost" >&2
    return 1
  fi
  if [ -n "$remote_after_failure" ] && [ "$remote_after_failure" != "$STALE_REMOTE_HEAD" ]; then
    echo "::notice::The orphaned stable branch lease was lost to a concurrent run; leaving tip ${remote_after_failure} untouched and skipping the refresh PR."
    return 0
  fi
  echo "::error::The orphaned stable branch still had lease ${STALE_REMOTE_HEAD}, but its reset push failed" >&2
  return 1
}

if git diff --cached --quiet; then
  if [ "$RESET_STALE_STABLE_BRANCH" = true ]; then
    reset_orphaned_stable_branch_to_main
    exit 0
  fi
  if [ "$RECONCILE_MAIN" = false ] || [ "$RECONCILE_COMPAT" = true ] || [ -z "$REMOTE_HEAD" ]; then
    echo "No refresh changes to publish."
    exit 0
  fi
  echo "No refresh changes; reconciling the pending PR with main."
else
  git commit -m "$COMMIT_MESSAGE"
  REFRESH_COMMIT="$(git rev-parse HEAD)"
  if [ "$RESET_STALE_STABLE_BRANCH" = true ]; then
    echo "No open refresh PR for ${BRANCH}; rebuilding from the current main snapshot instead of stale tip ${REMOTE_HEAD}."
  fi
fi

if [ -n "$REMOTE_HEAD" ] && [ "$RESET_STALE_STABLE_BRANCH" = false ]; then
  # The workflow checkout is intentionally shallow. The non-compat path needs
  # a filtered graph for its path-aware reconciler; compat only needs the
  # stable tip and fetches its merge base explicitly below.
  if [ "$RECONCILE_COMPAT" = true ]; then
    run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch stable refresh branch" \
      git fetch --no-tags --depth=1 "$PUSH_URL" \
      "+refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"
    check_old_history_ref "refs/remotes/refresh/${BRANCH}"
    git checkout -B "$BRANCH" "refs/remotes/refresh/${BRANCH}"
  else
    run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch stable refresh branch without blobs" \
      git fetch --no-tags --filter=tree:0 "$PUSH_URL" \
      "+refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"
    check_old_history_ref "refs/remotes/refresh/${BRANCH}"
    # Reconcile in a separate, sparse checkout. A data branch may carry old
    # crawlers/helpers; selecting it in the workflow checkout would change the
    # code used by every later step, including after a best-effort failure.
    PUBLISH_PATHS=()
    if [ -n "$REFRESH_COMMIT" ]; then
      while IFS= read -r -d '' refresh_path; do
        PUBLISH_PATHS+=("$refresh_path")
      done < <(git diff --name-only -z "$REFRESH_BASE" "$REFRESH_COMMIT")
    fi
    REFRESH_PUBLISH_WORKTREE="$MERGE_REFRESH_SCRIPT_DIR/publish"
    git worktree add --detach --no-checkout "$REFRESH_PUBLISH_WORKTREE" "$REMOTE_HEAD"
    cd "$REFRESH_PUBLISH_WORKTREE"
    if [ "${#PUBLISH_PATHS[@]}" -gt 0 ]; then
      # The article content refresh keeps destination-only cover-credit files
      # in the source checkout. Include that generated subtree in the
      # stable-branch reconciliation even when this run did not modify a
      # credit file itself, so an older stable deletion cannot win again.
      local_article_content_path='packages/articles/content'
      local_article_image_credit_path="${local_article_content_path}/image-credits"
      for refresh_path in "${PATHS[@]}"; do
        if [ "$refresh_path" = "$local_article_content_path" ]; then
          PUBLISH_PATHS+=("$local_article_image_credit_path")
          break
        fi
      done
      printf '/%s\n' "${PUBLISH_PATHS[@]}" | git sparse-checkout set --no-cone --stdin
      PATHS=("${PUBLISH_PATHS[@]}")
    else
      git sparse-checkout set --no-cone --stdin </dev/null
      PATHS=()
    fi
    git checkout --quiet
    # These are the real committed paths, already resolved through symlinks
    # by the initial stage. The sparse checkout need not include alias paths.
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
  # A depth-1 tip has no ancestry on the runner, so Git cannot prove that it
  # descends from the main this checkout already tracks and refuses an unforced
  # update as a non-fast-forward. The history guard refreshed that ref moments
  # ago, so main must move in between for it to matter; the retry below, which
  # reads a branch another run just advanced, would hit it every time.
  run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch main for compatibility reconciliation" \
    git fetch --no-tags --depth=1 "$PUSH_URL" \
    "+refs/heads/main:refs/remotes/origin/main"
  git config merge.compat-shard.driver 'node scripts/ci/merge-compat-shard.mjs %O %A %B'

  COMPAT_SHARD_ATTR="$(git check-attr merge -- data/seo-404-compat/part-00.json)"
  if [ "$COMPAT_SHARD_ATTR" != "data/seo-404-compat/part-00.json: merge: compat-shard" ]; then
    echo "::error::data/seo-404-compat shards are not assigned merge=compat-shard: ${COMPAT_SHARD_ATTR}" >&2
    exit 1
  fi

  if [ -n "$REMOTE_HEAD" ]; then
    COMPAT_REFRESH_BASE="$(compat_merge_base "$REMOTE_HEAD" "$REFRESH_BASE" "compatibility refresh compare")"
    reconcile_compat_ref "$COMPAT_REFRESH_BASE" "$REFRESH_COMMIT"
  fi
  COMPAT_MAIN_HEAD="$(git rev-parse refs/remotes/origin/main)"
  if [ "$COMPAT_MAIN_HEAD" != "$REFRESH_BASE" ]; then
    COMPAT_MAIN_BASE="$(compat_merge_base "$REFRESH_BASE" "$COMPAT_MAIN_HEAD" "compatibility main compare")"
    reconcile_compat_ref "$COMPAT_MAIN_BASE" origin/main
  fi
elif [ -n "$REMOTE_HEAD" ] && [ -n "$REFRESH_COMMIT" ] && [ "$RESET_STALE_STABLE_BRANCH" = false ]; then
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
  # PATHS here are the files of this run's own commit, listed by this helper
  # and not typed by a caller. One that the refresh deleted and the stable
  # branch never carried is neither on disk nor in this index: `git add`
  # would abort on it although nothing is left to stage.
  STAGEABLE_PATHS=()
  for refresh_path in "${PATHS[@]}"; do
    if [ -e "$refresh_path" ] || [ -L "$refresh_path" ] \
      || git ls-files --error-unmatch -- "$refresh_path" > /dev/null 2>&1; then
      STAGEABLE_PATHS+=("$refresh_path")
    fi
  done
  if [ "${#STAGEABLE_PATHS[@]}" -gt 0 ]; then
    PATHS=("${STAGEABLE_PATHS[@]}")
    stage_paths
  fi
  if git diff --cached --quiet; then
    echo "No new refresh changes after stable-branch reconciliation."
    if [ "$RECONCILE_MAIN" = false ]; then exit 0; fi
  else
    git commit -m "$COMMIT_MESSAGE"
  fi
fi

if [ "$RECONCILE_MAIN" = true ] && [ -n "$REMOTE_HEAD" ] \
  && [ "$RECONCILE_COMPAT" = false ] && [ "$RESET_STALE_STABLE_BRANCH" = false ]; then
  run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch refresh main" \
    git fetch --no-tags --depth=1 "$PUSH_URL" "+refs/heads/main:refs/remotes/refresh/main"
  MAIN_HEAD="$(git rev-parse refs/remotes/refresh/main)"
  # GitHub knows the common ancestor even when the runner has only branch
  # tips. Fetch that single tree, rather than all historical image blobs.
  MAIN_BASE="$(run_bounded "$API_TIMEOUT_SECONDS" "gh api refresh compare" \
    gh api "repos/${REPOSITORY}/compare/${MAIN_HEAD}...${REMOTE_HEAD}" --jq '.merge_base_commit.sha')"
  [ -n "$MAIN_BASE" ] && [ "$MAIN_BASE" != null ] || { echo "::error::Missing refresh/main merge base"; exit 1; }
  if [ "$MAIN_BASE" != "$MAIN_HEAD" ]; then
    if ! git cat-file -e "${MAIN_BASE}^{commit}" 2>/dev/null; then
      run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch refresh merge base" \
        git fetch --no-tags --depth=1 "$PUSH_URL" "$MAIN_BASE"
    fi
    node "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/reconcile-data-refresh-main.mjs" \
      --base "$MAIN_BASE" --main "$MAIN_HEAD" --message "$COMMIT_MESSAGE"
  fi
fi

# Publishing a stable branch that does not exist on the remote yet (issue 12262).
#
# `git push` sends every object reachable from the pushed commit that is not
# reachable from a remote branch tip this checkout also has. For a branch that
# is not there yet, the only tip that can cover the checkout commit is main,
# and only while main has not moved since this checkout last saw it. The
# workflow checkout is shallow, and the history guard above leaves it a
# treeless clone that holds main's whole commit graph as of the guard's fetch.
# One push to main between that fetch and ours and no advertised tip is a local
# commit: Git then counts the entire history as missing on the remote, and a
# treeless clone has to download it before it can send it, one lazy fetch per
# commit. The step printed its commit and went silent until the job timeout
# (runs 37678484563 and 37697864009, both with a push to main inside the
# guard's window; tests/open-data-refresh-checkout.test.ts replays it offline).
#
# So the branch is created on the remote first, at the commit this run started
# from, which the remote necessarily has. The push is then a fast-forward from
# a tip both sides know, whatever main does meanwhile, and the pack is this
# run's commits and nothing else.
REMOTE_BASE_CREATED=false

create_remote_branch_at_base() {
  local detail
  if detail="$(run_bounded "$API_TIMEOUT_SECONDS" "creating ${BRANCH} on the remote at the base commit" \
    gh api -X POST "repos/${REPOSITORY}/git/refs" \
      -f "ref=refs/heads/${BRANCH}" -f "sha=${REFRESH_BASE}" --silent 2>&1)"; then
    REMOTE_BASE_CREATED=true
    echo "Created ${BRANCH} on the remote at this run's base commit ${REFRESH_BASE}."
    return 0
  fi
  # Not fatal by itself. Another run may have created the branch a moment ago
  # (the push below then loses to it and the loop reconciles), or the API may
  # be unavailable. The push still cannot hang: see push_new_stable_branch.
  echo "::warning::${BRANCH} could not be created on the remote at this run's base commit before the push: $(printf '%s' "$detail" | tr '\n' ' ' | cut -c1-300)"
}

push_new_stable_branch() {
  if [ "$REMOTE_BASE_CREATED" = false ]; then
    create_remote_branch_at_base
  fi
  if [ "$RECONCILE_COMPAT" = true ]; then
    # The compat publish carries main's tree into the branch, so its commits
    # can reference objects this checkout was only promised. The base above
    # already bounds what is sent to the commits since this run's checkout.
    run_bounded "$PUSH_TIMEOUT_SECONDS" "git push of the new stable branch ${BRANCH}" \
      git -c http.https://github.com/.extraheader= push "$PUSH_URL" "HEAD:${BRANCH}"
    return
  fi
  # Everything this push sends was written by this run, so it never needs to
  # download an object. With lazy fetch off, a push that finds no common base
  # after all stops at the first object it lacks instead of fetching history.
  run_bounded "$PUSH_TIMEOUT_SECONDS" "git push of the new stable branch ${BRANCH}" \
    env GIT_NO_LAZY_FETCH=1 \
    git -c http.https://github.com/.extraheader= push "$PUSH_URL" "HEAD:${BRANCH}"
}

# A base this run created and never moved is not a refresh: leaving it would
# make the next run reconcile on top of an empty branch. The deletion carries a
# lease on the base commit, so the remote itself refuses it when another run
# has advanced the branch: reading the tip first and deleting afterwards would
# remove that run's refresh in between. A deletion sends no objects.
remove_unused_remote_base() {
  [ "$REMOTE_BASE_CREATED" = true ] || return 0
  if run_bounded "$PUSH_TIMEOUT_SECONDS" "git push that removes the unused base of ${BRANCH}" \
    git -c http.https://github.com/.extraheader= push \
    --force-with-lease="refs/heads/${BRANCH}:${REFRESH_BASE}" \
    "$PUSH_URL" ":refs/heads/${BRANCH}"; then
    echo "Removed ${BRANCH} from the remote: it still pointed at this run's base commit and carried no refresh."
  else
    echo "::warning::${BRANCH} was not removed from the remote: it no longer points at this run's base commit ${REFRESH_BASE}, or the deletion failed; the next run reconciles on top of what is there"
  fi
}

# A stable branch is intentionally shared by concurrent refreshes. The first
# push may therefore lose the lease after the branch was reconciled above. A
# bounded retry must rebuild the local branch from the newest remote tip before
# trying again; retrying the same rejected commit would either drop the other
# run or keep failing forever.
MAX_PUSH_ATTEMPTS=3
push_attempt=1
while :; do
  push_succeeded=false
  if [ -n "$REMOTE_HEAD" ]; then
    if run_bounded "$PUSH_TIMEOUT_SECONDS" "git push over the stable branch ${BRANCH}" \
      git -c http.https://github.com/.extraheader= push \
      --force-with-lease="refs/heads/${BRANCH}:${REMOTE_HEAD}" \
      "$PUSH_URL" "HEAD:${BRANCH}"; then
      push_succeeded=true
    fi
  elif push_new_stable_branch; then
    push_succeeded=true
  fi

  if [ "$push_succeeded" = true ]; then
    break
  fi
  if [ "$push_attempt" -ge "$MAX_PUSH_ATTEMPTS" ]; then
    remove_unused_remote_base
    echo "::error::stable refresh branch push failed after ${MAX_PUSH_ATTEMPTS} bounded attempts" >&2
    exit 1
  fi

  if [ -n "$REMOTE_HEAD" ]; then
    echo "::warning::stable refresh branch moved during push attempt ${push_attempt}/${MAX_PUSH_ATTEMPTS}; reconciling the newest remote tip"
  else
    echo "::warning::push of the new stable refresh branch failed on attempt ${push_attempt}/${MAX_PUSH_ATTEMPTS}; reading the remote again before the next one"
  fi
  push_attempt=$((push_attempt + 1))
  sleep "$((push_attempt - 1))"
  REMOTE_HEAD="$(run_bounded "$LS_REMOTE_TIMEOUT_SECONDS" "git ls-remote stable refresh branch retry" \
    git ls-remote "$PUSH_URL" "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"
  if [ "$RESET_STALE_STABLE_BRANCH" = true ] && [ -n "$REMOTE_HEAD" ] \
    && [ "$REMOTE_HEAD" != "$STALE_REMOTE_HEAD" ]; then
    # A concurrent run won the orphan reset lease. Preserve its newer stable
    # tree on the bounded retry, just as for an ordinary pending PR.
    RESET_STALE_STABLE_BRANCH=false
  fi
  if [ "$REMOTE_BASE_CREATED" = true ]; then
    if [ "$REMOTE_HEAD" = "$REFRESH_BASE" ]; then
      # Still the base this run created: no other run wrote to the branch, so
      # there is nothing to reconcile and the same commit is pushed again.
      REMOTE_HEAD=""
    elif [ -z "$REMOTE_HEAD" ]; then
      # The base is gone (an empty branch is fair game for a cleanup): the next
      # attempt must create it again, or it would push with no common base.
      REMOTE_BASE_CREATED=false
    fi
  fi

  if [ "$RESET_STALE_STABLE_BRANCH" = true ] && [ -n "$REMOTE_HEAD" ] \
    && [ "$REMOTE_HEAD" = "$STALE_REMOTE_HEAD" ]; then
    # The orphan reset must never read the same stale tip as a merge base.
    # Retry the current run's main-based commit with the original lease.
    continue
  fi

  if [ -n "$REMOTE_HEAD" ]; then
    if [ "$RECONCILE_COMPAT" = true ]; then
      # Compat names its merge bases: the newest tip is all it reads. Forced
      # for the same reason as main above.
      run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch newest stable refresh branch" \
        git fetch --no-tags --depth=1 "$PUSH_URL" \
        "+refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"
      check_old_history_ref "refs/remotes/refresh/${BRANCH}"
      # The tree-level reconciliation moved HEAD and the index, not the files.
      # Everything this run produced is in REFRESH_COMMIT, so nothing is lost.
      git checkout --force -B "$BRANCH" "refs/remotes/refresh/${BRANCH}"
    else
      run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch newest stable refresh branch" \
        git fetch --no-tags "$PUSH_URL" \
        "refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"
      check_old_history_ref "refs/remotes/refresh/${BRANCH}"
      git checkout -B "$BRANCH" "refs/remotes/refresh/${BRANCH}"
    fi

    if [ "$RECONCILE_COMPAT" = true ]; then
      # Re-read main as well: the stable branch race can overlap a new 404
      # sweep, and the compatibility merge must retain the newest main base.
      run_bounded "$FETCH_TIMEOUT_SECONDS" "git fetch newest main for compatibility reconciliation" \
        git fetch --no-tags --depth=1 "$PUSH_URL" \
        "+refs/heads/main:refs/remotes/origin/main"
      COMPAT_REFRESH_BASE="$(compat_merge_base "$REMOTE_HEAD" "$REFRESH_BASE" "newest compatibility refresh compare")"
      reconcile_compat_ref "$COMPAT_REFRESH_BASE" "$REFRESH_COMMIT"
      COMPAT_MAIN_HEAD="$(git rev-parse refs/remotes/origin/main)"
      if [ "$COMPAT_MAIN_HEAD" != "$REFRESH_BASE" ]; then
        COMPAT_MAIN_BASE="$(compat_merge_base "$REFRESH_BASE" "$COMPAT_MAIN_HEAD" "newest compatibility main compare")"
        reconcile_compat_ref "$COMPAT_MAIN_BASE" origin/main
      fi
    else
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
        echo "No new refresh changes after the concurrent stable-branch update."
        break
      fi
      git commit -m "$COMMIT_MESSAGE"
    fi
  else
    # The branch may have been closed and deleted between attempts. Recreate it
    # from this run's immutable refresh commit and let the next push establish
    # the stable ref again.
    git checkout -B "$BRANCH" "$REFRESH_COMMIT"
  fi
done

OPEN_PR="$(run_bounded "$GH_PR_TIMEOUT_SECONDS" "gh pr list stable refresh PR" \
  gh pr list \
  --repo "$REPOSITORY" \
  --state open \
  --base main \
  --head "$BRANCH" \
  --json number \
  --jq '.[0].number // empty')"

if [ -n "$OPEN_PR" ]; then
  # Keep the body linked to the latest successful refresh run when the stable
  # branch already has an open PR. The branch update above re-triggers tests.
  run_bounded "$GH_PR_TIMEOUT_SECONDS" "gh pr edit stable refresh PR" \
    gh pr edit "$OPEN_PR" --repo "$REPOSITORY" --title "$TITLE" --body-file "$BODY_FILE"
  echo "Updated refresh PR #$OPEN_PR"
  exit 0
fi

run_bounded "$GH_PR_TIMEOUT_SECONDS" "gh pr create stable refresh PR" \
  gh pr create \
  --repo "$REPOSITORY" \
  --base main \
  --head "$BRANCH" \
  --title "$TITLE" \
  --body-file "$BODY_FILE"
