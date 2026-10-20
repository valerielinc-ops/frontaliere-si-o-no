#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/git-commit-data.sh — Centralised git commit+push for job crawlers
#
# Usage:
#   bash scripts/lib/git-commit-data.sh "commit message" [extra-paths ...]
#   bash scripts/lib/git-commit-data.sh --slice-only "commit message" [extra-paths ...]
#   bash scripts/lib/git-commit-data.sh --extra-only "commit message" [extra-paths ...]
#
# --slice-only mode:
#   Only commits per-crawler slice files (data/jobs/by-crawler/,
#   data/jobs-crawler-summaries/by-crawler/) and extra paths.
#   Skips shared monolithic files (data/jobs.json, stats, meta, etc.),
#   eliminating merge conflicts when multiple crawlers run concurrently.
#   Assembly of shared files happens in the deploy pipeline instead.
#
# Extra paths are appended to the standard file list (e.g. data/jobs-crawler-adapters/).
#
# GitHub Actions outputs (via $GITHUB_OUTPUT):
#   has_changes=true|false   — whether any data files were modified
#
# Optional translation-pipeline mode:
#   TRANSLATION_STATS_AFTER_TREE=1 — materialise the private-index candidate
#   tree, run `log-translation-stats.mjs after` against those slices, and stage
#   the resulting history blob before commit-tree. This deliberately does not
#   advance the checkout ref or worktree.
#
# Exit codes:
#   0  — success (committed+pushed, or nothing to commit)
#   1  — push still failing after retries for a NON-contention reason
#        (network outage, auth failure, hook decline, ...) — must stay a
#        red step, never silently absorbed
#   42 — PUSH_CONTENTION_EXHAUSTED: retries exhausted AND the LAST push
#        failure was a ref rejection/race (output matched rejected /
#        fetch first / cannot lock ref / non-fast-forward). Only this
#        class is safe for callers to treat as "self-heals next run".
#   43 — GROUP_SHARED_PRECONDITION: the CRAWLER_GROUP_DEFER_COMMIT branch
#        could not run at all. That branch pushes nothing — it only writes
#        this crawler's descriptor for the group's single atomic commit —
#        so every one of its failures is a property of the SHARED job
#        environment (missing CRAWLER_GENERATION_TOKEN, unwritable receipt
#        dir, a generator that emitted the wrong invocation), never of the
#        calling crawler. Every sibling in the same group hits it in the
#        same run: measured on corpus run 33585044260, where 27 of 27
#        crawler steps failed with "could not persist its commit
#        descriptor" after all 27 crawls had SUCCEEDED, and each one then
#        filed its own `Crawler Failure: Run <slug>` issue (site #6857,
#        #6953 are two of them). Callers must keep the step RED — the run
#        must stay a failure so the corpus' central scan-failed-runs.mjs
#        opens ONE `Workflow Failure: <group>` issue — but must NOT file a
#        per-crawler issue: the crawler is not what broke. Distinct from 1
#        so a real per-crawler commit failure keeps its own report.
#        A receipt process killed by a signal reports the conventional shell
#        status 128+signal; defer mode normalizes that status to 43 for the
#        same shared-precondition carve-out while keeping the outer step red.
#   44 — GLOBAL_DATA_PIPELINE_LEASE_BUSY: the bounded cross-repository writer
#        queue stayed occupied. Grouped callers return this to the generated
#        workflow as a retryable systemic outcome; sequential callers stop
#        cleanly without pretending that data was committed.
#   45 — GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR: the lease service produced
#        the bounded number of consecutive transient errors. This is a real
#        coordination-service failure, not a queue outcome: callers must keep
#        the workflow red and must not retry the same generation.
#   46 — CRAWLER_GENERATION_RECEIPT_FAILURE: a grouped batch published or
#        confirmed its data tree but could not write the delivery receipts.
#        The generated group workflow retries the same generation token; if the
#        bounded retry is exhausted, the workflow stays red rather than
#        reporting a green generation with missing delivery evidence.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOUNDED_COMMAND_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-bounded-command.mjs"
MAIN_PUSH_GUARD_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-push-guard.mjs"

# The fetch ceiling is supported by issue 12175's 61.6, 62.6, 83.0 and
# 95.1-second commit-graph measurements. The pull ceiling has no direct
# measurement; the push ceiling follows the 180-second refresh policy already
# in use. These GIT_COMMIT_DATA_* overrides are only for the test bench;
# production keeps the declared defaults.
#
# Retirement history is resolved through the GitHub Commits API when the local
# checkout is shallow. That keeps the answer independent of the 31.44 GiB of
# reachable blobs on origin/main (124,981 commits, measured on 2026-10-08).
# This is a safety ceiling for one metadata lookup, not a latency target: an
# unavailable or malformed response fails closed instead of guessing.
GIT_COMMIT_DATA_FETCH_TIMEOUT_SECONDS="${GIT_COMMIT_DATA_FETCH_TIMEOUT_SECONDS:-300}"
GIT_COMMIT_DATA_HISTORY_LOOKUP_TIMEOUT_SECONDS="${GIT_COMMIT_DATA_HISTORY_LOOKUP_TIMEOUT_SECONDS:-60}"
GIT_COMMIT_DATA_PULL_TIMEOUT_SECONDS="${GIT_COMMIT_DATA_PULL_TIMEOUT_SECONDS:-300}"
GIT_COMMIT_DATA_PUSH_TIMEOUT_SECONDS="${GIT_COMMIT_DATA_PUSH_TIMEOUT_SECONDS:-180}"
# Candidate inspection is a bounded safety operation of its own. Keep its
# ceiling independent from the network-push ceiling: a slow tree/ancestry
# proof must not consume the entire push budget before the guarded write starts.
GIT_COMMIT_DATA_PUSH_GUARD_TIMEOUT_SECONDS="${GIT_COMMIT_DATA_PUSH_GUARD_TIMEOUT_SECONDS:-180}"
# The ownership archive used to run inside the cross-repository lease. Real
# grouped-isolated attempts measured 66.8–169.0 s fetching 56–612 missing
# slice blobs on demand (2026-10-09). Prepare it before the lease, then bound
# that one-time materialization independently of the push timeout.
GIT_COMMIT_DATA_OWNERSHIP_VIEW_TIMEOUT_SECONDS="${GIT_COMMIT_DATA_OWNERSHIP_VIEW_TIMEOUT_SECONDS:-300}"

run_bounded() {
  local seconds="$1" label="$2"
  shift 2
  node "$BOUNDED_COMMAND_SCRIPT" --timeout-seconds "$seconds" --label "$label" -- "$@"
}

main_push_guard_check() {
  local base_sha="$1" candidate_sha="$2" timeout_seconds="$3"
  node "$MAIN_PUSH_GUARD_SCRIPT" \
    --repo "$PWD" \
    --base "$base_sha" \
    --candidate "$candidate_sha" \
    --branch main \
    --timeout-seconds "$timeout_seconds" \
    --check-only
}

guarded_push_deadline() {
  # Bash SECONDS is process-relative and monotonic; wall-clock date can jump
  # backwards while a guarded write is spending its end-to-end budget.
  printf '%s\n' "$(( SECONDS + GIT_COMMIT_DATA_PUSH_TIMEOUT_SECONDS ))"
}

guarded_push_remaining_seconds() {
  local deadline="$1"
  local remaining=$(( deadline - SECONDS ))
  if [ "$remaining" -le 0 ]; then
    echo "❌ main push guard: end-to-end deadline expired before the guarded push" >&2
    return 1
  fi
  printf '%s\n' "$remaining"
}

# Register the seo-404 compat-shard merge driver (.gitattributes
# `merge=compat-shard`) so concurrent rebases of data/seo-404-compat/part-*.json
# auto-resolve as a 3-way SET merge (deduped + sorted) instead of git's default
# line merge keeping both sorted rewrites → ~2x duplicate shards (issue #2988
# follow-up). Local config, idempotent; harmless if the files aren't touched.
git config merge.compat-shard.driver 'node scripts/ci/merge-compat-shard.mjs %O %A %B' || true

# Same registration for the canonical slug-registry shards
# (.gitattributes `merge=known-slugs-shard`, data/all-known-job-slugs/part-*.json,
# issue #4248): a 3-way MAP merge instead of git's default line merge, which on
# a re-serialised sorted JSON OBJECT produces duplicate keys rather than bloat.
git config merge.known-slugs-shard.driver 'node scripts/ci/merge-known-slugs-shard.mjs %O %A %B' || true

# Same registration for the enriched-orphan ledger shards
# (.gitattributes `merge=orphan-enriched-shard`, data/orphan-enriched-data/part-*.json,
# issue #4248): a 3-way merge on the record set keyed by (locale, slug) instead
# of git's default line merge, which on a re-serialised sorted JSON ARRAY
# produces duplicate records rather than bloat alone.
git config merge.orphan-enriched-shard.driver 'node scripts/ci/merge-orphan-enriched-shard.mjs %O %A %B' || true

# Same registration for monthly job stats history shards
# (.gitattributes `merge=job-stats-history-shard`).
git config merge.job-stats-history-shard.driver 'node scripts/ci/merge-job-stats-history-shard.mjs %O %A %B' || true
# ── Clear orphaned .git/index.lock left by a crashed prior git operation ────
# In the grouped crawler-group-*.yml workflows (post-#3701 consolidation),
# every crawler in a group runs as a concurrent `background: true` step
# sharing ONE job's working directory and ONE `.git`. Each crawler's
# commit-and-push invocation of THIS script is wrapped by the callsite in
# `flock /tmp/crawler-group-git.lock -c '... git-commit-data.sh ...'`
# (scripts/generate-crawler-group-workflows.mjs), so only one crawler's git
# operations run at a time within a group.
#
# That flock guarantees serialization of live processes, but it does NOT
# guarantee a clean `.git/index.lock` file: git creates that file at the
# start of an index-mutating operation (add/commit/stash/...) and removes it
# on normal completion. If the process holding the flock is killed mid
# operation (OOM, step timeout, runner termination), the flock itself is
# released automatically by the kernel (flocks are tied to the process/fd,
# not to explicit cleanup) — but `.git/index.lock` is a plain file with no
# such lifecycle binding, so it survives the crash and is NEVER cleaned up.
# Every subsequent crawler that then acquires the (now-free) flock and tries
# a git operation hits git's own guard ("Another git process seems to be
# running... fatal: Unable to create '.../.git/index.lock': File exists")
# and fails too — a cascading failure across the rest of the group, even
# though each of those later crawlers did nothing wrong themselves.
#
# It is safe to remove `.git/index.lock` unconditionally here: by
# construction, this line only ever executes while we hold
# /tmp/crawler-group-git.lock, so no OTHER live process in this job can
# legitimately be mid-git-operation right now. Any index.lock still present
# at this point can only be a leftover from a previous holder that crashed
# without cleaning up after itself — never a real concurrent lock. Doing
# this unconditionally at the very start of every invocation (rather than
# reactively after a failure) is cheap (a single stat+unlink) and correct
# under the flock invariant on every call, including the very first crawler
# in a fresh job (where the file simply won't exist and `rm -f` is a no-op).
if [ -f ".git/index.lock" ]; then
  echo "⚠️ Found stale .git/index.lock (leftover from a crashed prior git operation in this group) — removing before proceeding."
  rm -f ".git/index.lock"
fi

# ── Parse commit mode ────────────────────────────────────────────────────────
SLICE_ONLY=false
GROUP_BATCH=false
EXTRA_ONLY=false
# Set to true (below) only for grouped crawler-group invocations, which share
# one working copy across ~25 concurrent sibling crawlers and therefore must
# never mutate the shared worktree/index while committing.
GROUPED_ISOLATED=false
CRAWLER_GENERATION_RECEIPT_FAILURE_EXIT=46
if [ "${1:-}" = "--extra-only" ]; then
  EXTRA_ONLY=true
  SLICE_ONLY=true
  GROUPED_ISOLATED=true
  shift
elif [ "${1:-}" = "--group-batch" ]; then
  GROUP_BATCH=true
  SLICE_ONLY=true
  GROUPED_ISOLATED=true
  shift
elif [ "${1:-}" = "--slice-only" ]; then
  SLICE_ONLY=true
  shift
fi

COMMIT_MSG="${1:?Usage: git-commit-data.sh [--slice-only|--group-batch] 'commit message' [extra-paths...]}"
shift
EXTRA_PATHS=("$@")

# ── Append GitHub Actions run URL to commit message for traceability ─────────
if [ -n "${GITHUB_RUN_ID:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  COMMIT_MSG="${COMMIT_MSG}

Run: ${RUN_URL}"
fi

# ── Append previousSlugs delta attribution from slug-history-journal ─────────
# The journal module (scripts/lib/slug-history-journal.mjs) auto-registers a
# process.on('exit') hook that writes a one-shot summary to a temp file. We
# read it here and append to the commit message body, then unlink — zero
# on-disk footprint, full attribution in the commit history.
SLUG_HISTORY_SUMMARY_FILE="${SLUG_HISTORY_SUMMARY_FILE:-}"
if [ -z "$SLUG_HISTORY_SUMMARY_FILE" ]; then
  # Glob the default pattern (per-pid). Pick the newest if multiple exist.
  SLUG_HISTORY_SUMMARY_FILE=$(ls -t /tmp/slug-history-summary-*.txt 2>/dev/null | head -1 || true)
fi
if [ -n "$SLUG_HISTORY_SUMMARY_FILE" ] && [ -s "$SLUG_HISTORY_SUMMARY_FILE" ]; then
  SLUG_HISTORY_BODY=$(cat "$SLUG_HISTORY_SUMMARY_FILE")
  COMMIT_MSG="${COMMIT_MSG}

${SLUG_HISTORY_BODY}"
  rm -f "$SLUG_HISTORY_SUMMARY_FILE" || true
fi

# ── Standard data files committed by every crawler ──────────────────────────
if [ "$EXTRA_ONLY" = true ]; then
  STANDARD_FILES=()
elif [ "$GROUP_BATCH" = true ]; then
  # Paths are loaded below from the successful crawlers' immutable descriptors.
  # Keeping this list empty is load-bearing: the batch must never sweep a
  # failed sibling's partial files merely because they remain dirty in the
  # shared worktree.
  STANDARD_FILES=()
elif [ "$SLICE_ONLY" = true ]; then
  # Slice-only mode: only commit per-crawler slice files.
  # Shared monolithic files are assembled during deploy, not per-crawler.
  #
  # Crawler-group workflows run ~25 sibling crawlers concurrently against ONE
  # shared checkout (#3701). A bare directory glob here would `git add` (and
  # 3-way-merge) every sibling's currently-modified slice too — not just this
  # invocation's own — misattributing their data under this crawler's commit.
  # Confirmed live: run 28852047487 committed 5 siblings' slices (lindt-
  # spruengli, sonarsource, stadt-luzern, usz, vista) under "Auto-update
  # SPITEX BASEL jobs". The group workflow generator already exports
  # JOBS_SLICE_FILE (this crawler's own slice path) for the crawler's own
  # pipeline; reuse it to scope staging to exactly this crawler's own files.
  #
  # The AI cache is intentionally absent below. It is a local runner cache, not
  # a crawler-owned slice, and is restored/saved through Actions cache instead
  # of being published in a data commit.
  # Falls back to the old directory-wide behavior when unset (non-grouped
  # callers, e.g. translate-pending.yml, which legitimately touches every
  # crawler's slice in one sequential job).
  if [ -n "${JOBS_SLICE_FILE:-}" ]; then
    SLICE_BASENAME="$(basename "$JOBS_SLICE_FILE")"
    STANDARD_FILES=(
      "data/jobs/by-crawler/${SLICE_BASENAME}"
      "data/jobs/expired/by-crawler/${SLICE_BASENAME}"
      "data/jobs-crawler-summaries/by-crawler/${SLICE_BASENAME}"
    )
    # SLICE_ONLY + JOBS_SLICE_FILE set ⇔ this invocation comes from a grouped
    # crawler-group-*.yml background step sharing ONE checkout with ~25
    # concurrently-running sibling crawlers (the generator exports
    # JOBS_SLICE_FILE at step level; standalone/sequential callers like
    # translate-pending.yml don't). In that shared workspace the legacy
    # stash→rebase→pop sync below is DESTRUCTIVE: `git stash
    # --include-untracked` sweeps up every sibling's not-yet-committed dirty
    # file, and when the pop conflicts (routine here — siblings keep writing
    # while we hold the flock), restore_stashed_changes_with_safe_merge()
    # restores only THIS crawler's RESOLVED_FILES from its snapshot and then
    # `git stash drop`s everything else — silently reverting sibling slices
    # to HEAD. Their later commit step then sees "no changes" and their data
    # is lost until the next scheduled run (confirmed live post-#3701:
    # commit d2a7e49e "Auto-update EMS-Chemie" pushed only a sibling's
    # adapter file while EMS's own freshly-crawled slice had been wiped from
    # the worktree by an earlier sibling's stash cycle). Use the
    # worktree-immutable plumbing commit path instead (see
    # commit_isolated_from_worktree below).
    GROUPED_ISOLATED=true
  else
    STANDARD_FILES=(
      data/jobs/by-crawler/
      data/jobs/expired/by-crawler/
      data/jobs-crawler-summaries/by-crawler/
    )
    # Sequential callers (e.g. translate-pending.yml, cleanup-stale-jobs.yml,
    # backfill-expired-from-history.yml) also use the isolated commit path (git
    # plumbing, no stash/rebase) so concurrent crawler pushes to main no longer
    # cause multi-hour retry storms that exhaust MAX_PUSH_ATTEMPTS and fail the
    # workflow (issue #4157). The isolated path rebuilds the commit tree
    # atomically from origin/main on every retry — the same approach used by
    # grouped crawlers. Safe here because these callers are sequential: no
    # sibling writers share the checkout, so the stable-base_sha invariant (that
    # prevents grouped crawlers from accidentally 3-way-merging a sibling's
    # not-yet-committed worktree changes as their own merge base) does not apply.
    GROUPED_ISOLATED=true
  fi
else
  # Legacy mode: commit all shared files (used by non-migrated crawlers).
  STANDARD_FILES=(
    data/jobs.json
    data/jobs-meta.json
    data/jobs-crawler-summaries.json
    data/jobs-crawler-config.json
    data/ticino-companies-extra.json
    # Per-crawler slice directories (written by migrated crawlers, assembled into
    # the global artifacts above). Directories are expanded to tracked+local files
    # by expand_path_to_files() so new slices are picked up automatically.
    data/jobs/by-crawler/
    data/jobs-crawler-summaries/by-crawler/
  )
  # Optional: generated by orchestrator, may not exist in all workflows (e.g. newsletter-qa)
  if [ -f "data/jobs-crawler-audit.json" ]; then
    STANDARD_FILES+=(data/jobs-crawler-audit.json)
  fi
fi
ALL_FILES=("${STANDARD_FILES[@]}")
if [ "${#EXTRA_PATHS[@]}" -gt 0 ]; then
  ALL_FILES+=("${EXTRA_PATHS[@]}")
fi

# A grouped crawler shares its checkout with every sibling. Directory-valued
# extras (most commonly data/jobs-crawler-adapters/) therefore describe the
# union of every concurrent writer, not this crawler's ownership: recording
# that live directory diff in one successful descriptor could sweep a failed
# sibling's partial output into the group commit. Defer mode keeps only the
# exact per-crawler standard files plus explicit file extras.
#
# This exclusion is safe by construction, not a data-loss gap: no crawler
# group run writes data/jobs-crawler-adapters/registry.json or _meta.json.
# Those two files have their own dedicated commit paths, neither of which
# runs inside a grouped-batch worktree: scripts/manage-company-adapter.mjs is
# committed by the standalone "Commit and push" step in
# .github/workflows/manage-company-adapter.yml, and
# scripts/generate-company-adapter-stubs.mjs is invoked manually via
# scripts/scaffold-crawler.mjs, landing in an ordinary scaffolding PR.
if [ "${CRAWLER_GROUP_DEFER_COMMIT:-0}" = "1" ]; then
  ALL_FILES=()
  for path_item in "${STANDARD_FILES[@]}"; do
    ALL_FILES+=("$path_item")
  done
  for path_item in "${EXTRA_PATHS[@]}"; do
    normalized_path="${path_item%/}"
    if [[ "$path_item" == */ ]] || [[ -d "$normalized_path" ]]; then
      continue
    fi
    ALL_FILES+=("$path_item")
  done
fi

# Resolve input paths to concrete files for snapshot/rebase-merge logic.
# Extra paths may include directories (e.g. data/jobs-crawler-adapters/).
# Directory paths are valid for `git add`, but not for `git show "$sha:$path"`
# where a tree object would break redirection.
declare -A _SEEN_RESOLVED_FILES=()
RESOLVED_FILES=()
declare -A _BATCH_SNAPSHOT_OPERATION=()
declare -A _BATCH_SNAPSHOT_STATE=()
declare -A _BATCH_SNAPSHOT_MODE=()
declare -A _BATCH_SNAPSHOT_BASE_BLOB=()
declare -A _BATCH_SNAPSHOT_BLOB=()
# Per-file result of the isolated-commit loop, reused by the NEXT push attempt
# when the inputs of that file are unchanged (see commit_isolated_from_worktree).
declare -A _ISOLATED_RESULT_KEY=()
declare -A _ISOLATED_RESULT_BLOB=()
declare -A _ISOLATED_RESULT_OWNED_BLOB=()

# Remote absence is not proof that a primary slice was retired. The generated
# roster is the positive registry: only paths absent from primarySlices may use
# the established delete-wins behavior below.
#
# Cached per roster_file for the lifetime of this script process (issue #7151
# item 3): the sequential path calls this once per data/jobs/by-crawler/*.json
# file whose remote_blob came back empty, and every one of those calls was
# re-spawning a fresh `node` process to re-read and re-validate (schema +
# digest rebuild) the SAME roster file — unchanged across the whole run, since
# nothing in this script writes to it. Parse+validate once per roster_file,
# then answer membership from the cached path list with a plain `grep`
# (sub-millisecond, no process spawn). A validation failure is cached too, so
# a corrupt/unreadable roster still fails closed on every call (exit 2)
# without re-attempting the parse.
declare -A _PRIMARY_SLICE_ROSTER_STATUS=()
declare -A _PRIMARY_SLICE_ROSTER_PATHS=()

is_registered_primary_slice() {
  local slice_path="$1"
  local roster_file contract_file roster_paths
  roster_file="${CRAWLER_GENERATION_ROSTER_FILE:-$(dirname "$0")/../ci/crawler-generation-roster.json}"
  contract_file="$(dirname "$0")/crawler-generation-contract.mjs"

  if [ -z "${_PRIMARY_SLICE_ROSTER_STATUS[$roster_file]:-}" ]; then
    if roster_paths="$(node --input-type=module - "$roster_file" "$contract_file" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [rosterFile, contractFile] = process.argv.slice(2);
try {
  const roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
  const { validateCrawlerGenerationRoster } = await import(pathToFileURL(path.resolve(contractFile)).href);
  const validation = validateCrawlerGenerationRoster(roster);
  if (!validation.valid) throw new Error(validation.errors.join(', '));
  process.stdout.write(Object.values(roster.primarySlices).join('\n'));
} catch (error) {
  console.error(`❌ grouped-isolated: cannot validate primary slice registry ${rosterFile}: ${error.message}`);
  process.exit(2);
}
NODE
    )"; then
      _PRIMARY_SLICE_ROSTER_STATUS[$roster_file]="ok"
      _PRIMARY_SLICE_ROSTER_PATHS[$roster_file]="$roster_paths"
    else
      _PRIMARY_SLICE_ROSTER_STATUS[$roster_file]="error"
    fi
  fi

  if [ "${_PRIMARY_SLICE_ROSTER_STATUS[$roster_file]}" = "error" ]; then
    return 2
  fi

  printf '%s\n' "${_PRIMARY_SLICE_ROSTER_PATHS[$roster_file]}" | grep -Fxq -- "$slice_path"
}

# Crawler-group workflows checkout with `fetch-depth: 50` (e.g.
# .github/workflows/crawler-group-01-logic.yml:72), so `git log` only sees
# the last 50 reachable commits. Beyond that boundary git truncates silently
# — exit 0, empty output — indistinguishable from a path that never existed.
# The local log remains the cheap fast path. Only an empty result on a shallow
# checkout reaches this lookup, which asks GitHub for one commit matching the
# path without downloading any history blob. Return statuses are deliberately
# tri-state: 0 means "history exists", 1 means "never committed", and 2 means
# "the proof was unavailable". Callers must fail closed on status 2.
lookup_remote_path_history() {
  local slice_path="$1"
  local remote_sha="${2:-}"
  local history_repo history_credential history_count
  history_repo="${GH_REPO:-${GITHUB_REPOSITORY:-}}"
  history_credential="${GH_TOKEN-}"
  if [ -z "$history_credential" ]; then
    history_credential="${GITHUB_TOKEN-}"
  fi

  if [ -z "$history_repo" ] || [ -z "$history_credential" ] || [ -z "$remote_sha" ]; then
    echo "❌ grouped-isolated: cannot verify retirement history for $slice_path — repository, credential and the captured remote SHA are required for the bounded lookup"
    return 2
  fi

  # Refresh the explicit push credential before this network operation too;
  # the API token is supplied by the workflow environment and is never printed.
  if ! ensure_git_auth; then
    echo "❌ grouped-isolated: cannot refresh git authentication before the history lookup for $slice_path — refusing to guess"
    return 2
  fi
  if ! history_count="$(run_bounded "$GIT_COMMIT_DATA_HISTORY_LOOKUP_TIMEOUT_SECONDS" "gh api commits path lookup" \
    gh api --method GET "repos/${history_repo}/commits" \
      -f sha="$remote_sha" -f path="$slice_path" -f per_page=1 \
      --jq 'if type == "array" then length else error("expected an array") end')"; then
    echo "❌ grouped-isolated: GitHub history lookup failed for $slice_path — refusing to guess between first-run create and resurrection"
    return 2
  fi

  case "$history_count" in
    0) return 1 ;;
    ''|*[!0-9]*)
      echo "❌ grouped-isolated: GitHub history lookup returned an invalid result for $slice_path — refusing to guess"
      return 2
      ;;
    *) return 0 ;;
  esac
}

append_resolved_file() {
  local file_path="$1"
  [ -n "$file_path" ] || return 0
  [[ -d "$file_path" ]] && return 0
  if [ -n "${_SEEN_RESOLVED_FILES[$file_path]:-}" ]; then
    return 0
  fi
  _SEEN_RESOLVED_FILES["$file_path"]=1
  RESOLVED_FILES+=("$file_path")
}

expand_path_to_files() {
  local raw_path="$1"
  local normalized_path="${raw_path%/}"

  if [[ "$raw_path" == */ ]] || [[ -d "$normalized_path" ]]; then
    # Only files that actually differ from HEAD (modified/staged) or are new
    # (untracked) belong here — an unmodified tracked file is already
    # identical on origin/main, so re-hashing/re-snapshotting it changes
    # nothing (the grouped-isolated path below seeds its private index
    # straight from origin/main via `read-tree`; unmentioned files stay as-is
    # by construction). Walking EVERY tracked+local file in a large shared
    # directory (e.g. data/jobs/by-crawler/, 500+ files) via `git ls-files` +
    # `find` — on every one of up to MAX_PUSH_ATTEMPTS retries under push
    # contention — is pure waste for callers whose EXTRA_PATHS never touch
    # these directories at all (sync-gsc-orphans.mjs only writes its own
    # orphan-specific files: each retry cycle still paid ~2.5min hashing
    # ~1850 untouched files, blowing the 30min job budget, issue #4698).
    while IFS= read -r changed; do
      [ -n "$changed" ] || continue
      append_resolved_file "$changed"
    done < <(git diff --name-only HEAD -- "$normalized_path" 2>/dev/null || true)

    while IFS= read -r untracked; do
      [ -n "$untracked" ] || continue
      append_resolved_file "$untracked"
    done < <(git ls-files --others --exclude-standard "$normalized_path" 2>/dev/null || true)
    return 0
  fi

  append_resolved_file "$raw_path"
}

for path_item in "${ALL_FILES[@]}"; do
  expand_path_to_files "$path_item"
done

# Single source of truth for the job-slice path globs (#7167). Bash case
# statements can't alternate patterns through a `|`-joined variable
# expansion (the literal `|` becomes part of the glob instead of splitting
# into alternatives), so the delete-vs-stale-modify guard exemption below
# and its siblings match through this loop instead of repeating the
# case-pattern literal at each call site.
JOBS_SLICE_PATH_GLOBS=("data/jobs/by-crawler/*.json" "data/jobs/expired/by-crawler/*.json")

is_job_slice_path() {
  local path="$1" glob
  for glob in "${JOBS_SLICE_PATH_GLOBS[@]}"; do
    if [[ "$path" == $glob ]]; then
      return 0
    fi
  done
  return 1
}

# cleanup-jobs.mjs writes definitive URL evidence outside the checkout. Keep
# the lookup deterministic across the cleanup and isolated-commit processes,
# while allowing tests and callers to provide an explicit runner-local root.
housekeeping_proof_path_for_file() {
  local file_path="$1"
  local proof_dir="${JOBS_HOUSEKEEPING_PROOF_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/frontaliere-housekeeping-proofs}"
  printf '%s/%s.housekeeping-proof.json\n' "${proof_dir%/}" "$file_path"
}

# Path-class classifier for the batch snapshot fail-closed contract (#7054).
# Reviewer follow-up #7060 flagged two open questions: whether the fail-closed
# abort's blast radius on non-job paths (summary/translation-cache/adapter) is
# frequent enough in production to outweigh its resurrection protection, and
# whether these paths ever actually reach a create/modify snapshot in a real
# run at all (unverified — covered only by unit tests before this change).
# Neither is answerable from the repo alone; both need queryable production
# signal. This classifier feeds that signal into the existing abort message
# (commit_isolated_from_worktree, "snapshot conflicts with a newer remote
# deletion") and into the per-run summary log below, so a real crawler-group
# run's Actions log now states, by class, which paths reached a non-unchanged
# operation and which class triggered any abort — greppable without a new
# dashboard.
classify_batch_snapshot_path() {
  local file_path="$1"
  if is_job_slice_path "$file_path"; then
    echo "job-slice"
    return
  fi
  case "$file_path" in
    data/jobs-crawler-summaries/by-crawler/*.json)
      echo "summary" ;;
    data/translation-cache/*.json)
      echo "translation-cache" ;;
    data/jobs-crawler-adapters/*)
      echo "adapter" ;;
    *)
      echo "other" ;;
  esac
}

if [ "$GROUP_BATCH" = true ]; then
  _batch_snapshots_file="$(mktemp /tmp/crawler-group-batch-snapshots.XXXXXX)"
  trap 'rm -f "${_batch_snapshots_file:-}"' EXIT
  if ! node "$(dirname "$0")/crawler-generation-receipt.mjs" --batch-snapshots > "$_batch_snapshots_file"; then
    echo "❌ crawler group batch: invalid or unreadable commit descriptors"
    exit 1
  fi
  while IFS= read -r -d '' path_item; do
    IFS= read -r -d '' snapshot_operation || { echo "❌ crawler group batch: truncated snapshot record"; exit 1; }
    IFS= read -r -d '' snapshot_state || { echo "❌ crawler group batch: truncated snapshot record"; exit 1; }
    IFS= read -r -d '' snapshot_mode || { echo "❌ crawler group batch: truncated snapshot record"; exit 1; }
    IFS= read -r -d '' snapshot_base_blob || { echo "❌ crawler group batch: truncated snapshot record"; exit 1; }
    IFS= read -r -d '' snapshot_blob || { echo "❌ crawler group batch: truncated snapshot record"; exit 1; }
    append_resolved_file "$path_item"
    _BATCH_SNAPSHOT_OPERATION["$path_item"]="$snapshot_operation"
    _BATCH_SNAPSHOT_STATE["$path_item"]="$snapshot_state"
    _BATCH_SNAPSHOT_MODE["$path_item"]="$snapshot_mode"
    _BATCH_SNAPSHOT_BASE_BLOB["$path_item"]="$snapshot_base_blob"
    _BATCH_SNAPSHOT_BLOB["$path_item"]="$snapshot_blob"
  done < "$_batch_snapshots_file"
  # Observability for #7060: report, per path class, how many descriptors in
  # THIS run reached each non-"unchanged" snapshot operation. "unchanged" is
  # excluded — it is the expected steady state and not signal for either open
  # question above.
  declare -A _CLASS_OPERATION_COUNTS=()
  for path_item in "${!_BATCH_SNAPSHOT_OPERATION[@]}"; do
    snapshot_operation="${_BATCH_SNAPSHOT_OPERATION[$path_item]}"
    [ "$snapshot_operation" = "unchanged" ] && continue
    class_key="$(classify_batch_snapshot_path "$path_item"):${snapshot_operation}"
    _CLASS_OPERATION_COUNTS["$class_key"]=$(( ${_CLASS_OPERATION_COUNTS[$class_key]:-0} + 1 ))
  done
  if [ "${#_CLASS_OPERATION_COUNTS[@]}" -gt 0 ]; then
    _class_summary=""
    for class_key in "${!_CLASS_OPERATION_COUNTS[@]}"; do
      _class_summary="${_class_summary}${_class_summary:+, }${class_key}=${_CLASS_OPERATION_COUNTS[$class_key]}"
    done
    echo "ℹ️ crawler group batch: snapshot operations by class (excludes unchanged): ${_class_summary}"
  fi
  if [ "${#RESOLVED_FILES[@]}" -eq 0 ]; then
    echo "ℹ️ crawler group batch: no successful crawler produced a commit descriptor"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=false" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  if ! COMMIT_MSG="$(node "$(dirname "$0")/crawler-generation-receipt.mjs" --batch-message "$COMMIT_MSG")"; then
    echo "❌ crawler group batch: could not assemble deterministic commit attribution"
    exit 1
  fi
fi

# Generation receipt for the exact private-index tree. Standalone callers keep
# the historical shadow-only behavior, but a grouped batch makes the receipt a
# delivery contract: a successful data publication without its receipts is not
# a successful generation. The generated workflow retries exit 46 in the same
# token, and a retry is idempotent because the already-published tree becomes
# the batch's noop candidate.
emit_crawler_generation_receipt() {
  local outcome="${1:-}"
  local commit_sha="${2:-}"
  local remote_base_sha="${3:-}"
  local receipt_status=0
  if [ "$GROUP_BATCH" = true ] && [ -z "${CRAWLER_GENERATION_RECEIPT_DIR:-}" ]; then
    echo "::error::crawler group batch cannot publish delivery receipts: CRAWLER_GENERATION_RECEIPT_DIR is empty"
    return "$CRAWLER_GENERATION_RECEIPT_FAILURE_EXIT"
  fi
  [ -n "${CRAWLER_GENERATION_RECEIPT_DIR:-}" ] || return 0

  local receipt_args=("${RESOLVED_FILES[@]}")
  if [ "$GROUP_BATCH" = true ]; then
    receipt_args=(--batch-receipts)
  fi
  if CRAWLER_GENERATION_RECEIPT_OUTCOME="$outcome" \
    CRAWLER_GENERATION_RECEIPT_COMMIT="$commit_sha" \
    CRAWLER_GENERATION_RECEIPT_REMOTE_BASE="$remote_base_sha" \
    node "$(dirname "$0")/crawler-generation-receipt.mjs" "${receipt_args[@]}"; then
    return 0
  else
    receipt_status=$?
  fi
  if [ "$GROUP_BATCH" = true ]; then
    echo "::error::crawler group batch delivery receipt failed (exit ${receipt_status}); retrying the same generation"
    return "$CRAWLER_GENERATION_RECEIPT_FAILURE_EXIT"
  fi
  echo "::warning::crawler generation receipt failed (shadow only); push outcome remains unchanged"
  return 0
}

if [ "${CRAWLER_GROUP_DEFER_COMMIT:-0}" = "1" ]; then
  # exit 43, not 1: see GROUP_SHARED_PRECONDITION in the exit-code header.
  # Both failures below are shared-environment faults that every crawler in
  # the group reproduces in the same run, so they must not be attributed to
  # the one crawler that happened to observe them.
  if [ "$GROUP_BATCH" = true ] || [ "$GROUPED_ISOLATED" != true ]; then
    echo "❌ crawler group defer mode requires one --slice-only crawler invocation"
    exit 43
  fi
  # Il codice di uscita del receipt si INOLTRA, non si schiaccia a 1: solo lui
  # sa distinguere un input del job condiviso (generation token → 43) da un
  # input del singolo crawler (identita', messaggio, path → 1). Schiacciare
  # qui rimetterebbe le due classi nello stesso secchio, che e' il difetto.
  descriptor_exit=0
  CRAWLER_GROUP_COMMIT_MESSAGE="$COMMIT_MSG" \
    node "$(dirname "$0")/crawler-generation-receipt.mjs" --defer-group-commit "${RESOLVED_FILES[@]}" \
    || descriptor_exit=$?
  if [ "$descriptor_exit" -eq 143 ] || [ "$descriptor_exit" -eq 130 ]; then
    echo "⚠️ crawler group defer receipt was terminated by a signal (exit ${descriptor_exit}) — classifying as shared precondition (exit 43)"
    descriptor_exit=43
  fi
  if [ "$descriptor_exit" -ne 0 ]; then
    echo "❌ crawler group defer mode could not persist its commit descriptor"
    exit "$descriptor_exit"
  fi
  echo "ℹ️ Deferred ${JOBS_HOUSEKEEPING_SCOPE} data for the atomic crawler-group commit"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

create_rebase_snapshot() {
  local base_sha="$1"
  local snapshot_dir
  local f

  snapshot_dir="$(mktemp -d)"

  for f in "${RESOLVED_FILES[@]}"; do
    if [ -f "$f" ]; then
      mkdir -p "$snapshot_dir/local/$(dirname "$f")"
      cp "$f" "$snapshot_dir/local/$f"
    fi
    if git cat-file -e "$base_sha:$f" 2>/dev/null; then
      mkdir -p "$snapshot_dir/base/$(dirname "$f")"
      git show "$base_sha:$f" > "$snapshot_dir/base/$f"
    fi
  done

  printf '%s\n' "$snapshot_dir"
}

cleanup_rebase_snapshot() {
  local snapshot_dir="${1:-}"
  [ -n "$snapshot_dir" ] || return 0
  rm -rf "$snapshot_dir"
}

canonicalize_restored_expired_slices() {
  local f
  # A clean stash pop can still create a semantic route duplicate without a
  # Git conflict. Apply the invariant to every restored expired slice, not only
  # paths that Git reported as unmerged.
  for f in "${RESOLVED_FILES[@]}"; do
    [[ "$f" == data/jobs/expired/by-crawler/*.json ]] || continue
    [ -f "$f" ] || continue
    if ! node "$(dirname "$0")/../ci/canonicalize-expired-archive-slice.mjs" "$f" "$f"; then
      echo "❌ Failed expired archive route canonicalization for $f"
      return 1
    fi
  done
}

restore_stashed_changes_with_safe_merge() {
  local snapshot_dir="$1"
  local conflict_message="$2"
  local conflict_files=""
  local unmerged=""
  local f
  local key_hint=""

  if git stash pop 2>/dev/null; then
    if ! canonicalize_restored_expired_slices; then
      exit 1
    fi
    return 0
  fi

  echo "$conflict_message"
  conflict_files="$(git diff --name-only --diff-filter=U || true)"

  # Reset index conflict markers so we can write clean files back to the tree.
  git reset HEAD -- . 2>/dev/null || true

  for f in "${RESOLVED_FILES[@]}"; do
    [ -f "$snapshot_dir/local/$f" ] || continue
    if [ -n "$conflict_files" ] && ! printf '%s\n' "$conflict_files" | grep -Fxq "$f"; then
      continue
    fi

    if [[ "$f" == *.json ]]; then
      mkdir -p "$snapshot_dir/remote/$(dirname "$f")"
      if git cat-file -e "HEAD:$f" 2>/dev/null; then
        git show "HEAD:$f" > "$snapshot_dir/remote/$f"
      fi

      key_hint=""
      if is_job_slice_path "$f"; then
        key_hint="url"
      else
        case "$f" in
          data/jobs.json|public/data/jobs.json)
            key_hint="url"
            ;;
          data/jobs-crawler-summaries.json)
            key_hint="key"
            ;;
          data/ticino-companies-extra.json)
            key_hint="website"
            ;;
        esac
      fi

      merge_data_json_3way \
        "$snapshot_dir/base/$f" \
        "$snapshot_dir/remote/$f" \
        "$snapshot_dir/local/$f" \
        "$f" \
        "$key_hint" \
        "$f" || {
        echo "❌ Failed safe merge for $f"
        exit 1
      }

      # The seo-404 compat accumulator is sharded across
      # data/seo-404-compat/part-*.json (issue #2988). Re-prune it AFTER the
      # whole merge loop (not here per-shard): a mid-loop prune would read the
      # not-yet-merged shards (still carrying conflict markers → JSON parse fail
      # → skipped by the store reader) as empty and drop their paths. Flag it
      # and run the strict prune once below.
      case "$f" in
        data/seo-404-compat/*.json|data/seo-404-compat-paths.json)
          COMPAT_STORE_TOUCHED=1
          ;;
      esac
    else
      cp "$snapshot_dir/local/$f" "$f"
    fi
  done

  if ! canonicalize_restored_expired_slices; then
    exit 1
  fi

  # Re-validate the sharded seo-404 compat store once, after all shard merges.
  # mergeArrayByDelta keeps everything already present in the remote/upstream
  # side: a non-resolving path that entered upstream after `base` (and is absent
  # from local) is neither an add nor a remove, so it SURVIVES the merge and
  # would poison the committed store → tests/search-console-compat.test.ts red →
  # main red (R2-B pattern, #1166 item 5). Re-prune via the single resolvability
  # source. PRUNE_404_STRICT=1 = fail-closed: if tsx or the assembled dataset is
  # unavailable here, the prune ABORTS the push (exit 1) rather than committing
  # an unvalidated merge.
  if [ -n "${COMPAT_STORE_TOUCHED:-}" ]; then
    echo "🔎 Re-validating sharded seo-404 compat store after 3-way merge (fail-closed)…"
    PRUNE_404_STRICT=1 npx tsx scripts/prune-404-compat-paths.ts || {
      echo "❌ Post-merge resolvability prune failed — refusing to stage a possibly-poisoned compat store."
      exit 1
    }
  fi

  unmerged="$(git diff --name-only --diff-filter=U || true)"
  if [ -n "$unmerged" ]; then
    echo "❌ Unmerged files remain after conflict resolution:"
    echo "$unmerged"
    exit 1
  fi

  # Drop the failed stash entry after we have restored the local content.
  git stash drop 2>/dev/null || true
}

merge_json_3way() {
  local base_file="$1"
  local remote_file="$2"
  local local_file="$3"
  local out_file="$4"
  local key_field="${5:-}"
  local label="${6:-$out_file}"

  node - "$base_file" "$remote_file" "$local_file" "$out_file" "$key_field" "$label" <<'NODE'
const fs = require('fs');
const path = require('path');

const [basePath, remotePath, localPath, outPath, keyField, label] = process.argv.slice(2);

// The historical denylist covers intentional removals known before this merge.
// New cross-job removals are filtered by crawler-commit-ownership.mjs from the
// complete remote ownership view before this append-only merge runs. A stale
// merge input must not reintroduce either class of intentionally removed route.
const restoreDenylistPath = process.env.PREV_SLUG_RESTORE_DENYLIST_PATH
  || path.resolve('data/prev-slug-restore-denylist.json');
const restoreDenylist = new Set();
try {
  const denylist = JSON.parse(fs.readFileSync(restoreDenylistPath, 'utf8'));
  for (const entry of denylist.entries || []) {
    if (entry && entry.file && entry.slug) restoreDenylist.add(`${entry.file}\u0000${entry.slug}`);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const labelFile = path.basename(String(label || '').replace(/\\/g, '/'));
const isRestoreDenylisted = (slug) => restoreDenylist.has(`${labelFile}\u0000${slug}`);

function readJson(filePath, allowMissing = false) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

// CommonJS twin of scripts/lib/stable-stringify.mjs (same recursive
// key-sort algorithm) — this heredoc runs via `node -` on stdin, which can't
// `import` that ESM module, so the logic is necessarily re-expressed here.
// Deliberately diverges on undefined ('__undefined__' sentinel, needed so
// this file's map-key fingerprinting distinguishes undefined from null);
// keep both in sync if the shared shape comparison changes.
function stableStringify(value) {
  if (value === undefined) return '__undefined__';
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function isSame(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function primitiveKey(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function detectArrayKey(arrays, forcedKey = '') {
  const candidates = [];
  if (forcedKey) candidates.push(forcedKey);
  for (const key of ['url', 'id', 'key', 'slug', 'companyKey', 'website', 'name', 'title']) {
    if (!candidates.includes(key)) candidates.push(key);
  }

  // Check uniqueness per-array independently, not across the flattened set.
  // In a 3-way merge, the same items appear in base/remote/local, so flat()
  // makes every key appear 3x and uniqueness drops to ~33%, always failing.
  // The correct check: if a key is unique WITHIN each individual array, it's
  // a valid primary key for merging.
  const nonEmptyArrays = arrays.filter((arr) => Array.isArray(arr) && arr.length > 0);
  if (nonEmptyArrays.length === 0) return '';

  // Bug (issue #4433 investigation): when EVERY non-empty array holds only
  // primitives (e.g. previousSlugs / previousSlugsByLocale.<locale>, plain
  // string[]), the per-array coverage/uniqueness check below is skipped
  // entirely for every array (`objectItems.length === 0` -> `continue`),
  // so `allPass` never gets falsified and the FIRST candidate (forcedKey,
  // usually 'url' inherited from the enclosing job-array merge) is accepted
  // vacuously — with zero items actually keyed by it. mergeArray() then
  // treats each string as keyed by `__fp:<value>#<index>` (value+position),
  // so any base/remote/local length or ordering divergence (e.g. a
  // concurrent writer appended/trimmed entries elsewhere in the SAME file
  // between this job's checkout and commit) makes shifted-but-unchanged
  // entries look deleted-then-readded, and array elements can be silently
  // dropped with NO slug-history-journal attribution (this script never
  // imports scripts/lib/slug-history-journal.mjs). Require at least one
  // real object item somewhere before trusting a business key at all;
  // otherwise there is no valid key and mergeArray() must fall back to
  // mergeArrayByDelta()'s value-based multiset delta, which is the correct
  // semantics for plain-value arrays like previousSlugs.
  const hasAnyObjectItem = nonEmptyArrays.some((arr) => arr.some((item) => isPlainObject(item)));
  if (!hasAnyObjectItem) return '';

  for (const candidate of candidates) {
    let allPass = true;
    for (const arr of nonEmptyArrays) {
      const objectItems = arr.filter((item) => isPlainObject(item));
      if (objectItems.length === 0) continue;
      let present = 0;
      const seen = new Set();
      let duplicate = 0;
      for (const item of objectItems) {
        const key = primitiveKey(item[candidate]);
        if (!key) continue;
        present += 1;
        if (seen.has(key)) duplicate += 1;
        seen.add(key);
      }
      const coverage = present / objectItems.length;
      const uniqueness = present > 0 ? (present - duplicate) / present : 0;
      if (coverage < 0.6 || uniqueness < 0.85) { allPass = false; break; }
    }
    if (allPass) return candidate;
  }

  return '';
}

function keyOf(item, index, keyHint = '') {
  if (!isPlainObject(item)) return `__fp:${stableStringify(item)}#${index}`;

  const preferred = [];
  if (keyHint) preferred.push(keyHint);
  for (const key of ['url', 'id', 'key', 'slug', 'companyKey', 'website', 'name', 'title']) {
    if (!preferred.includes(key)) preferred.push(key);
  }

  for (const field of preferred) {
    const value = primitiveKey(item[field]);
    if (value) return `${field}:${value}`;
  }

  return `__fp:${stableStringify(item)}#${index}`;
}

function arrayToMap(array, keyHint = '') {
  const map = new Map();
  const order = [];
  array.forEach((item, index) => {
    const key = keyOf(item, index, keyHint);
    if (!map.has(key)) order.push(key);
    map.set(key, item);
  });
  return { map, order };
}

function countMap(items) {
  const map = new Map();
  for (const value of items) map.set(value, (map.get(value) || 0) + 1);
  return map;
}

// ── Append-only SET registries (issue #4887) ───────────────────────────────
// A handful of arrays in the committed data set are not ordinary lists: they
// are append-only ORDERED SETS of historical URL/slug strings whose only job
// is to keep an already-indexed URL alive (previousSlugs bridges, 404-compat
// soft-landing paths). For those, mergeArrayByDelta()'s multiset semantics is
// actively destructive, because THIS SCRIPT'S MERGE BASE IS DELIBERATELY
// STALE: commit_isolated_from_worktree() resolves base_sha once from the
// job's checkout HEAD and never fast-forwards it (see the comment at the
// `git push` success branch), so a caller that invokes this script several
// times in one job (translate-pending.yml commits translations, then title
// fixes, then regenerated slugs) merges its 2nd/3rd commit against a base
// that is already one-or-more of its OWN commits old. Under that stale base:
//
//   1. entries that are already on remote but absent from base look like
//      local ADDITIONS and get appended again  → duplicates injected
//      (observed: previousSlugs 42 entries → 81 with 41 distinct);
//   2. the next writer normalises the array through `new Set` and the merge
//      reads `count_base - count_local` as 40 intentional REMOVALS, deleting
//      those fingerprints from remote — which holds only one copy each
//      → 42 distinct slugs collapse to 2, with no slug-history-journal
//      attribution (this script never imports slug-history-journal.mjs).
//
// That is the self-perpetuating cycle "Recover Lost previousSlugs" keeps
// re-recovering (45-383 entries per run, threshold 10). Every recovered slug
// is a URL Google already indexed, so each loss is direct organic-traffic
// equity being deleted.
//
// The fix is to give these arrays their real semantics: an ordered set union
// of remote and local, deduplicated. Base is not consulted at all, which is
// what makes the stale base structurally harmless here — the merge becomes
// idempotent and commutative, so no ordering of concurrent writers can
// fabricate a removal.
//
// Deliberate trade-off: an unknown genuine removal (cleanPreviousSlugsPerLocale
// dropping an entry equal to the active slug, or a decontamination whose target
// is not present in the complete ownership view) that races a concurrent writer
// survives one extra cycle before the next writer drops it again. Proven
// cross-job decontaminations are removed before this function by the ownership
// guard, so the conservative union is retained only when no positive owner
// proof exists. Resurrect-then-redrop is convergent; deleting an indexed
// historical slug without proof is permanent SEO loss.
//
// Bounds: each writer caps its own output through capSlugArray() before this
// runs, so the union is bounded by 2x the cap and the next write re-caps it.
// No ratchet.
const APPEND_ONLY_SET_FILE_PATHS = [
  // Registry of GSC-indexed orphan job slugs (root-level string array),
  // committed by sync-gsc-orphans.yml.
  { file: /(?:^|\/)data\/orphan-indexed-job-slugs\.json$/, path: /^\$$/ },
  // Sharded 404-compat accumulator. The rebase path already gets set
  // semantics from the `merge=compat-shard` driver in .gitattributes; the
  // grouped-isolated commit path never rebases, so it reaches this merge
  // instead and needs the same semantics or it silently drops soft-landing
  // paths (same class, different code path, same file).
  { file: /(?:^|\/)data\/seo-404-compat\/part-\d+\.json$/, path: /^\$\.paths$/ },
];

function isAppendOnlySetPath(fileLabel, pathLabel) {
  // Per-job slug history. Present in every job-carrying slice
  // (data/jobs/by-crawler/*.json, data/jobs/expired/by-crawler/*.json, …),
  // so it is matched on the JSON path rather than on the file name.
  if (/(?:^|[.\]])previousSlugs$/.test(pathLabel)) return true;
  if (/(?:^|[.\]])previousSlugsByLocale\.[^.]+$/.test(pathLabel)) return true;
  const normalized = String(fileLabel || '').replace(/\\/g, '/');
  return APPEND_ONLY_SET_FILE_PATHS.some(
    (rule) => rule.file.test(normalized) && rule.path.test(pathLabel)
  );
}

function mergeAppendOnlySet(remoteArr, localArr, warnings, pathLabel) {
  const merged = [];
  const seen = new Set();
  // Remote first so the older side keeps its position (capSlugArray evicts
  // from the FRONT, i.e. oldest-first), then local-only entries appended as
  // the newest.
  for (const source of [remoteArr, localArr]) {
    for (const item of source) {
      const fp = stableStringify(item);
      if (seen.has(fp)) continue;
      seen.add(fp);
      merged.push(clone(item));
    }
  }
  warnings.push(
    `Append-only set union at ${pathLabel} (remote ${remoteArr.length} ∪ local ${localArr.length} -> ${merged.length})`
  );
  return merged;
}

/**
 * Keep a job's ACTIVE slugs from being deleted by conflict resolution (#5229).
 *
 * `slug` and `slugByLocale.<locale>` are SCALARS, so two writers that renamed
 * the same locale resolve through mergeValue()'s last branch — "Scalar
 * conflict … Keeping local" — and the losing side simply ceases to exist.
 * For a title or a description that is the right call. For a slug it retires
 * an URL Google has already indexed and leaves the redirect machinery with no
 * target, which is the whole failure this file's #4887 fix set out to end:
 * that fix gave the ARCHIVE arrays (`previousSlugs`,
 * `previousSlugsByLocale.*`) append-only union semantics, but the ACTIVE
 * fields kept last-writer-wins, so the loss just moved one field over. It is
 * also invisible to `tests/slug-write-encapsulation.test.ts`, whose AST walk
 * only parses `scripts/**` `.ts|.mjs|.js` — this merge is embedded in a `.sh`.
 *
 * The repair does not change WHICH slug goes live (local still wins, so no
 * other merge semantics shift): it banks the discarded one into the
 * append-only archive that is already merged correctly, turning a silent 404
 * into a redirect.
 */
function preserveDroppedActiveSlugs(remoteObj, localObj, merged, warnings, pathLabel) {
  if (!isPlainObject(merged)) return;
  const hasActive = typeof merged.slug === 'string' || isPlainObject(merged.slugByLocale);
  const looksLikeJob = typeof merged.url === 'string'
    || Array.isArray(merged.previousSlugs)
    || isPlainObject(merged.previousSlugsByLocale);
  if (!hasActive || !looksLikeJob) return;

  const reachable = new Set();
  const activeSlugs = new Set();
  const note = (v) => { if (typeof v === 'string' && v.trim()) reachable.add(v.trim()); };
  const noteActive = (v) => {
    if (typeof v !== 'string' || !v.trim()) return;
    const norm = v.trim();
    activeSlugs.add(norm);
    reachable.add(norm);
  };
  noteActive(merged.slug);
  if (isPlainObject(merged.slugByLocale)) for (const v of Object.values(merged.slugByLocale)) noteActive(v);
  if (Array.isArray(merged.previousSlugs)) for (const v of merged.previousSlugs) note(v);
  if (isPlainObject(merged.previousSlugsByLocale)) {
    for (const arr of Object.values(merged.previousSlugsByLocale)) {
      if (Array.isArray(arr)) for (const v of arr) note(v);
    }
  }

  // Newest position: a slug that was live until this very merge is the most
  // recent entry in the history. capSlugArray keeps the newest `cap`.
  const bank = (slug, locale) => {
    if (typeof slug !== 'string') return;
    const norm = slug.trim();
    if (!norm || reachable.has(norm)) return;
    reachable.add(norm);
    if (locale) {
      if (!isPlainObject(merged.previousSlugsByLocale)) merged.previousSlugsByLocale = {};
      if (!Array.isArray(merged.previousSlugsByLocale[locale])) merged.previousSlugsByLocale[locale] = [];
      merged.previousSlugsByLocale[locale].push(norm);
    }
    if (!Array.isArray(merged.previousSlugs)) merged.previousSlugs = [];
    merged.previousSlugs.push(norm);
    warnings.push(
      `Active slug displaced at ${pathLabel}${locale ? `.slugByLocale.${locale}` : '.slug'} ` +
      `-> banked into previousSlugs (${norm})`
    );
  };

  // Base-equality shortcuts clone one complete side and never descend into
  // `mergeValue()`'s append-only-array branch. Preserve both inputs' archived
  // routes here too, or a stale writer can erase previousSlugs while changing
  // an unrelated field (the post-backfill loss reported in #12498).
  const bankArchived = (slug, locale) => {
    if (typeof slug !== 'string') return;
    const norm = slug.trim();
    if (!norm || activeSlugs.has(norm) || isRestoreDenylisted(norm)) return;
    let added = false;
    reachable.add(norm);
    if (locale) {
      if (!isPlainObject(merged.previousSlugsByLocale)) merged.previousSlugsByLocale = {};
      if (!Array.isArray(merged.previousSlugsByLocale[locale])) merged.previousSlugsByLocale[locale] = [];
      if (!merged.previousSlugsByLocale[locale].includes(norm)) {
        merged.previousSlugsByLocale[locale].push(norm);
        added = true;
      }
    }
    if (!Array.isArray(merged.previousSlugs)) merged.previousSlugs = [];
    if (!merged.previousSlugs.includes(norm)) {
      merged.previousSlugs.push(norm);
      added = true;
    }
    if (added) {
      warnings.push(`Historical slug preserved at ${pathLabel}${locale ? `.previousSlugsByLocale.${locale}` : '.previousSlugs'} (${norm})`);
    }
  };
  for (const source of [remoteObj, localObj]) {
    for (const slug of Array.isArray(source?.previousSlugs) ? source.previousSlugs : []) {
      bankArchived(slug, '');
    }
    if (isPlainObject(source?.previousSlugsByLocale)) {
      for (const [locale, slugs] of Object.entries(source.previousSlugsByLocale)) {
        if (!Array.isArray(slugs)) continue;
        for (const slug of slugs) bankArchived(slug, locale);
      }
    }
  }

  const remoteMap = isPlainObject(remoteObj?.slugByLocale) ? remoteObj.slugByLocale : {};
  const localMap = isPlainObject(localObj?.slugByLocale) ? localObj.slugByLocale : {};
  for (const locale of new Set([...Object.keys(remoteMap), ...Object.keys(localMap)])) {
    bank(remoteMap[locale], locale);
    bank(localMap[locale], locale);
  }
  bank(remoteObj?.slug, '');
  bank(localObj?.slug, '');
}

// The usual object-recursion path above is skipped when mergeValue() takes a
// base-equality fast path. Job slices may be root arrays or wrapped objects
// such as { assembledAt, crawlerKey, jobs }. Walk through wrappers to reach
// matching job records before returning a cloned remote/local value. This
// keeps active slugs reachable for both one-sided cases: local==base and
// remote==base.
function preserveDroppedActiveSlugsInValue(remoteValue, localValue, merged, warnings, pathLabel, forcedKey = '') {
  if (isPlainObject(merged)) {
    const hasActive = typeof merged.slug === 'string' || isPlainObject(merged.slugByLocale);
    const looksLikeJob = typeof merged.url === 'string'
      || Array.isArray(merged.previousSlugs)
      || isPlainObject(merged.previousSlugsByLocale);
    if (hasActive && looksLikeJob) {
      preserveDroppedActiveSlugs(remoteValue, localValue, merged, warnings, pathLabel);
      return;
    }

    const remoteObject = isPlainObject(remoteValue) ? remoteValue : {};
    const localObject = isPlainObject(localValue) ? localValue : {};
    const keys = new Set([
      ...Object.keys(remoteObject),
      ...Object.keys(localObject),
      ...Object.keys(merged),
    ]);
    for (const key of keys) {
      const child = merged[key];
      if (!isPlainObject(child) && !Array.isArray(child)) continue;
      preserveDroppedActiveSlugsInValue(
        remoteObject[key],
        localObject[key],
        child,
        warnings,
        `${pathLabel}.${key}`,
        forcedKey,
      );
    }
    return;
  }
  if (!Array.isArray(merged)) return;

  const keyHint = detectArrayKey([remoteValue, localValue, merged], forcedKey);
  if (!keyHint) return;
  const remoteData = arrayToMap(Array.isArray(remoteValue) ? remoteValue : [], keyHint);
  const localData = arrayToMap(Array.isArray(localValue) ? localValue : [], keyHint);
  const mergedData = arrayToMap(merged, keyHint);
  for (const key of new Set([...remoteData.map.keys(), ...localData.map.keys()])) {
    const mergedObj = mergedData.map.get(key);
    if (!isPlainObject(mergedObj)) continue;
    preserveDroppedActiveSlugs(
      remoteData.map.get(key),
      localData.map.get(key),
      mergedObj,
      warnings,
      `${pathLabel}[${keyHint}=${key}]`,
    );
  }
}

function mergeArrayByDelta(baseArr, remoteArr, localArr) {
  const baseFp = baseArr.map((v) => stableStringify(v));
  const remoteFp = remoteArr.map((v) => stableStringify(v));
  const localFp = localArr.map((v) => stableStringify(v));

  const baseCounts = countMap(baseFp);
  const localCounts = countMap(localFp);

  const removals = new Map();
  for (const [fp, count] of baseCounts.entries()) {
    const next = count - (localCounts.get(fp) || 0);
    if (next > 0) removals.set(fp, next);
  }

  const additions = new Map();
  for (const [fp, count] of localCounts.entries()) {
    const next = count - (baseCounts.get(fp) || 0);
    if (next > 0) additions.set(fp, next);
  }

  const merged = [];
  for (let i = 0; i < remoteArr.length; i += 1) {
    const fp = remoteFp[i];
    const left = removals.get(fp) || 0;
    if (left > 0) {
      removals.set(fp, left - 1);
      continue;
    }
    merged.push(clone(remoteArr[i]));
  }

  for (let i = 0; i < localArr.length; i += 1) {
    const fp = localFp[i];
    const left = additions.get(fp) || 0;
    if (left > 0) {
      additions.set(fp, left - 1);
      merged.push(clone(localArr[i]));
    }
  }

  return merged;
}

function mergeArray(baseArr, remoteArr, localArr, warnings, pathLabel, forcedKey = '') {
  const keyHint = detectArrayKey([baseArr, remoteArr, localArr], forcedKey);
  if (!keyHint) return mergeArrayByDelta(baseArr, remoteArr, localArr);

  const baseData = arrayToMap(baseArr, keyHint);
  const remoteData = arrayToMap(remoteArr, keyHint);
  const localData = arrayToMap(localArr, keyHint);

  const touched = new Set([...baseData.map.keys(), ...localData.map.keys()]);
  for (const key of [...touched]) {
    if (isSame(baseData.map.get(key), localData.map.get(key))) touched.delete(key);
  }

  const mergedMap = new Map(remoteData.map);
  for (const key of touched) {
    if (!localData.map.has(key)) {
      // Local deleted this key relative to base — respect the deletion.
      mergedMap.delete(key);
      continue;
    }
    if (baseData.map.has(key) && !remoteData.map.has(key)) {
      // Present in base, edited locally, but the OTHER writer already
      // removed this key from remote since our snapshot (e.g. a crawler's
      // stable-id dedup collapsing 2 URL-variant records into 1, or a
      // closed posting pruned as stale). A stale local edit against the
      // pre-removal snapshot must not resurrect a record the fresher
      // write already retired — remote's deletion wins (issue #4603: a
      // long-running translate-pending run held a pre-dedup snapshot of
      // data/jobs/by-crawler/banca-cler.json and its slug-regen commit
      // re-added a job the same-day Cler crawl had already merged away).
      continue;
    }
    if (!remoteData.map.has(key)) {
      // New relative to both base and remote (local created it fresh) —
      // nothing on the other side to reconcile against, take it as-is.
      mergedMap.set(key, localData.map.get(key));
      continue;
    }
    // Present on remote too: recursively merge the matched element instead
    // of flatly replacing it with local's whole value (issue 4433: a
    // long-running translate-pending run touches a job for an UNRELATED
    // reason — e.g. a translation/status field — while its own snapshot of
    // that same job is stale; meanwhile remote independently gained new
    // previousSlugs entries for that job via a concurrent slug-rename on
    // origin/main after this workspace's checkout. A flat `mergedMap.set`
    // here took local's entire stale job object, silently discarding
    // remote's newer previousSlugs entries even though neither side ever
    // intended to remove them — a real 3-way merge must reconcile the two
    // versions field-by-field, not let whichever side is "touched" win
    // wholesale.
    mergedMap.set(
      key,
      mergeValue(
        baseData.map.get(key),
        remoteData.map.get(key),
        localData.map.get(key),
        warnings,
        `${pathLabel}[${keyHint}=${key}]`,
        forcedKey
      )
    );
  }

  const remoteKeys = new Set(remoteData.order);
  const mergedKeys = [];
  for (const key of remoteData.order) {
    if (mergedMap.has(key)) mergedKeys.push(key);
  }
  for (const key of localData.order) {
    if (!remoteKeys.has(key) && mergedMap.has(key)) mergedKeys.push(key);
  }

  const merged = mergedKeys.map((key) => clone(mergedMap.get(key)));
  warnings.push(`Array merge at ${pathLabel} using key '${keyHint}' (${baseArr.length}/${remoteArr.length}/${localArr.length} -> ${merged.length})`);
  return merged;
}

const LOCALE_TRANSLATION_KEYS = ['it', 'en', 'de', 'fr'];

function normalizeLocaleMergeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function sameNonEmptyLocaleMergeText(left, right) {
  const a = normalizeLocaleMergeText(left);
  const b = normalizeLocaleMergeText(right);
  return a.length > 0 && a === b;
}

/**
 * A crawler can rebuild a non-source locale as a copy of the source text while
 * a translation writer is publishing the same job. Generic 3-way semantics
 * treat that copy as an intentional edit whenever the remote side equals the
 * merge base (or as the winner of a scalar conflict), which regresses a valid
 * translation and re-queues the job on the next scan.
 *
 * Protect only the narrow, observable regression:
 * - sourceLang is present in the merge base and the same on remote and local;
 * - the source field is present in the merge base and unchanged on both sides;
 * - local non-source slot is missing, too short, or a normalized copy of that
 *   source field; and
 * - remote has a non-empty, different value for the same slot.
 *
 * If the source or source language changed, the local copy remains authoritative
 * and the normal retranslation marker is retained.
 */
function planLocaleTranslationProtection(baseObj, remoteObj, localObj) {
  const sourceLang = String(
    remoteObj.sourceLang || localObj.sourceLang || baseObj.sourceLang || '',
  ).trim();
  if (!LOCALE_TRANSLATION_KEYS.includes(sourceLang)) return [];
  if (
    remoteObj.sourceLang && localObj.sourceLang
    && String(remoteObj.sourceLang).trim() !== String(localObj.sourceLang).trim()
  ) return [];
  // No merge-base evidence means no proof that the source stayed put: leave
  // the generic merge alone instead of assuming "unchanged".
  if (
    !sameNonEmptyLocaleMergeText(baseObj.sourceLang, remoteObj.sourceLang)
    || !sameNonEmptyLocaleMergeText(baseObj.sourceLang, localObj.sourceLang)
  ) return [];

  const repairs = [];
  for (const { field, mapKey } of [
    { field: 'title', mapKey: 'titleByLocale' },
    { field: 'description', mapKey: 'descriptionByLocale' },
  ]) {
    const remoteSource = remoteObj[field];
    const localSource = localObj[field];
    if (!sameNonEmptyLocaleMergeText(remoteSource, localSource)) continue;
    if (!sameNonEmptyLocaleMergeText(baseObj[field], remoteSource)) continue;
    const remoteMap = isPlainObject(remoteObj[mapKey]) ? remoteObj[mapKey] : {};
    const localMap = isPlainObject(localObj[mapKey]) ? localObj[mapKey] : {};
    for (const locale of LOCALE_TRANSLATION_KEYS) {
      if (locale === sourceLang) continue;
      const localValue = localMap[locale];
      const remoteValue = remoteMap[locale];
      const localText = normalizeLocaleMergeText(localValue);
      const remoteText = normalizeLocaleMergeText(remoteValue);
      const localIsSourceCopy = sameNonEmptyLocaleMergeText(localValue, localSource);
      const localIsShort = localText.length < (field === 'title' ? 3 : 120);
      const localSlotIsRegression = localText.length === 0
        || localIsSourceCopy
        || localIsShort;
      if (!localSlotIsRegression) continue;
      if (remoteText.length === 0) continue;
      // A short local translation can also be a genuine detector finding. Only
      // replace it when the remote side carries a complete value; source-copy
      // and empty local slots remain unambiguous crawler regressions even when
      // the reduced fixture uses a short remote string.
      // An EMPTY local slot is not a short translation: it carries no
      // detector finding to respect, so a valid short remote value (a title
      // such as "HR") is still restored.
      if (localText.length > 0 && localIsShort && !localIsSourceCopy
          && remoteText.length < (field === 'title' ? 3 : 120)) continue;
      if (sameNonEmptyLocaleMergeText(remoteValue, remoteSource)) continue;
      if (sameNonEmptyLocaleMergeText(localValue, remoteValue)) continue;
      repairs.push({ mapKey, locale, value: remoteValue });
    }
  }
  return repairs;
}

function applyLocaleTranslationProtection(baseObj, remoteObj, localObj, merged, warnings, pathLabel) {
  const repairs = planLocaleTranslationProtection(baseObj, remoteObj, localObj);
  if (repairs.length === 0) return false;

  for (const { mapKey, locale, value } of repairs) {
    if (!isPlainObject(merged[mapKey])) merged[mapKey] = {};
    merged[mapKey][locale] = clone(value);
  }

  // A crawler flag caused only by this stale-slot regression is stale once both
  // locale maps are exactly the pipeline's remote maps. Do not clear a marker
  // for a different detector finding or when the remote writer still has it.
  const mapsMatchRemote = ['titleByLocale', 'descriptionByLocale'].every((mapKey) => {
    return isSame(merged[mapKey], remoteObj[mapKey]);
  });
  const clearLocalFlag = localObj.needsRetranslation === true
    && remoteObj.needsRetranslation !== true
    && mapsMatchRemote;
  if (clearLocalFlag) {
    if (remoteObj.needsRetranslation === undefined) delete merged.needsRetranslation;
    else merged.needsRetranslation = clone(remoteObj.needsRetranslation);
  }

  const fields = repairs.map(({ mapKey, locale }) => `${mapKey}.${locale}`).join(', ');
  warnings.push(
    `Preserved remote locale translation at ${pathLabel} (${fields}) because the local slot was missing, short, or a source copy while source text stayed unchanged.`
  );
  if (clearLocalFlag) {
    warnings.push(`Preserved remote needsRetranslation state at ${pathLabel} after stale-slot repair.`);
  }
  return clearLocalFlag;
}

function applyLocaleTranslationProtectionToValue(
  baseValue,
  remoteValue,
  localValue,
  merged,
  warnings,
  pathLabel,
  forcedKey = '',
) {
  if (isPlainObject(merged)) {
    applyLocaleTranslationProtection(
      isPlainObject(baseValue) ? baseValue : {},
      isPlainObject(remoteValue) ? remoteValue : {},
      isPlainObject(localValue) ? localValue : {},
      merged,
      warnings,
      pathLabel,
    );

    // The root of a crawler slice is an object containing a jobs array. A
    // base-equality fast path returns that object before mergeValue() reaches
    // each job, so walk nested containers here as well. Otherwise a file whose
    // remote root is unchanged bypasses the same protection that works when a
    // different job made the root a normal object merge.
    const baseObj = isPlainObject(baseValue) ? baseValue : {};
    const remoteObj = isPlainObject(remoteValue) ? remoteValue : {};
    const localObj = isPlainObject(localValue) ? localValue : {};
    for (const key of Object.keys(merged)) {
      const child = merged[key];
      if (!isPlainObject(child) && !Array.isArray(child)) continue;
      applyLocaleTranslationProtectionToValue(
        baseObj[key],
        remoteObj[key],
        localObj[key],
        child,
        warnings,
        `${pathLabel}.${key}`,
        forcedKey,
      );
    }
    return;
  }
  if (!Array.isArray(merged)) return;

  const keyHint = detectArrayKey(
    [baseValue, remoteValue, localValue, merged],
    forcedKey,
  );
  if (!keyHint) return;
  const baseData = arrayToMap(Array.isArray(baseValue) ? baseValue : [], keyHint);
  const remoteData = arrayToMap(Array.isArray(remoteValue) ? remoteValue : [], keyHint);
  const localData = arrayToMap(Array.isArray(localValue) ? localValue : [], keyHint);
  const mergedData = arrayToMap(merged, keyHint);
  for (const key of mergedData.order) {
    const child = mergedData.map.get(key);
    if (!isPlainObject(child)) continue;
    applyLocaleTranslationProtectionToValue(
      baseData.map.get(key),
      remoteData.map.get(key),
      localData.map.get(key),
      child,
      warnings,
      `${pathLabel}[${keyHint}=${key}]`,
      '',
    );
  }
}

function mergeValue(baseValue, remoteValue, localValue, warnings, pathLabel, forcedKey = '') {
  if (isSame(localValue, baseValue)) {
    const merged = clone(remoteValue);
    preserveDroppedActiveSlugsInValue(remoteValue, localValue, merged, warnings, pathLabel, forcedKey);
    applyLocaleTranslationProtectionToValue(baseValue, remoteValue, localValue, merged, warnings, pathLabel);
    return merged;
  }
  if (isSame(remoteValue, baseValue)) {
    const merged = clone(localValue);
    preserveDroppedActiveSlugsInValue(remoteValue, localValue, merged, warnings, pathLabel, forcedKey);
    applyLocaleTranslationProtectionToValue(baseValue, remoteValue, localValue, merged, warnings, pathLabel);
    return merged;
  }
  if (isSame(localValue, remoteValue)) {
    const merged = clone(localValue);
    preserveDroppedActiveSlugsInValue(remoteValue, localValue, merged, warnings, pathLabel, forcedKey);
    applyLocaleTranslationProtectionToValue(baseValue, remoteValue, localValue, merged, warnings, pathLabel);
    return merged;
  }

  const anyArray = Array.isArray(baseValue) || Array.isArray(remoteValue) || Array.isArray(localValue);
  if (anyArray) {
    if ((baseValue !== undefined && !Array.isArray(baseValue)) ||
        (remoteValue !== undefined && !Array.isArray(remoteValue)) ||
        (localValue !== undefined && !Array.isArray(localValue))) {
      warnings.push(`Type conflict at ${pathLabel}: array vs non-array. Keeping local.`);
      return clone(localValue);
    }
    const baseArr = Array.isArray(baseValue) ? baseValue : [];
    const remoteArr = Array.isArray(remoteValue) ? remoteValue : [];
    const localArr = Array.isArray(localValue) ? localValue : [];
    // Append-only SEO registries never take the delta path — see the block
    // above mergeArrayByDelta() for why a stale merge base makes multiset
    // deltas delete already-indexed slugs/paths (issue #4887).
    if (isAppendOnlySetPath(label, pathLabel)) {
      return mergeAppendOnlySet(remoteArr, localArr, warnings, pathLabel);
    }
    return mergeArray(baseArr, remoteArr, localArr, warnings, pathLabel, forcedKey);
  }

  const anyObject = isPlainObject(baseValue) || isPlainObject(remoteValue) || isPlainObject(localValue);
  if (anyObject) {
    if ((baseValue !== undefined && !isPlainObject(baseValue)) ||
        (remoteValue !== undefined && !isPlainObject(remoteValue)) ||
        (localValue !== undefined && !isPlainObject(localValue))) {
      warnings.push(`Type conflict at ${pathLabel}: object vs non-object. Keeping local.`);
      return clone(localValue);
    }

    const baseObj = isPlainObject(baseValue) ? baseValue : {};
    const remoteObj = isPlainObject(remoteValue) ? remoteValue : {};
    const localObj = isPlainObject(localValue) ? localValue : {};

    const keys = new Set([
      ...Object.keys(baseObj),
      ...Object.keys(remoteObj),
      ...Object.keys(localObj),
    ]);

    const merged = {};
    for (const key of keys) {
      const next = mergeValue(
        baseObj[key],
        remoteObj[key],
        localObj[key],
        warnings,
        `${pathLabel}.${key}`,
        forcedKey
      );
      if (next !== undefined) merged[key] = next;
    }
    preserveDroppedActiveSlugs(remoteObj, localObj, merged, warnings, pathLabel);
    applyLocaleTranslationProtection(baseObj, remoteObj, localObj, merged, warnings, pathLabel);
    return merged;
  }

  warnings.push(`Scalar conflict at ${pathLabel}. Keeping local.`);
  return clone(localValue);
}

let base;
let remote;
let local;

try {
  base = readJson(basePath, true);
  remote = readJson(remotePath, true);
  local = readJson(localPath, true);
} catch (error) {
  console.error(`❌ Cannot parse ${label}: ${error.message}`);
  process.exit(2);
}

if (local === undefined) {
  console.error(`❌ Missing local snapshot for ${label}`);
  process.exit(3);
}

const warnings = [];
const merged = mergeValue(base, remote, local, warnings, '$', keyField);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
console.log(`  ✅ 3-way merged ${label}`);
if (warnings.length > 0) {
  const preview = warnings.slice(0, 3).map((w) => `     - ${w}`).join('\n');
  console.log(`  ℹ️  merge notes (${warnings.length}):\n${preview}${warnings.length > 3 ? '\n     - ...' : ''}`);
}
NODE
}

# A per-crawler summary (data/jobs-crawler-summaries/by-crawler/*.json) is the
# receipt of ONE crawler run: crawler-template.mjs writes its counts as the
# lengths of its lists, from one computeCrawlDiff partition. merge_json_3way
# would fuse two receipts field by field against this script's deliberately
# stale base: the lists come out as the union of different runs while each
# count stays the one of a single run (reproduced byte for byte on
# abraxas.json, origin/main e7d7f8760f3: newCount 0 with 2 newJobs,
# removedCount 0 with 8 removedJobs, one id both new and updated). So a
# summary is never merged: one whole file wins.
is_crawler_summary_receipt_path() {
  [[ "$1" == data/jobs-crawler-summaries/by-crawler/*.json ]]
}

# Same arguments as merge_json_3way (key_field is unused). Keeps the side whose
# write is the most recent run: the remote file when it has a strictly newer
# generatedAt (or when local did not rewrite the file since the checkout),
# otherwise the local one — including ties and an unreadable generatedAt or
# remote file on either side.
select_crawler_summary_receipt() {
  local base_file="$1"
  local remote_file="$2"
  local local_file="$3"
  local out_file="$4"
  local label="${6:-$out_file}"

  node - "$base_file" "$remote_file" "$local_file" "$out_file" "$label" <<'NODE'
const fs = require('fs');
const path = require('path');

const [basePath, remotePath, localPath, outPath, label] = process.argv.slice(2);

function readRaw(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

function generatedAtMs(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return NaN;
  return typeof value.generatedAt === 'string' ? Date.parse(value.generatedAt) : NaN;
}

const localRaw = readRaw(localPath);
if (localRaw === undefined) {
  console.error(`❌ Missing local snapshot for ${label}`);
  process.exit(3);
}
const localParsed = parse(localRaw);
if (!localParsed.ok) {
  console.error(`❌ Cannot parse ${label}: ${localParsed.error.message}`);
  process.exit(2);
}
const baseRaw = readRaw(basePath);
const remoteRaw = readRaw(remotePath);
const remoteParsed = remoteRaw === undefined ? undefined : parse(remoteRaw);

let keep = 'local';
let reason;
if (remoteRaw === undefined) {
  reason = 'no remote file';
} else if (!remoteParsed.ok) {
  reason = 'remote file unreadable';
} else if (baseRaw !== undefined && localRaw.equals(baseRaw)) {
  keep = 'remote';
  reason = 'local not rewritten since checkout';
} else if (baseRaw !== undefined && remoteRaw.equals(baseRaw)) {
  reason = 'remote not rewritten since checkout';
} else {
  const localAt = generatedAtMs(localParsed.value);
  const remoteAt = generatedAtMs(remoteParsed.value);
  if (!Number.isFinite(localAt) || !Number.isFinite(remoteAt)) {
    reason = 'generatedAt unreadable';
  } else if (remoteAt > localAt) {
    keep = 'remote';
    reason = 'newer generatedAt';
  } else {
    reason = remoteAt === localAt ? 'same generatedAt' : 'newer generatedAt';
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, keep === 'local' ? localRaw : remoteRaw);
console.log(`  summary receipt: kept ${keep} for ${label} (${reason})`);
NODE
}

# Single entry point of both JSON merge call sites (grouped-isolated commit and
# stash restore): crawler summaries are receipts, everything else keeps the
# field-by-field 3-way merge.
merge_data_json_3way() {
  if is_crawler_summary_receipt_path "${6:-$4}"; then
    select_crawler_summary_receipt "$@"
  else
    merge_json_3way "$@"
  fi
}

# ── 0a. Size guard: trim stale jobs if data/jobs.json approaches GitHub's 100 MB limit ──
# (Skipped in --slice-only mode: shared files are not committed by crawlers)
#
# IMPORTANT: data/jobs.json is .gitignored (see .gitignore) — it is NEVER staged
# or pushed (the stage loop below filters gitignored paths via `git check-ignore`).
# So an over-size jobs.json cannot poison a push and there is nothing to protect
# by aborting. The trim is best-effort housekeeping; a residual over-size file is
# a WARNING, not a hard failure. A hard `exit 1` here is pure collateral: it took
# down newsletter-qa, sync-gsc-orphans, recover-prev-slugs, translate-pending and
# every crawler the moment the LIVE corpus grew past 90 MB (issue #1273), aborting
# the commit of completely unrelated files (QA reports, slices). We do NOT trim
# more aggressively (corpus = funnel; never cut pages); we just stop failing.
if [ "$SLICE_ONLY" = true ]; then
  echo "📦 Slice-only mode: skipping shared file operations (assembly happens at deploy)"
fi
if [ "$SLICE_ONLY" = false ] && [ -f "data/jobs.json" ]; then
  FILE_SIZE_MB=$(du -m "data/jobs.json" | cut -f1)
  if [ "$FILE_SIZE_MB" -gt 90 ]; then
    echo "⚠️  data/jobs.json is ${FILE_SIZE_MB} MB — running emergency age-based trim (crawledAt > ${JOBS_SIZE_TRIM_DAYS:-45} days)..."
    node - <<'NODE'
const fs = require('fs');
const TRIM_DAYS = parseInt(process.env.JOBS_SIZE_TRIM_DAYS || '45', 10);
const TRIM_MS   = TRIM_DAYS * 24 * 60 * 60 * 1000;
const filePath  = 'data/jobs.json';
const jobs      = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const cutoff    = Date.now() - TRIM_MS;
const before    = jobs.length;
const fresh     = jobs.filter(job => {
  const ts = job.crawledAt ? new Date(job.crawledAt).getTime() : NaN;
  return isNaN(ts) || ts >= cutoff;
});
fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
const afterMb = Buffer.byteLength(JSON.stringify(fresh)) / (1024 * 1024);
console.log(`  Trimmed ${before - fresh.length} stale jobs (${before} → ${fresh.length}, ~${afterMb.toFixed(1)} MB)`);
if (afterMb > 90) {
  // data/jobs.json is gitignored: it is never staged or pushed, so a residual
  // over-size file is harmless to the commit. Warn (don't abort) so unrelated
  // files in this commit still get pushed. The corpus is intentionally large
  // (SEO funnel) — aggressive pruning is out of scope here.
  console.warn(`⚠️  data/jobs.json is still ${afterMb.toFixed(1)} MB after trim (gitignored — not pushed; continuing).`);
}
NODE
  fi
fi

# ── 0. Refresh derived job-board statistics before change detection ────────
# (Skipped in --slice-only mode: stats are generated during deploy assembly)
if [ "$SLICE_ONLY" = false ] && [ -f "data/jobs.json" ]; then
  node scripts/generate-job-board-stats.mjs
fi

# ── 1. Detect changes ──────────────────────────────────────────────────────
# Check tracked modifications AND untracked new files in tracked directories.
# `git diff --quiet` only sees tracked files. If a previously-tracked file was
# deleted and then recreated by the crawler, it's untracked until `git add`.
#
# Skipped on the grouped-isolated path: in a shared workspace this whole-tree
# check mostly observes SIBLINGS' dirty files (meaningless for this crawler),
# and it misses a brand-new untracked slice FILE (the untracked scan below
# only inspects directory entries). The isolated path decides "no effective
# changes" exactly, by comparing its built tree against origin/main's tree,
# and emits has_changes itself.
if [ "$GROUPED_ISOLATED" != true ]; then
  HAS_UNTRACKED=false
  for path_item in "${ALL_FILES[@]}"; do
    if [[ -d "${path_item%/}" ]]; then
      if [ -n "$(git ls-files --others --exclude-standard "${path_item%/}" 2>/dev/null)" ]; then
        HAS_UNTRACKED=true
        break
      fi
    fi
  done

  if git diff --quiet && git diff --cached --quiet && [ "$HAS_UNTRACKED" = false ]; then
    echo "ℹ️ No changes detected"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=false" >> "$GITHUB_OUTPUT"
    exit 0
  fi

  echo "📝 Changes detected:"
  git status --short
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=true" >> "$GITHUB_OUTPUT"
fi

# ── Reusable guard: refuse to commit files with merge conflict markers ──────
# Called right before every `git commit` invocation below. Added 2026-05-21
# after the translate-pending cron committed 92 slices with raw `git stash pop`
# conflict markers, silently dropping ~3.5k jobs from production via the
# downstream assemble-jobs-dataset.mjs.
abort_if_conflict_markers_staged() {
  local label="${1:-pre-commit}"
  local dirty=""
  # Scan only staged text files; markers in binary blobs aren't a thing we
  # care about. `git diff --cached --name-only -z` is null-delimited safe.
  while IFS= read -r -d '' file; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue
    case "$file" in
      *.png|*.jpg|*.jpeg|*.gif|*.webp|*.avif|*.ico|*.woff|*.woff2|*.ttf|*.otf|*.eot|*.mp4|*.mp3|*.pdf|*.zip|*.gz|*.tgz|*.tar|*.bin)
        continue
        ;;
    esac
    if grep -qE '^(<<<<<<< |======= ?$|>>>>>>> )' "$file" 2>/dev/null; then
      dirty="${dirty}${file}\n"
    fi
  done < <(git diff --cached --name-only -z)
  if [ -n "$dirty" ]; then
    echo "❌ ${label}: refusing to commit — unresolved merge conflict markers in staged file(s):"
    printf '%b' "$dirty" | sed 's/^/   - /'
    echo "   Resolve before retrying. For job slice files specifically:"
    echo "     node scripts/recover-conflict-marker-slices.mjs"
    exit 1
  fi
}

# ── 2. Configure git identity ──────────────────────────────────────────────
git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

# ── 2b. Keep Git auth explicit across retry/rebase paths ───────────────────
# Direct pushes to this repo's `main` must use GITHUB_PAT or APP_TOKEN
# (ruleset bypass identities). The ambient GITHUB_TOKEN / GH_TOKEN extraheader
# that actions/checkout persists is rejected with GH013; restoring it on
# retry was the old helper's fallback and is now forbidden. Origin URLs that
# are not github.com (local helper tests) are left alone by the configure
# script so in-repo merge/push tests keep their temp remotes.
ensure_git_auth() {
  bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/configure-main-push-auth.sh"
}

old_history_guard_main() {
  node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/old-history-guard.mjs" \
    --head HEAD \
    --base refs/remotes/origin/main \
    --refresh-base \
    --remote origin \
    --branch main
}

# GitHub concurrency groups cannot serialize the site and corpus repositories
# together. The generated crawler groups and translate-pending therefore opt
# into one Firestore-backed lease. Keep acquisition outside the isolated
# plumbing function, and the EXIT trap releases it on all normal failure/success
# paths. The full ownership archive is prepared before the lease; each attempt
# covers fetch/rebuild/push and only the small ownership delta since the last
# snapshot, but NOT the backoff sleep between attempts: see the note on
# global_data_pipeline_lease_release_for_backoff for the measurement that
# changed this, and why narrowing the lock is safe here.
GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=0
GROUPED_OWNERSHIP_VIEW_DIR=""
GROUPED_OWNERSHIP_VIEW_SHA=""
GROUPED_OWNERSHIP_CHANGED_COUNT=0
global_data_pipeline_lease_acquire() {
  [ "${DATA_PIPELINE_LEASE:-0}" = "1" ] || return 0
  local lease_script
  local lease_status
  lease_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/global-data-pipeline-lease.mjs"
  if node "$lease_script" acquire; then
    GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=1
    return 0
  else
    lease_status=$?
  fi
  if [ "$lease_status" -eq 44 ]; then
    echo "::warning::global data pipeline lease remained busy after the bounded wait; this writer staged nothing and will retry on the next scheduled run"
  fi
  if [ "$lease_status" -eq 45 ]; then
    echo "::error::global data pipeline lease stopped after consecutive transient Firestore errors; this writer staged nothing and will not retry this generation"
  fi
  return "$lease_status"
}

global_data_pipeline_lease_cleanup() {
  local exit_status=$?
  if [ "${GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED:-0}" = "1" ]; then
    local lease_script
    lease_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/global-data-pipeline-lease.mjs"
    if ! node "$lease_script" release; then
      echo "::warning::global data pipeline lease release failed; the lease expires automatically"
    fi
    GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=0
  fi
  if [ -n "${GROUPED_OWNERSHIP_VIEW_DIR:-}" ]; then
    rm -rf -- "$GROUPED_OWNERSHIP_VIEW_DIR"
    GROUPED_OWNERSHIP_VIEW_DIR=""
  fi
  return "$exit_status"
}
trap global_data_pipeline_lease_cleanup EXIT

# The ownership view can be large on the blobless grouped-crawler checkout.
# Build it before acquiring the cross-repository writer lease; once the lease
# is held, only refresh paths changed since this snapshot. A clean copy is made
# for each isolated attempt so local candidate overlays never leak into retries.
grouped_ownership_view_needed() {
  local file remote_blob
  for file in "${RESOLVED_FILES[@]}"; do
    [[ "$file" == data/jobs/by-crawler/*.json ]] || continue
    if [ "$GROUP_BATCH" = true ]; then
      [ "${_BATCH_SNAPSHOT_OPERATION[$file]:-unchanged}" != unchanged ] || continue
      [ "${_BATCH_SNAPSHOT_STATE[$file]:-absent}" = present ] || continue
      return 0
    fi
    [ -f "$file" ] || continue
    if ! git check-ignore -q "$file" 2>/dev/null; then
      remote_blob="$(git rev-parse -q --verify "refs/remotes/origin/main:$file" 2>/dev/null || true)"
      [ -n "$remote_blob" ] && [ "$(git hash-object -- "$file")" = "$remote_blob" ] && continue
    fi
    return 0
  done
  return 1
}

grouped_ownership_view_prepare() {
  local remote_sha="$1" ownership_listing ownership_missing ownership_total started_seconds
  started_seconds="$SECONDS"
  if [ -z "$GROUPED_OWNERSHIP_VIEW_DIR" ]; then
    GROUPED_OWNERSHIP_VIEW_DIR="$(mktemp -d /tmp/crawler-ownership-view.XXXXXX)"
  fi
  rm -rf -- "$GROUPED_OWNERSHIP_VIEW_DIR/snapshot"
  mkdir -p "$GROUPED_OWNERSHIP_VIEW_DIR/snapshot/data/jobs/by-crawler"

  ownership_missing=0
  ownership_total=0
  if GIT_NO_LAZY_FETCH=1 git cat-file -e "$remote_sha:data/jobs/by-crawler" 2>/dev/null; then
    if ownership_listing="$(GIT_NO_LAZY_FETCH=1 git rev-list --objects --missing=print "$remote_sha:data/jobs/by-crawler" 2>/dev/null)"; then
      ownership_missing="$(grep -c '^?' <<< "$ownership_listing" || true)"
    else
      ownership_missing=unknown
    fi
    ownership_total="$(GIT_NO_LAZY_FETCH=1 git ls-tree -r --name-only "$remote_sha" -- data/jobs/by-crawler 2>/dev/null | grep -c . || true)"
    if ! run_bounded "$GIT_COMMIT_DATA_OWNERSHIP_VIEW_TIMEOUT_SECONDS" "git archive remote crawler ownership view" \
      bash -o pipefail -c 'git archive --format=tar "$1" data/jobs/by-crawler | tar -xf - -C "$2"' \
      crawler-ownership-view "$remote_sha" "$GROUPED_OWNERSHIP_VIEW_DIR/snapshot"; then
      echo "❌ grouped-isolated: could not materialise remote crawler slices for ownership guard"
      return 1
    fi
  fi

  GROUPED_OWNERSHIP_VIEW_SHA="$remote_sha"
  if [ "$ownership_missing" = unknown ]; then
    echo "ℹ️ grouped-isolated ownership-view prepared before lease: remote slice count unavailable in $((SECONDS - started_seconds))s"
  elif [ "$ownership_missing" -gt 0 ]; then
    echo "ℹ️ grouped-isolated ownership-view prepared before lease: ${ownership_missing} of ${ownership_total} remote slices fetched on demand in $((SECONDS - started_seconds))s"
  else
    echo "ℹ️ grouped-isolated ownership-view prepared before lease: ${ownership_total} remote slices already available in $((SECONDS - started_seconds))s"
  fi
}

grouped_ownership_view_refresh() {
  local remote_sha="$1" changed_file_list="$2" ownership_root="$3" file
  local -a changed_paths=() present_paths=()
  [ -n "$GROUPED_OWNERSHIP_VIEW_SHA" ] || return 1
  if [ "$GROUPED_OWNERSHIP_VIEW_SHA" != "$remote_sha" ]; then
    if ! GIT_NO_LAZY_FETCH=1 git diff --no-renames --name-only -z \
      "$GROUPED_OWNERSHIP_VIEW_SHA" "$remote_sha" -- data/jobs/by-crawler > "$changed_file_list"; then
      echo "❌ grouped-isolated: could not compare ownership snapshot with current origin/main"
      return 1
    fi
    while IFS= read -r -d '' file; do
      [[ "$file" =~ ^data/jobs/by-crawler/[^/]+\.json$ ]] || continue
      changed_paths+=("$file")
      rm -f -- "$GROUPED_OWNERSHIP_VIEW_DIR/snapshot/$file"
      # A blobless checkout may know the path in the remote tree without
      # having its blob locally. `cat-file -e` with lazy fetch disabled calls
      # that present path absent, so the ownership guard would miss a claim
      # that arrived while the lease was held. Inspect the tree entry instead;
      # the bounded archive below fetches the blob only when it is present.
      if git ls-tree -r --name-only "$remote_sha" -- "$file" 2>/dev/null | grep -Fxq "$file"; then
        present_paths+=("$file")
      fi
    done < "$changed_file_list"
    if [ "${#present_paths[@]}" -gt 0 ]; then
      if ! run_bounded "$GIT_COMMIT_DATA_OWNERSHIP_VIEW_TIMEOUT_SECONDS" "git archive changed crawler ownership slices" \
        bash -o pipefail -c 'sha=$1; dest=$2; shift 2; git archive --format=tar "$sha" -- "$@" | tar -xf - -C "$dest"' \
        crawler-ownership-delta "$remote_sha" "$GROUPED_OWNERSHIP_VIEW_DIR/snapshot" "${present_paths[@]}"; then
        echo "❌ grouped-isolated: could not refresh changed remote crawler slices for ownership guard"
        return 1
      fi
    fi
    GROUPED_OWNERSHIP_VIEW_SHA="$remote_sha"
  fi

  rm -rf -- "$ownership_root"
  mkdir -p "$ownership_root/data/jobs/by-crawler"
  if [ -d "$GROUPED_OWNERSHIP_VIEW_DIR/snapshot/data/jobs/by-crawler" ]; then
    cp -al "$GROUPED_OWNERSHIP_VIEW_DIR/snapshot/data/jobs/by-crawler/." "$ownership_root/data/jobs/by-crawler/"
  fi
  GROUPED_OWNERSHIP_CHANGED_COUNT="${#changed_paths[@]}"
}

# ── Il lease NON deve coprire il sonno del backoff ──────────────────────────
#
# L'acquisizione sta fuori da `commit_isolated_from_worktree` e il commento
# sopra dichiarava che il lease copriva ogni tentativo e ogni push. Copriva
# anche i SONNI, e li' sta il difetto misurato: con `MAX_PUSH_ATTEMPTS=14` e
# `delay = attempt*5 + RANDOM%20`, l'esaustione dorme ~10 minuti tenendo il
# mutex globale. Sommato a `translate-pending` (350 minuti di budget, quattro
# acquisizioni dello stesso lease) e agli scrittori del sito che NON passano dal
# lease e vincono le ref race, l'hold non e' limitato dalla pazienza di nessuno:
# il gruppo 08 ha perso l'attesa piena di 60 minuti DUE volte e ha buttato 27
# crawl su 27 riusciti (run 35404434208, corpus issue #1573).
#
# Restringere il lock e' sicuro per una proprieta' del codice, non per una
# speranza: il loop di retry rifa' `git_fetch_retry` e RICOSTRUISCE l'albero da
# `read-tree "$remote_sha"` — la testa remota CORRENTE — all'inizio di ogni
# tentativo. Quindi il mutex deve coprire un solo `fetch → rebuild → push`, e
# che il remoto si muova durante il sonno e' esattamente il caso che il
# tentativo successivo gestisce per costruzione.
#
# Direzione del fail-safe: se il RILASCIO fallisce si CONTINUA A TENERE il lease
# (il comportamento di oggi, fino al TTL), non si prosegue credendo di averlo
# ceduto. Un lease creduto libero mentre e' tenuto e' peggio della congestione
# che stiamo riparando.
global_data_pipeline_lease_release_for_backoff() {
  [ "${DATA_PIPELINE_LEASE:-0}" = "1" ] || return 0
  [ "${GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED:-0}" = "1" ] || return 0
  local lease_script
  lease_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/global-data-pipeline-lease.mjs"
  if node "$lease_script" release; then
    GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=0
    return 0
  fi
  # Rilascio fallito: il flag resta a 1, quindi il writer continua a comportarsi
  # da detentore e l'EXIT trap riprovera' il rilascio. Nessun `--resume` seguira'
  # (vedi sotto), quindi non si acquisisce due volte.
  echo "::warning::global data-pipeline lease release before backoff failed; keeping the lease for this attempt (expires at TTL)"
  return 1
}

# Riprende il lease dopo il sonno. Attesa breve e DEDICATA
# (`--resume-wait`): il writer aveva gia' il suo turno e lo ha ceduto solo per la
# durata del backoff, quindi rimetterlo in coda per un'ora sarebbe scambiare la
# congestione con una latenza peggiore.
global_data_pipeline_lease_resume_after_backoff() {
  [ "${DATA_PIPELINE_LEASE:-0}" = "1" ] || return 0
  # Se il rilascio non e' andato a buon fine il lease e' ancora nostro: non si
  # ri-acquisisce, o si pagherebbe un'attesa per qualcosa che si possiede.
  [ "${GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED:-0}" = "0" ] || return 0
  local lease_script lease_status
  lease_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/global-data-pipeline-lease.mjs"
  # `lease_status=$?` DEVE stare nel ramo `else`, non dopo il `fi`: dopo il `fi`
  # cattura lo stato del comando composto `if` — che e' 0 quando nessun ramo
  # esegue — non l'uscita di `node`. Con quel bug la funzione rendeva 0 mentre
  # `..._ACQUIRED` restava 0, quindi i chiamanti (`|| return $?`, `|| exit $?`)
  # proseguivano e potevano fare reset/push SENZA il lease globale: l'inverso
  # esatto della garanzia che questa modifica esiste per dare. E' la stessa
  # forma che `global_data_pipeline_lease_acquire` usa da sempre, qui sopra.
  if node "$lease_script" acquire --resume-wait; then
    GLOBAL_DATA_PIPELINE_LEASE_ACQUIRED=1
    return 0
  else
    lease_status=$?
  fi
  echo "::warning::global data-pipeline lease not re-acquired after backoff (exit ${lease_status}); this writer staged nothing and the next scheduled run retries"
  return "$lease_status"
}

# `git fetch` inside the retry loop below is otherwise unguarded under
# `set -e` — a transient network blip (e.g. "Connection reset by peer" under
# ~24 concurrent crawler-group jobs) kills the whole script instantly instead
# of going through the backoff/retry path that exists precisely for this kind
# of race. Retry fetch itself before letting set -e propagate a real failure.
MAX_FETCH_ATTEMPTS=5
git_fetch_retry() {
  local attempts=0
  while true; do
    attempts=$((attempts + 1))
    if run_bounded "$GIT_COMMIT_DATA_FETCH_TIMEOUT_SECONDS" "git fetch origin main" \
      git fetch origin main; then
      return 0
    fi
    if [ "$attempts" -ge "$MAX_FETCH_ATTEMPTS" ]; then
      echo "❌ git fetch origin main failed after ${MAX_FETCH_ATTEMPTS} attempts"
      return 1
    fi
    local delay=$(( attempts * 5 + RANDOM % 6 ))
    echo "⚠️ git fetch origin main failed (attempt ${attempts}/${MAX_FETCH_ATTEMPTS}) — waiting ${delay}s before retry..."
    sleep "$delay"
  done
}

# ── 3+4 loop: Sync, align, commit, push (with retry on race conditions) ────
# 14 attempts with widened jitter: measured on 2026-07-10, a burst of 11
# concurrently-dispatched groups (~290 crawlers pushing to main in the same
# window) exhausted 8 linear-backoff attempts for the race losers
# (richemont/denner, run 29086047473). Overridable per-invocation via env.
MAX_PUSH_ATTEMPTS="${MAX_PUSH_ATTEMPTS:-14}"
push_attempt=0

# Crawler Actions checkouts are shallow (fetch-depth 50). Keep both push paths
# on a complete pack with delta search disabled so Git does not spend the
# retry budget looking for deltas against history absent from the checkout.

# Classify a failed `git push`'s combined output: 0 (true) only for the
# ref-contention class — another writer advanced main between our fetch and
# our push (`! [rejected]` / "fetch first" / "cannot lock ref" /
# "non-fast-forward"). Everything else (outage, DNS, auth/token expiry, hook
# decline, quota) is NOT contention: exhausting retries on those must exit 1,
# not 42 — otherwise a real failure becomes a silently-green step in the
# grouped workflows that absorb 42. Note `\[rejected\]` deliberately does NOT
# match `! [remote rejected]` (pre-receive/protected-branch hook declines):
# those don't self-heal on the next scheduled run, so they stay exit 1;
# server-side ref races still match via "cannot lock ref".
is_push_contention_output() {
  printf '%s' "${1:-}" | grep -qiE '\[rejected\]|fetch first|cannot lock ref|non-fast-forward'
}

# The opposite end: a ruleset / protected-branch decline (GH013 / GH006) is
# permanent for this identity and commit, so it stops the retry loop at the
# first occurrence with exit 1 instead of rebuilding and re-pushing up to
# MAX_PUSH_ATTEMPTS times (recover-prev-slugs run 36759949398: 14 identical
# GH013 over ~11 minutes). Shared with git-push-with-retry.sh.
# shellcheck source=scripts/lib/git-push-rejection.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/git-push-rejection.sh"

# ── GROUPED-ISOLATED path: commit from the worktree WITHOUT touching it ─────
# Used only for crawler-group shared-workspace invocations (SLICE_ONLY=true
# and JOBS_SLICE_FILE set — see the flag assignment above). Builds the commit
# with plumbing against a PRIVATE temporary index:
#
#   read-tree origin/main → update-index (own files only) → write-tree →
#   commit-tree -p origin/main → push <sha>:refs/heads/main
#
# Invariants this guarantees, by construction:
#   • The shared worktree is NEVER written (no stash/rebase/checkout/reset),
#     so a concurrently-running sibling crawler's not-yet-committed files can
#     never be reverted, stashed away, or dropped by THIS crawler's commit —
#     the post-#3701 mass-loss mechanism (frozen summaries, commits pushed
#     without the crawler's own files) is structurally impossible.
#   • The shared .git/index is never locked or mutated, so a crash here can't
#     leave an index.lock (or an orphaned stash entry holding sibling data).
#   • Remote races are resolved by rebuilding the tree on the freshly fetched
#     origin/main and retrying the push — no local rebase needed. Files that
#     changed on the remote since checkout (e.g. the shared
#     a slice updated by translate-pending) are 3-way merged content-wise (base
#     = checkout HEAD, remote = origin/main, local = worktree) via the same
#     merge_json_3way
#     used by the legacy path, so concurrent remote additions survive.
merge_crawler_generation_ledger() {
  local remote_file="$1" local_file="$2" output_file="$3"
  node --input-type=module - "$remote_file" "$local_file" "$output_file" "$(dirname "$0")/../crawler-group-generation-finalizer.mjs" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [remotePath, localPath, outputPath, finalizerPath] = process.argv.slice(2);
const { validateCrawlerGenerationLedgerEntry } = await import(pathToFileURL(finalizerPath).href);
function readLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.length === 0) return [];
  if (!raw.endsWith('\n')) throw new Error(`partial crawler generation ledger: ${filePath}`);
  return raw.split('\n').slice(0, -1).map((line, index) => {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error(`invalid crawler generation ledger JSON at ${filePath}:${index + 1}`); }
    const validation = validateCrawlerGenerationLedgerEntry(entry);
    if (!validation.valid) throw new Error(`invalid crawler generation ledger record at ${filePath}:${index + 1}: ${validation.errors.join(', ')}`);
    return entry;
  });
}
const merged = new Map();
for (const entry of [...readLedger(remotePath), ...readLedger(localPath)]) {
  const existing = merged.get(entry.digest);
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(`conflicting crawler generation ledger records for ${entry.digest}`);
  merged.set(entry.digest, entry);
}
const lines = [...merged.values()].map((entry) => JSON.stringify(entry));
if (lines.length > 0) {
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
} else {
  // An absent ledger and an empty ledger are both read as an empty history,
  // but only the former preserves the append-only contract when no record was
  // ever written. Do not manufacture a zero-byte tracked file from a merge
  // of two absent/empty inputs.
  fs.rmSync(outputPath, { force: true });
}
NODE
}

# ── The private index on a partial clone ─────────────────────────────────────
# The private index is seeded with the WHOLE remote tree (`read-tree
# "$remote_sha"`) and then receives only this writer's files. A plain
# `git write-tree` insists that every blob named by the index exists locally,
# and on a partial clone it makes that true: one bulk fetch from the promisor
# of every blob the checkout had left out. The three monitors that commit a
# single series check out with `filter: blob:none` precisely not to download
# the repository, and paid for all of it at commit time instead.
#   Measured on unsubscribe-credential-monitor: from "1 file(s) computed" to
#   the push result, 298 s on 2026-10-06 (run 37479001157) and 321 s on
#   2026-10-08 (run 37756906498), where the push then lost the race for `main`
#   and the rebuilt second attempt (blobs already local) took 19 s. The job
#   cap is 10 minutes. On a partial clone of the real repository the same
#   index is written by `write-tree --missing-ok` in 0.09 s.
# `--missing-ok` is the right contract here, not a shortcut: every blob in the
# tree is either one the remote already has (it came from `remote_sha`) or one
# this run wrote, and the second kind is vouched for explicitly, one by one,
# by stage_isolated_blob below. That check is also stricter than the implicit
# one it replaces: `update-index --cacheinfo` records any id it is handed.
stage_isolated_blob() {
  local index_file="$1" mode="$2" blob="$3" path="$4"
  if [ -z "$blob" ] || ! GIT_NO_LAZY_FETCH=1 git cat-file -e "${blob}^{blob}" 2>/dev/null; then
    echo "❌ grouped-isolated: the blob to stage for $path is not in the local object store (${blob:-empty id}) — refusing to publish a tree that references it"
    return 1
  fi
  if ! GIT_INDEX_FILE="$index_file" git update-index --add --cacheinfo "${mode},${blob},${path}"; then
    echo "❌ grouped-isolated: could not stage $path in the private index — refusing a commit that would silently leave it out"
    return 1
  fi
}

# Prints the tree id on stdout. This function runs with errexit suspended
# (its caller is invoked through `||`), so a failed write must be turned into
# a return code here: an empty tree id used to flow into `commit-tree`, and
# the empty commit id that followed into `git push origin :refs/heads/main`,
# which is a request to DELETE the branch.
write_isolated_tree() {
  local index_file="$1" tree
  if ! tree="$(GIT_INDEX_FILE="$index_file" git write-tree --missing-ok)" || [ -z "$tree" ]; then
    echo "❌ grouped-isolated: git write-tree failed — refusing to build a commit from an unwritten tree" >&2
    return 1
  fi
  printf '%s\n' "$tree"
}

append_translation_stats_to_index() {
  local tmp_index="$1"
  local tree_sha="$2"
  local stats_root stats_file stats_blob

  stats_root="$(mktemp -d /tmp/translation-stats-tree.XXXXXX)"
  stats_file="$stats_root/data/translation-stats-history.json"
  mkdir -p "$stats_root/data/jobs/by-crawler"

  if git cat-file -e "$tree_sha:data/jobs/by-crawler" 2>/dev/null; then
    if ! git archive --format=tar "$tree_sha" data/jobs/by-crawler | tar -xf - -C "$stats_root"; then
      echo "❌ translation stats: could not materialise candidate crawler slices"
      rm -rf "$stats_root"
      return 1
    fi
  fi

  if git cat-file -e "$tree_sha:data/translation-stats-history.json" 2>/dev/null; then
    if ! git cat-file blob "$tree_sha:data/translation-stats-history.json" > "$stats_file"; then
      echo "❌ translation stats: could not read the candidate history blob"
      rm -rf "$stats_root"
      return 1
    fi
  else
    printf '[]\n' > "$stats_file"
  fi

  if ! TRANSLATION_STATS_ROOT="$stats_root" node scripts/log-translation-stats.mjs after; then
    echo "❌ translation stats: after snapshot failed on the candidate tree"
    rm -rf "$stats_root"
    return 1
  fi

  if [ ! -f "$stats_file" ]; then
    echo "❌ translation stats: after snapshot did not write $stats_file"
    rm -rf "$stats_root"
    return 1
  fi
  stats_blob="$(git hash-object -w -- "$stats_file")"
  if ! stage_isolated_blob "$tmp_index" "100644" "$stats_blob" "data/translation-stats-history.json"; then
    rm -rf "$stats_root"
    return 1
  fi
  rm -rf "$stats_root"
}

# ── Where an isolated attempt spends its time ────────────────────────────────
# One line per attempt. Most of this path runs inside the global data-pipeline
# lease, and most of it is silent: a stall used to be visible
# only as a gap between two log timestamps. Issue 12379 measured 52-197 s
# without a single log line in the first attempt of the crawler groups, and
# the blobless write-tree fixed in PR 12388 cost 298-321 s the same way.
# Observation only: nothing here changes what is staged, merged or pushed.
declare -A _ISOLATED_PHASE_MS=()
declare -A _ISOLATED_PHASE_NOTE=()
declare -A _ISOLATED_FILE_PHASE_MS=()
_ISOLATED_PHASE_ORDER=()
_ISOLATED_FILE_CURRENT=""
_ISOLATED_FILE_STARTED=0
_ISOLATED_SLOWEST_FILE=""
_ISOLATED_SLOWEST_FILE_MS=0
# The parts of the per-file loop that run a subprocess over whole slices.
_ISOLATED_FILE_PHASES=(retirement-history ownership merge integrity)

# isolated_mark <variable>: monotonic elapsed milliseconds since this shell
# started, without a fork. The timing is observational; second resolution is
# sufficient for the multi-second phases measured here.
isolated_mark() {
  printf -v "$1" '%s' "$(( SECONDS * 1000 ))"
}

isolated_phase_reset() {
  _ISOLATED_PHASE_MS=()
  _ISOLATED_PHASE_NOTE=()
  _ISOLATED_FILE_PHASE_MS=()
  _ISOLATED_PHASE_ORDER=()
  _ISOLATED_FILE_CURRENT=""
  _ISOLATED_SLOWEST_FILE=""
  _ISOLATED_SLOWEST_FILE_MS=0
}

# isolated_phase_add <label> <started_ms>: the phases of the attempt, in order.
isolated_phase_add() {
  local label="$1" started="$2" now spent
  isolated_mark now
  if [ -z "${_ISOLATED_PHASE_MS[$label]+set}" ]; then
    _ISOLATED_PHASE_ORDER+=("$label")
    _ISOLATED_PHASE_MS[$label]=0
  fi
  spent="${_ISOLATED_PHASE_MS[$label]}"
  _ISOLATED_PHASE_MS[$label]=$(( spent + now - started ))
}

# isolated_file_phase_add <label> <started_ms>: what the per-file loop is made of.
isolated_file_phase_add() {
  local label="$1" started="$2" now spent
  isolated_mark now
  spent="${_ISOLATED_FILE_PHASE_MS[$label]:-0}"
  _ISOLATED_FILE_PHASE_MS[$label]=$(( spent + now - started ))
}

# isolated_file_begin <path>: closes the previous file and starts the clock for
# this one, so a file that leaves the loop body early is still accounted for.
isolated_file_begin() {
  isolated_file_end
  _ISOLATED_FILE_CURRENT="$1"
  isolated_mark _ISOLATED_FILE_STARTED
}

isolated_file_end() {
  local now spent
  [ -n "$_ISOLATED_FILE_CURRENT" ] || return 0
  isolated_mark now
  spent=$(( now - _ISOLATED_FILE_STARTED ))
  if [ "$spent" -gt "$_ISOLATED_SLOWEST_FILE_MS" ]; then
    _ISOLATED_SLOWEST_FILE_MS="$spent"
    _ISOLATED_SLOWEST_FILE="$_ISOLATED_FILE_CURRENT"
  fi
  _ISOLATED_FILE_CURRENT=""
}

isolated_format_ms() {
  printf '%d.%d s' "$(( $1 / 1000 ))" "$(( ($1 % 1000) / 100 ))"
}

isolated_phase_report() {
  local attempt="$1" label sub line="" detail
  for label in ${_ISOLATED_PHASE_ORDER[@]+"${_ISOLATED_PHASE_ORDER[@]}"}; do
    line+="${line:+, }${label} $(isolated_format_ms "${_ISOLATED_PHASE_MS[$label]}")"
    detail="${_ISOLATED_PHASE_NOTE[$label]:-}"
    if [ "$label" = files ]; then
      for sub in "${_ISOLATED_FILE_PHASES[@]}"; do
        # Under a tenth of a second a sub-phase is measurement noise.
        [ "${_ISOLATED_FILE_PHASE_MS[$sub]:-0}" -ge 100 ] || continue
        detail+="${detail:+, }${sub} $(isolated_format_ms "${_ISOLATED_FILE_PHASE_MS[$sub]}")"
      done
      # One slow file and many quick ones call for different fixes.
      if [ "$_ISOLATED_SLOWEST_FILE_MS" -ge 1000 ]; then
        detail+="${detail:+; }slowest ${_ISOLATED_SLOWEST_FILE} $(isolated_format_ms "$_ISOLATED_SLOWEST_FILE_MS")"
      fi
    fi
    [ -z "$detail" ] || line+=" (${detail})"
  done
  echo "⏱️ grouped-isolated attempt ${attempt} timings: ${line:-nothing measured}"
}

commit_isolated_from_worktree() {
  local base_sha remote_sha remote_tree new_tree new_commit
  local tmp_index merge_dir
  local f local_blob remote_blob base_blob history_blob history_status blob_to_stage key_hint mode_to_stage local_merge_path candidate_path conflict_scan_path
  local snapshot_operation snapshot_state registry_status
  local ownership_root ownership_base_path ownership_remote_path ownership_output_path ownership_result crawler_key ownership_helper
  local has_primary_slice=false delay
  local -a effective_files
  local skipped_identical
  local result_key result_cacheable ownership_verdict proof_digest owned_blob reused_count computed_count
  local guarded_deadline guard_timeout push_timeout
  local phase_started file_phase_started ownership_changed_count

  base_sha="$(git rev-parse HEAD)"
  tmp_index="$(mktemp /tmp/crawler-commit-index.XXXXXX)"
  merge_dir="$(mktemp -d /tmp/crawler-commit-merge.XXXXXX)"
  ownership_helper="$(dirname "$0")/crawler-commit-ownership.mjs"
  # has_primary_slice is recomputed per attempt on the effective file list
  # (see the identical-to-remote filter inside the retry loop).
  # shellcheck disable=SC2064
  trap "rm -f '$tmp_index'; rm -rf '$merge_dir'" RETURN

  # Conflict-marker guard on the exact worktree files we are about to stage
  # (the staged-diff variant can't be used: nothing is ever staged in the
  # shared index on this path).
  for f in "${RESOLVED_FILES[@]}"; do
    if [ "$GROUP_BATCH" = true ]; then
      [ "${_BATCH_SNAPSHOT_STATE[$f]}" = "present" ] || continue
      if ! git cat-file blob "${_BATCH_SNAPSHOT_BLOB[$f]}" > "$merge_dir/conflict-scan"; then
        echo "❌ crawler group batch: snapshot blob disappeared before commit for $f"
        return 1
      fi
      conflict_scan_path="$merge_dir/conflict-scan"
    else
      [ -f "$f" ] || continue
      conflict_scan_path="$f"
    fi
    if grep -qE '^(<<<<<<< |======= ?$|>>>>>>> )' "$conflict_scan_path" 2>/dev/null; then
      echo "❌ grouped-isolated: refusing to commit — unresolved merge conflict markers in $f"
      echo "   For job slice files specifically: node scripts/recover-conflict-marker-slices.mjs"
      return 1
    fi
  done

  while true; do
    push_attempt=$((push_attempt + 1))
    isolated_phase_reset
    ensure_git_auth
    isolated_mark phase_started
    git_fetch_retry || return 1
    isolated_phase_add fetch "$phase_started"
    isolated_mark phase_started
    old_history_guard_main || return 1
    isolated_phase_add history-guard "$phase_started"
    remote_sha="$(git rev-parse origin/main)"
    remote_tree="$(git rev-parse "${remote_sha}^{tree}")"

    # HEAD (base_sha) deliberately never advances after a push, so a directory
    # path expands on every later commit of the run to ALL the slices touched
    # since the run began, including those already published and byte-identical
    # to origin/main. The private index is seeded from remote_sha, so staging
    # such a file is a no-op by construction: skip it before it costs an
    # ownership check, a 3-way merge and an integrity check (and, when no
    # primary slice is left, the remote ownership archive). Absent files
    # (explicit deletions), ignored files and files missing on the remote are
    # never skipped; --group-batch is snapshot-bound and is left untouched.
    isolated_mark phase_started
    effective_files=()
    skipped_identical=0
    has_primary_slice=false
    for f in "${RESOLVED_FILES[@]}"; do
      if [ "$GROUP_BATCH" != true ] && [ -f "$f" ] && ! git check-ignore -q "$f" 2>/dev/null; then
        remote_blob="$(git rev-parse -q --verify "${remote_sha}:${f}" 2>/dev/null || true)"
        if [ -n "$remote_blob" ] && [ "$(git hash-object -- "$f")" = "$remote_blob" ]; then
          skipped_identical=$((skipped_identical + 1))
          continue
        fi
      fi
      effective_files+=("$f")
      if [[ "$f" == data/jobs/by-crawler/*.json ]]; then
        if [ "$GROUP_BATCH" = true ]; then
          [ "${_BATCH_SNAPSHOT_STATE[$f]:-absent}" = present ] && has_primary_slice=true
        elif [ -f "$f" ]; then
          has_primary_slice=true
        fi
      fi
    done
    isolated_phase_add skip-scan "$phase_started"
    echo "ℹ️ grouped-isolated attempt ${push_attempt}: ${skipped_identical} file(s) skipped because identical to origin/main, ${#effective_files[@]} candidate(s)"

    # A concurrent main update can turn a file that was identical during the
    # pre-lease scan into a candidate. Do not fetch the full ownership archive
    # while holding the cross-repository lease: yield it, prepare from this
    # exact remote tip, then restart the attempt against a fresh fetch.
    if [ "$has_primary_slice" = true ] && [ -z "$GROUPED_OWNERSHIP_VIEW_SHA" ]; then
      global_data_pipeline_lease_release_for_backoff || return 1
      grouped_ownership_view_prepare "$remote_sha" || return 1
      global_data_pipeline_lease_resume_after_backoff || return $?
      push_attempt=$((push_attempt - 1))
      continue
    fi

    # Private index seeded from the CURRENT remote head — never the shared
    # .git/index (GIT_INDEX_FILE scopes every index operation below).
    isolated_mark phase_started
    GIT_INDEX_FILE="$tmp_index" git read-tree "$remote_sha"
    isolated_phase_add seed-index "$phase_started"
    reused_count=0
    computed_count=0

    # A crawler group can be the second writer to main even when its checkout
    # started from the same base as the first writer. The ownership snapshot
    # was materialised before the lease; refresh only paths changed since that
    # snapshot, then add this attempt's filtered local slices as we go. A clean
    # copy per attempt prevents candidate overlays from leaking into retries.
    isolated_mark phase_started
    if [ "$has_primary_slice" = true ]; then
      ownership_root="$merge_dir/remote-ownership"
      grouped_ownership_view_refresh "$remote_sha" "$merge_dir/ownership-changed-paths" "$ownership_root" || return 1
      ownership_changed_count="$GROUPED_OWNERSHIP_CHANGED_COUNT"
      _ISOLATED_PHASE_NOTE[ownership-view]="${ownership_changed_count} remote slice(s) refreshed since last snapshot"
      isolated_phase_add ownership-view "$phase_started"
    fi

    isolated_mark phase_started
    for f in ${effective_files[@]+"${effective_files[@]}"}; do
      isolated_file_begin "$f"
      remote_blob="$(git rev-parse -q --verify "${remote_sha}:${f}" 2>/dev/null || true)"
      local_merge_path="$f"
      candidate_path="$local_merge_path"
      canonicalization_base_path=""
      canonicalization_proof_path=""
      mode_to_stage="100644"

      if [ "$GROUP_BATCH" = true ]; then
        snapshot_operation="${_BATCH_SNAPSHOT_OPERATION[$f]}"
        snapshot_state="${_BATCH_SNAPSHOT_STATE[$f]}"
        base_blob="${_BATCH_SNAPSHOT_BASE_BLOB[$f]}"

        # An unchanged path is attribution-only. Leaving the freshly-seeded
        # remote entry untouched preserves any newer remote writer without
        # manufacturing a change from this crawler's old base snapshot.
        if [ "$snapshot_operation" = "unchanged" ]; then
          continue
        fi

        if [ "$snapshot_state" = "absent" ]; then
          if [ -z "$remote_blob" ]; then
            continue
          fi
          if [ "$remote_blob" != "$base_blob" ]; then
            echo "❌ crawler group batch: delete conflicts with a newer remote blob for $f"
            return 1
          fi
          GIT_INDEX_FILE="$tmp_index" git update-index --force-remove -- "$f"
          continue
        fi

        local_blob="${_BATCH_SNAPSHOT_BLOB[$f]}"
        mode_to_stage="${_BATCH_SNAPSHOT_MODE[$f]}"
        mkdir -p "$merge_dir/local/$(dirname "$f")"
        if ! git cat-file blob "$local_blob" > "$merge_dir/local/$f"; then
          echo "❌ crawler group batch: snapshot blob disappeared during retry for $f"
          return 1
        fi
        local_merge_path="$merge_dir/local/$f"
        if git check-ignore -q "$f" 2>/dev/null; then
          echo "❌ crawler group batch: descriptor path is ignored and cannot be committed: $f"
          return 1
        fi
      else
        # The legacy isolated path still reads its caller's current worktree.
        # Only --group-batch is snapshot-bound by the deferred descriptors.
        base_blob="$(git rev-parse -q --verify "${base_sha}:${f}" 2>/dev/null || true)"
        if [ ! -f "$f" ]; then
          # --extra-only names its complete ownership surface explicitly. A
          # missing named file is therefore a requested deletion, not an
          # unrelated absent path to skip. Delete only the blob this checkout
          # actually observed; a newer remote value belongs to another writer
          # and must fail closed instead of being erased.
          [ "$EXTRA_ONLY" = true ] || continue
          [ -n "$remote_blob" ] || continue
          if [ -z "$base_blob" ] || [ "$remote_blob" != "$base_blob" ]; then
            echo "❌ grouped-isolated: explicit delete conflicts with a newer remote blob for $f"
            return 1
          fi
          if is_job_slice_path "$f"; then
            integrity_dir="$merge_dir/integrity-delete"
            mkdir -p "$integrity_dir"
            if ! git cat-file blob "$remote_blob" > "$integrity_dir/previous.json"; then
              echo "❌ grouped-isolated: could not materialize crawler slice for delete integrity guard: $f"
              return 1
            fi
            printf '[]\n' > "$integrity_dir/next.json"
            integrity_args=(
              "$f"
              "$integrity_dir/previous.json"
              "$integrity_dir/next.json"
            )
            housekeeping_proof_path="$(housekeeping_proof_path_for_file "$f")"
            if [ -f "$housekeeping_proof_path" ]; then
              integrity_args+=(
                "$housekeeping_proof_path"
                "$integrity_dir/previous.json"
                "$integrity_dir/next.json"
              )
            fi
            integrity_exit=0
            isolated_mark file_phase_started
            HOUSEKEEPING_BASE_SHA="$base_sha" node "$(dirname "$0")/crawler-slice-integrity.mjs" "${integrity_args[@]}" \
              || integrity_exit=$?
            isolated_file_phase_add integrity "$file_phase_started"
            case "$integrity_exit" in
              0) ;;
              1)
                echo "❌ grouped-isolated: refusing catastrophic crawler slice deletion: $f"
                return 1
                ;;
              3)
                echo "❌ grouped-isolated: catastrophic crawler slice deletion with a rejected housekeeping proof: $f"
                return 1
                ;;
              *)
                echo "❌ grouped-isolated: crawler slice delete integrity check crashed (exit $integrity_exit) for $f"
                return 1
                ;;
            esac
          fi
          GIT_INDEX_FILE="$tmp_index" git update-index --force-remove -- "$f"
          computed_count=$((computed_count + 1))
          continue
        fi
        if git check-ignore -q "$f" 2>/dev/null; then
          continue
        fi
        local_blob="$(git hash-object -w -- "$f")"
      fi

      if [[ "$f" == data/jobs/expired/by-crawler/*.json ]]; then
        mkdir -p "$merge_dir/candidate/$(dirname "$f")"
        cp "$local_merge_path" "$merge_dir/candidate/$f"
        candidate_path="$merge_dir/candidate/$f"
      fi

      # A finalizer always appends a JSONL record before the ledger reaches
      # this step. If an explicit --extra-only caller nevertheless presents a
      # brand-new zero-byte ledger, treat it like the absent path instead of
      # publishing a durable empty file that changes the history shape.
      if [ "$f" = "data/crawler-generation-ledger.jsonl" ] \
        && [ "$GROUP_BATCH" != true ] \
        && [ -f "$f" ] && [ ! -s "$f" ] \
        && [ -z "$remote_blob" ] && [ -z "$base_blob" ]; then
        echo "ℹ️ crawler generation ledger is empty and absent from origin/main — preserving absence"
        continue
      fi

      # A missing remote path is not automatically a writable empty slot.
      # Snapshot-bound batches and shared group workers keep their established
      # base-aware rules. Sequential primary-slice writers additionally consult
      # the positive roster, so a post-retirement checkout cannot mistake an
      # unregistered slice for a first-run create.
      if [ -z "$remote_blob" ]; then
        if [ "$GROUP_BATCH" = true ]; then
          if [ -n "$base_blob" ]; then
            echo "❌ crawler group batch: snapshot conflicts with a newer remote deletion for $f (class=$(classify_batch_snapshot_path "$f"))"
            return 1
          fi
        elif [ -n "${JOBS_SLICE_FILE:-}" ]; then
          # Shared crawler-group workers retain their established base-aware
          # policy. Their generated descriptors and final batch provide the
          # separate retirement boundary; the registry fix here is scoped to
          # sequential directory-wide writers.
          if [ -n "$base_blob" ] && is_job_slice_path "$f"; then
            echo "⚠️ grouped-isolated: $f was deleted upstream after checkout — preserving remote deletion and dropping stale local modification"
            continue
          fi
        else
          case "$f" in
            data/jobs/by-crawler/*.json)
              if is_registered_primary_slice "$f"; then
                if [ -n "$base_blob" ]; then
                  echo "⚠️ grouped-isolated: $f disappeared upstream but remains in crawler-generation-roster.json — refusing to infer retirement, skipping this slice only (rest of batch continues)"
                  continue
                fi
                # A registered path absent from both base and remote is a
                # genuine first-run create, not a resurrection.
              else
                registry_status=$?
                if [ "$registry_status" -ne 1 ]; then
                  # Roster validation error (exit 2, e.g. corrupt/unreadable
                  # roster): fail closed on THIS slice only. A `return 1` here
                  # would propagate out of commit_isolated_from_worktree and
                  # abort every other file already queued in this invocation
                  # (issue #7222) — a transient roster read failure has no
                  # bearing on files that don't need registry lookups.
                  echo "⚠️ grouped-isolated: cannot validate primary slice registry for $f — skipping this slice only (rest of batch continues)"
                  continue
                fi
                # `base_blob` only reflects the CURRENT tree at this writer's
                # checkout, which every CI job starts fresh from origin/main —
                # so it is empty just as often for a path that was already
                # retired before checkout as for one that has genuinely never
                # existed. Distinguish the two with reachable history instead:
                # a path that was ever committed still shows up in local `git
                # log` even after being removed from the tree, while a
                # genuinely new slice has no history at all. On the shallow
                # crawler-group checkout, an empty local log is completed by a
                # one-result GitHub Commits API lookup (issue #12457), not by
                # downloading the entire main history. Any unavailable API
                # proof remains fail-closed so a retired path cannot be
                # resurrected silently.
                isolated_mark file_phase_started
                if ! history_blob="$(GIT_NO_LAZY_FETCH=1 git log -1 --format=%H -- "$f" 2>/dev/null)"; then
                  echo "❌ grouped-isolated: cannot read local retirement history for $f — refusing to guess between first-run create and resurrection"
                  return 1
                fi
                history_status=1
                if [ -n "$history_blob" ]; then
                  history_status=0
                elif [ "$(git rev-parse --is-shallow-repository 2>/dev/null || true)" = "true" ]; then
                  if lookup_remote_path_history "$f" "$remote_sha"; then
                    history_status=0
                  else
                    history_status=$?
                  fi
                fi
                isolated_file_phase_add retirement-history "$file_phase_started"
                case "$history_status" in
                  1)
                  echo "⚠️ grouped-isolated: $f is absent from the primary slice registry and has no prior history — treating as an unregistered first-run create instead of dropping (roster may not be pre-registered yet)"
                  ;;
                  0)
                  echo "⚠️ grouped-isolated: $f is absent from the primary slice registry — preserving retirement and dropping local content"
                  continue
                  ;;
                  *)
                    echo "❌ grouped-isolated: cannot verify retirement history for $f — refusing to guess between first-run create and resurrection"
                    return 1
                    ;;
                esac
              fi
              ;;
            data/jobs/expired/by-crawler/*.json)
              if [ -n "$base_blob" ]; then
                echo "⚠️ grouped-isolated: $f was deleted upstream after checkout — preserving remote deletion and dropping stale local modification"
                continue
              fi
              ;;
          esac
        fi
      fi

      # Retry reuse. Everything below (ownership filter, 3-way merge, archive
      # canonicalization, integrity guard) is a pure function of the remote,
      # local and base blobs of THIS file plus its housekeeping proof — except
      # the ownership filter when the slice brings new claims, which reads
      # every remote slice and is therefore never reused. A rejected push used
      # to redo all of it for every file: ~2.4 s x ~560 slices = ~20 min per
      # attempt for translate-pending, long enough for main to move again, so
      # corpus runs 36280478724/36298797251 spent 6+ attempts (140+ min) here
      # until the 350-minute job cap killed them with nothing published.
      # Now only the files whose remote blob changed are recomputed.
      proof_digest="-"
      if [[ "$f" == data/jobs/by-crawler/*.json || "$f" == data/jobs/expired/by-crawler/*.json ]]; then
        housekeeping_proof_path="$(housekeeping_proof_path_for_file "$f")"
        if [ -f "$housekeeping_proof_path" ]; then
          proof_digest="$(git hash-object -- "$housekeeping_proof_path")"
        fi
      fi
      result_key="${remote_blob:--}|${local_blob:--}|${base_blob:--}|${mode_to_stage}|${proof_digest}"
      if [ -n "${_ISOLATED_RESULT_KEY[$f]:-}" ] && [ "${_ISOLATED_RESULT_KEY[$f]}" = "$result_key" ]; then
        if [[ "$f" == data/jobs/by-crawler/*.json ]]; then
          # Keep the ownership view in step for the later slices of this
          # attempt, exactly as the computed path does.
          mkdir -p "$ownership_root/data/jobs/by-crawler"
          rm -f -- "$ownership_root/$f"
          git cat-file blob "${_ISOLATED_RESULT_OWNED_BLOB[$f]}" > "$ownership_root/$f"
        fi
        stage_isolated_blob "$tmp_index" "$mode_to_stage" "${_ISOLATED_RESULT_BLOB[$f]}" "$f" || return 1
        reused_count=$((reused_count + 1))
        continue
      fi
      unset "_ISOLATED_RESULT_KEY[$f]"
      result_cacheable=true
      # A housekeeping proof is judged against run-time context by the
      # integrity guard: never reuse a verdict that consulted one.
      [ "$proof_digest" = "-" ] || result_cacheable=false
      computed_count=$((computed_count + 1))

      # The housekeeping proof binds to the slice cleanup-jobs wrote, i.e. this
      # crawler's own snapshot BEFORE the ownership filter and any 3-way merge.
      proof_candidate_source="$local_merge_path"

      if [[ "$f" == data/jobs/by-crawler/*.json ]]; then
        crawler_key="${f##*/}"
        crawler_key="${crawler_key%.json}"
        ownership_base_path="-"
        if [ -n "$base_blob" ]; then
          ownership_base_path="$merge_dir/ownership-base/$f"
          mkdir -p "$(dirname "$ownership_base_path")"
          if ! git cat-file blob "$base_blob" > "$ownership_base_path"; then
            echo "❌ grouped-isolated: could not read base slice for ownership guard: $f"
            return 1
          fi
        fi
        ownership_remote_path="-"
        if [ -n "$remote_blob" ]; then
          ownership_remote_path="$merge_dir/ownership-remote/$f"
          mkdir -p "$(dirname "$ownership_remote_path")"
          if ! git cat-file blob "$remote_blob" > "$ownership_remote_path"; then
            echo "❌ grouped-isolated: could not read remote slice for ownership guard: $f"
            return 1
          fi
        fi
        ownership_output_path="$merge_dir/ownership-filtered/$f"
        mkdir -p "$(dirname "$ownership_output_path")"
        rm -f "$merge_dir/ownership-verdict"
        isolated_mark file_phase_started
        if ! ownership_result="$(node "$ownership_helper" \
          "$crawler_key" \
          "$ownership_base_path" \
          "$local_merge_path" \
          "$ownership_root" \
          "$ownership_output_path" \
          "$merge_dir/ownership-verdict" \
          "$ownership_remote_path")"; then
          echo "❌ grouped-isolated: crawler ownership guard failed for $f"
          return 1
        fi
        isolated_file_phase_add ownership "$file_phase_started"
        ownership_verdict="$(cat "$merge_dir/ownership-verdict" 2>/dev/null || true)"
        # Only a result that did not read the remote ownership view may be
        # reused on the next attempt (fail closed on a missing verdict).
        [ "$ownership_verdict" = "skipped" ] || result_cacheable=false
        local_blob="$(git hash-object -w -- "$ownership_output_path")"
        local_merge_path="$ownership_output_path"
        mkdir -p "$ownership_root/data/jobs/by-crawler"
        rm -f -- "$ownership_root/$f"
        cp "$ownership_output_path" "$ownership_root/$f"
        if [ "$ownership_result" != '{"dropped":[]}' ]; then
          echo "⚠️ grouped-isolated: ownership guard filtered claims from $f: $ownership_result"
        fi
      fi

      blob_to_stage="$local_blob"

      # Remote moved for this file since our checkout AND disagrees with our
      # local content → merge instead of clobbering (keeps e.g. translation
      # updates or another group's slice pushed mid-run).
      isolated_mark file_phase_started
      if { [[ "$f" == *.json ]] || [ "$f" = "data/crawler-generation-ledger.jsonl" ]; } \
        && [ -n "$remote_blob" ] \
        && [ "$remote_blob" != "$local_blob" ] \
        && { [ "$remote_blob" != "$base_blob" ] || [ "$local_blob" != "$base_blob" ]; }; then
        # Merge both one-sided changes too. When only local changed, the
        # remote/base equality fast path still has to bank an active slug that
        # local removed; direct staging would bypass that safety net.
        key_hint=""
        is_job_slice_path "$f" && key_hint="url"
        mkdir -p "$merge_dir/base/$(dirname "$f")" "$merge_dir/remote/$(dirname "$f")" "$merge_dir/out/$(dirname "$f")"
        if [ -n "$base_blob" ]; then
          git cat-file blob "$base_blob" > "$merge_dir/base/$f"
        else
          rm -f "$merge_dir/base/$f"
        fi
        git cat-file blob "$remote_blob" > "$merge_dir/remote/$f"
        if [ "$f" = "data/crawler-generation-ledger.jsonl" ]; then
          if ! merge_crawler_generation_ledger "$merge_dir/remote/$f" "$local_merge_path" "$merge_dir/out/$f"; then
            echo "❌ grouped-isolated: crawler generation ledger merge failed for $f — refusing to drop durable history"
            return 1
          fi
          candidate_path="$merge_dir/out/$f"
          blob_to_stage="$(git hash-object -w -- "$merge_dir/out/$f")"
        elif merge_data_json_3way \
          "$merge_dir/base/$f" \
          "$merge_dir/remote/$f" \
          "$local_merge_path" \
          "$merge_dir/out/$f" \
          "$key_hint" \
          "$f"; then
          candidate_path="$merge_dir/out/$f"
          blob_to_stage="$(git hash-object -w -- "$merge_dir/out/$f")"
        else
          if [ "$GROUP_BATCH" = true ]; then
            echo "❌ crawler group batch: snapshot merge failed for $f — refusing a partial commit"
            return 1
          fi
          # Preserve the established non-batch policy for sequential callers.
          echo "⚠️ grouped-isolated: 3-way merge failed for $f — keeping local content"
        fi
        isolated_file_phase_add merge "$file_phase_started"
      fi

      # Archive canonicalization and the integrity guard, measured together.
      isolated_mark file_phase_started
      if [[ "$f" == data/jobs/expired/by-crawler/*.json ]]; then
        canonicalization_base_path="$merge_dir/canonicalization-base.json"
        canonicalization_proof_path="$merge_dir/canonicalization-proof.json"
        rm -f "$canonicalization_proof_path"
        if ! cp "$candidate_path" "$canonicalization_base_path"; then
          echo "❌ grouped-isolated: could not snapshot expired archive before route canonicalization: $f"
          return 1
        fi
        if ! node "$(dirname "$0")/../ci/canonicalize-expired-archive-slice.mjs" \
          "$candidate_path" "$f" "$canonicalization_proof_path"; then
          echo "❌ grouped-isolated: expired archive route canonicalization failed for $f"
          return 1
        fi
        blob_to_stage="$(git hash-object -w -- "$candidate_path")"
      fi

      # Guard the exact blob that will enter the isolated commit, after the
      # ownership filter and any 3-way merge. This closes the gap where a
      # writer-level check passed but the final commit merge reintroduced a
      # catastrophic accumulator shrink.
      if [[ "$f" == data/jobs/by-crawler/*.json || "$f" == data/jobs/expired/by-crawler/*.json ]] \
        && [ -n "$remote_blob" ]; then
        integrity_dir="$merge_dir/integrity"
        mkdir -p "$integrity_dir"
        if ! git cat-file blob "$remote_blob" > "$integrity_dir/previous.json" \
          || ! git cat-file blob "$blob_to_stage" > "$integrity_dir/next.json"; then
          echo "❌ grouped-isolated: could not materialize crawler slice for integrity guard: $f"
          return 1
        fi
        integrity_args=(
          "$f"
          "$integrity_dir/previous.json"
          "$integrity_dir/next.json"
        )
        housekeeping_proof_path="$(housekeeping_proof_path_for_file "$f")"
        if [ -f "$housekeeping_proof_path" ]; then
          # A proof that appeared after the reuse-key check still makes this
          # verdict run-context dependent: never reuse it on a later attempt.
          result_cacheable=false
          # Consulted only if the staged blob is a catastrophic shrink. Its base
          # is the slice cleanup-jobs read (the crawler's fresh output), which
          # no git blob here reproduces: pass `-` and bind by the candidate
          # digest plus run id, attempt and checkout HEAD instead.
          proof_candidate_path="$integrity_dir/candidate.json"
          if ! cp "$proof_candidate_source" "$proof_candidate_path"; then
            echo "❌ grouped-isolated: could not materialize housekeeping proof candidate for $f"
            return 1
          fi
          integrity_args+=("$housekeeping_proof_path" "-" "$proof_candidate_path")
        fi
        if [ -f "${canonicalization_proof_path:-}" ]; then
          if [ "${#integrity_args[@]}" -eq 3 ]; then
            integrity_args+=("-" "-" "-" "$canonicalization_base_path" "$canonicalization_proof_path")
          else
            integrity_args+=("$canonicalization_base_path" "$canonicalization_proof_path")
          fi
        fi
        integrity_exit=0
        HOUSEKEEPING_BASE_SHA="$base_sha" node "$(dirname "$0")/crawler-slice-integrity.mjs" "${integrity_args[@]}" \
          || integrity_exit=$?
        case "$integrity_exit" in
          0) ;;
          1)
            echo "❌ grouped-isolated: refusing catastrophic crawler slice shrink: $f"
            return 1
            ;;
          3)
            echo "❌ grouped-isolated: catastrophic crawler slice shrink with a rejected housekeeping proof: $f"
            return 1
            ;;
          *)
            echo "❌ grouped-isolated: crawler slice integrity check crashed (exit $integrity_exit) for $f — not a shrink verdict"
            return 1
            ;;
        esac
      fi

      isolated_file_phase_add integrity "$file_phase_started"
      stage_isolated_blob "$tmp_index" "$mode_to_stage" "$blob_to_stage" "$f" || return 1
      if [ "$result_cacheable" = true ]; then
        _ISOLATED_RESULT_KEY[$f]="$result_key"
        _ISOLATED_RESULT_BLOB[$f]="$blob_to_stage"
        _ISOLATED_RESULT_OWNED_BLOB[$f]="$local_blob"
      fi
    done
    isolated_file_end
    isolated_phase_add files "$phase_started"
    echo "ℹ️ grouped-isolated attempt ${push_attempt}: ${computed_count} file(s) computed, ${reused_count} reused from the previous attempt"

    isolated_mark phase_started
    new_tree="$(write_isolated_tree "$tmp_index")" || return 1
    if [ "${TRANSLATION_STATS_AFTER_TREE:-0}" = "1" ]; then
      # The snapshot must happen after the remote refresh and every 3-way merge,
      # but before this exact index becomes the pushed commit. On a retry the
      # candidate is rebuilt and measured again against the newer remote tree.
      append_translation_stats_to_index "$tmp_index" "$new_tree" || return 1
      new_tree="$(write_isolated_tree "$tmp_index")" || return 1
    fi
    isolated_phase_add tree "$phase_started"
    if [ "$new_tree" = "$remote_tree" ]; then
      isolated_phase_report "$push_attempt"
      emit_crawler_generation_receipt "noop" "$remote_sha" "$remote_sha" || return $?
      echo "ℹ️ No effective changes for this crawler's files vs origin/main — nothing to commit"
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=false" >> "$GITHUB_OUTPUT"
      return 0
    fi

    isolated_mark phase_started
    new_commit="$(git commit-tree "$new_tree" -p "$remote_sha" -m "$COMMIT_MSG")" || new_commit=""
    if [ -z "$new_commit" ]; then
      # See write_isolated_tree: with an empty source the refspec below would
      # read `:refs/heads/main`, a deletion of the branch.
      echo "❌ grouped-isolated: git commit-tree failed — nothing to push"
      return 1
    fi

    guard_timeout="$GIT_COMMIT_DATA_PUSH_GUARD_TIMEOUT_SECONDS"
    if ! main_push_guard_check "$remote_sha" "$new_commit" "$guard_timeout"; then
      emit_crawler_generation_receipt "failed" "$new_commit" "$remote_sha"
      echo "❌ Main push guard rejected grouped-isolated commit ${new_commit}; refusing to publish a collapsed tree"
      return 1
    fi
    # `push` is the network round trip alone: building the commit object,
    # refreshing credentials and the guard's safety proof have separate
    # bounded ceilings, so the push keeps its full configured budget.
    isolated_phase_add commit "$phase_started"
    isolated_mark phase_started
    # Capture the push output (echoed below either way, so the step log stays
    # complete) so exhaustion can be classified on the LAST attempt: only a
    # genuine rejection/race may become exit 42.
    push_out=""
    ensure_git_auth
    guarded_deadline="$(guarded_push_deadline)"
    push_timeout="$(guarded_push_remaining_seconds "$guarded_deadline")" || return 1
    if push_out="$(run_bounded "$push_timeout" \
      "git push --no-thin origin <commit>:refs/heads/main" \
      git -c pack.window=0 -c pack.threads=1 push --no-thin \
        "--force-with-lease=refs/heads/main:${remote_sha}" \
        origin "${new_commit}:refs/heads/main" 2>&1)"; then
      isolated_phase_add push "$phase_started"
      printf '%s\n' "$push_out"
      isolated_phase_report "$push_attempt"
      emit_crawler_generation_receipt "pushed" "$new_commit" "$remote_sha" || return $?
      echo "✅ Pushed successfully (grouped-isolated commit ${new_commit})"
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=true" >> "$GITHUB_OUTPUT"
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "final_commit=$new_commit" >> "$GITHUB_OUTPUT"
      # Deliberately do NOT fast-forward refs/heads/main after the push:
      # base_sha (the job's original checkout, resolved from HEAD at entry)
      # must remain the 3-way merge base for EVERY sibling of this run.
      # Advancing the local ref would shift the base for later siblings,
      # making a mid-run remote change to their files (e.g. translate-pending
      # updating a sibling's slice) look base-identical, skip the merge and
      # get silently reverted by the stale worktree copy.

      if [ "${SKIP_AI_TRANSLATION:-0}" = "1" ]; then
        echo "ℹ️ SKIP_AI_TRANSLATION=1 — skipping deploy trigger (translate-pending pipeline will deploy)"
      else
        EXPECTED_SHA="$new_commit" DEPLOY_REF="main" bash "$(dirname "$0")/trigger-deploy.sh" || true
      fi
      return 0
    fi
    isolated_phase_add push "$phase_started"
    printf '%s\n' "$push_out"
    isolated_phase_report "$push_attempt"

    if git_push_rejection_is_permanent "$push_out"; then
      emit_crawler_generation_receipt "failed" "$new_commit" "$remote_sha"
      echo "❌ Push declined by a repository rule (GH013/GH006) on attempt $push_attempt — not a ref race, rebuilding the commit cannot change the verdict. Check the pushing identity (scripts/lib/configure-main-push-auth.sh) or the ruleset."
      return 1
    fi

    if [ "$push_attempt" -ge "$MAX_PUSH_ATTEMPTS" ]; then
      if is_push_contention_output "$push_out"; then
        emit_crawler_generation_receipt "push_contention" "$new_commit" "$remote_sha"
        echo "❌ Push failed after $MAX_PUSH_ATTEMPTS attempts (contention loss — crawl data was fine, the ref race was lost)"
        # 42 = PUSH_CONTENTION_EXHAUSTED: distinct from generic failure (1) so the
        # grouped failure-report can skip the per-crawler issue for this systemic
        # class (the cycle self-heals at the next scheduled run; persistent loss
        # surfaces via the crawler-health staleness monitor).
        return 42
      fi
      emit_crawler_generation_receipt "failed" "$new_commit" "$remote_sha"
      echo "❌ Push failed after $MAX_PUSH_ATTEMPTS attempts and the LAST failure is NOT a ref rejection/race (outage/auth/hook?) — exiting 1 so it surfaces as a real failure."
      return 1
    fi

    delay=$(( push_attempt * 5 + RANDOM % 20 ))
    echo "⚠️ Push rejected (attempt $push_attempt/$MAX_PUSH_ATTEMPTS) — refetching origin/main and rebuilding commit in ${delay}s..."
    # Il mutex globale NON copre il sonno: il tentativo successivo rifa' fetch e
    # ricostruisce l'albero dalla testa remota corrente, quindi cedere il turno
    # qui non riapre nessuna corsa. Vedi la nota su
    # `global_data_pipeline_lease_release_for_backoff`.
    global_data_pipeline_lease_release_for_backoff || true
    sleep "$delay"
    global_data_pipeline_lease_resume_after_backoff || return $?
  done
}

ensure_git_auth
# The pre-lease ownership snapshot must describe the current remote tip. A
# blobless crawler checkout can have an origin/main ref from its checkout time;
# without this fetch, the first in-lease refresh re-counts every slice changed
# before the snapshot instead of only the delta created while the lease is held.
if [ "$GROUPED_ISOLATED" = true ]; then
  git_fetch_retry
fi
old_history_guard_main

if [ "$GROUPED_ISOLATED" = true ]; then
  if grouped_ownership_view_needed; then
    grouped_ownership_view_prepare "$(git rev-parse refs/remotes/origin/main)"
  fi
  # Both non-zero results are captured through `||` rather than a bare call:
  # under `set -e` (L31), errexit would skip the coordination mapping below.
  _lease_result=0
  global_data_pipeline_lease_acquire || _lease_result=$?
  if [ "$_lease_result" -eq 44 ]; then
    if [ "$GROUP_BATCH" = true ] || [ -n "${JOBS_SLICE_FILE:-}" ]; then
      # Group-batch/per-crawler callers return the coordination class to their
      # generated workflow, which can keep the run green without filing a
      # per-crawler issue. Sequential writers must continue the job: no data
      # was staged, and a later commit phase or the next scheduled run retries.
      exit 44
    fi
    echo "⚠️ Sequential writer: global data-pipeline lease remained busy after the bounded wait — no data staged; continuing so a later phase or the next scheduled run can retry"
    exit 0
  fi
  if [ "$_lease_result" -ne 0 ]; then
    exit "$_lease_result"
  fi
  _commit_result=0
  commit_isolated_from_worktree || _commit_result=$?
  # Sequential callers (JOBS_SLICE_FILE unset — e.g. translate-pending.yml,
  # cleanup-stale-jobs.yml) treat push-contention exhaustion as a soft failure:
  # the committed data self-heals on the next scheduled run, so exit 42 must
  # not cascade-fail subsequent steps (translations, slug-regen) or create a
  # spurious failure issue. Grouped crawlers (JOBS_SLICE_FILE set) keep exit 42
  # so their per-crawler failure-report step can skip the issue for this class.
  if [ "$_commit_result" -eq 42 ] && [ -z "${JOBS_SLICE_FILE:-}" ] && [ "$GROUP_BATCH" != true ]; then
    echo "⚠️ Sequential push: contention exhausted after $MAX_PUSH_ATTEMPTS attempts — soft success (data self-heals on the next scheduled run)"
    exit 0
  fi
  exit "$_commit_result"
fi

global_data_pipeline_lease_acquire
while true; do

# ── 3. Sync with remote (stash → rebase → pop → merge if needed) ──────────
ensure_git_auth
git_fetch_retry
old_history_guard_main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "⚠️ Remote updated — syncing before commit..."
  BASE_SHA="$LOCAL"

  # Save local copies so we can merge after rebase if stash-pop conflicts
  SNAPSHOT_DIR="$(create_rebase_snapshot "$BASE_SHA")"

  # Stash local changes so rebase can proceed cleanly
  git stash --include-untracked

  ensure_git_auth
  if ! run_bounded "$GIT_COMMIT_DATA_PULL_TIMEOUT_SECONDS" "git pull --rebase origin main" \
    git pull --rebase origin main; then
    git rebase --abort 2>/dev/null || true
    echo "⚠️ Fast-rebase failed — pulling with merge..."
    ensure_git_auth
    run_bounded "$GIT_COMMIT_DATA_PULL_TIMEOUT_SECONDS" "git pull --no-rebase origin main" \
      git pull --no-rebase origin main || true
  fi

  # Restore local changes
  restore_stashed_changes_with_safe_merge "$SNAPSHOT_DIR" "⚠️ Stash-pop conflict — merging data files..."

  cleanup_rebase_snapshot "$SNAPSHOT_DIR"
fi

# ── 4. Stage, commit, push ────────────────────────────────────────────────
# Keep canonical files aligned after any merge path.
# (Skipped in --slice-only mode: shared files are not committed)
if [ "$SLICE_ONLY" = false ]; then
node - <<'NODE'
const fs = require('fs');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const dataJobsPath = 'data/jobs.json';
const publicJobsPath = 'public/data/jobs.json';
const metaPath = 'data/jobs-meta.json';

let jobs = null;
if (fs.existsSync(dataJobsPath)) {
  jobs = readJson(dataJobsPath);
  if (!Array.isArray(jobs)) {
    console.error(`❌ ${dataJobsPath} must be a JSON array`);
    process.exit(1);
  }
}

if (jobs) {
  fs.mkdirSync(require('path').dirname(publicJobsPath), { recursive: true });
  writeJson(publicJobsPath, jobs);
}

if (jobs && fs.existsSync(metaPath)) {
  const meta = readJson(metaPath);
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    meta.totalJobs = jobs.length;
    if (meta.sources && typeof meta.sources === 'object' && Object.prototype.hasOwnProperty.call(meta.sources, 'curatedTicino')) {
      meta.sources.curatedTicino = jobs.length;
    }
    writeJson(metaPath, meta);
  }
}
NODE
fi  # end SLICE_ONLY=false canonical alignment block

# Validate critical JSON files before staging/commit to avoid destructive pushes.
# (Skipped in --slice-only mode: shared files are not committed)
if [ "$SLICE_ONLY" = false ]; then
node - <<'NODE'
const fs = require('fs');
const critical = [
  'data/jobs.json',
  'public/data/jobs.json',
];
for (const file of critical) {
  if (!fs.existsSync(file)) continue;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(value)) {
    console.error(`❌ ${file} must be a JSON array before commit`);
    process.exit(1);
  }
}
NODE

# Gitignored/crawler-generated file: only callers that ran a crawler or
# assemble-jobs-dataset.mjs beforehand produce it. Non-crawler callers (e.g.
# autologin-refusal-monitor.yml committing docs/autologin-refusal/) never
# touch it, so its absence here is not a corruption signal — same
# existence-guard pattern as generate-job-board-stats.mjs below (#5779).
if [ -f data/jobs-crawler-summaries.json ]; then
  node scripts/validate-crawler-summaries.mjs
fi
fi  # end SLICE_ONLY=false validation block

# Filter out gitignored paths before staging (e.g. data/jobs.json is in .gitignore).
# Also drop non-existent paths: STANDARD_FILES now includes per-crawler file
# paths (e.g. data/jobs/expired/by-crawler/<slug>.json) that legitimately
# don't exist for every crawler (e.g. one that has never had an expired job) —
# `git add` fails its ENTIRE invocation on any single unmatched pathspec, which
# would otherwise abort staging of files that DO exist alongside it.
#
# A directory path (trailing slash) is kept only when it has at least one
# child git can act on: a tracked file (a missing directory whose files are
# still in the index then gets their deletion staged) or an untracked,
# non-ignored file. A directory that is neither on disk nor in the index (e.g.
# data/jobs/by-crawler/ in a checkout that has only ever had expired slices)
# would make `git add` abort the whole invocation with "pathspec did not match
# any files", exactly like a missing file path; an existing directory with no
# such child has nothing to stage either, so it is dropped the same way.
collect_stageable_files() {
  STAGEABLE_FILES=()
  local _sf
  for _sf in "${ALL_FILES[@]}"; do
    if [[ "$_sf" == */ ]]; then
      [ -n "$(git ls-files --cached --others --exclude-standard -- "$_sf" | head -n 1)" ] || continue
    elif [[ ! -e "$_sf" ]]; then
      continue
    fi
    if git check-ignore -q "$_sf" 2>/dev/null; then
      echo "ℹ️ Skipping gitignored path: $_sf"
    else
      STAGEABLE_FILES+=("$_sf")
    fi
  done
}
collect_stageable_files
if [ "${#STAGEABLE_FILES[@]}" -gt 0 ]; then
  git add "${STAGEABLE_FILES[@]}"
fi

# After merge/rebase the diff might be empty (remote already had the same data)
if git diff --cached --quiet; then
  echo "ℹ️ No effective changes after sync — already up to date"
  exit 0
fi

abort_if_conflict_markers_staged "pre-commit"
git commit -m "$COMMIT_MSG"

# Last-moment rebase: fetch latest remote right before push to minimise race window
ensure_git_auth
git_fetch_retry
if ! git rebase origin/main 2>/dev/null; then
  echo "⚠️ Last-moment rebase conflict — resolving with 3-way JSON merge..."
  git rebase --abort 2>/dev/null || true
  git reset --mixed HEAD~1
  LAST_MOMENT_BASE_SHA="$(git rev-parse HEAD)"
  LAST_MOMENT_SNAPSHOT_DIR="$(create_rebase_snapshot "$LAST_MOMENT_BASE_SHA")"

  # Re-pull with merge strategy to get remote changes
  git stash --include-untracked 2>/dev/null || true
  ensure_git_auth
  run_bounded "$GIT_COMMIT_DATA_PULL_TIMEOUT_SECONDS" "git pull --no-rebase origin main" \
    git pull --no-rebase origin main || true

  restore_stashed_changes_with_safe_merge \
    "$LAST_MOMENT_SNAPSHOT_DIR" \
    "  🔀 Resolving stash-pop conflict after last-moment rebase..."
  cleanup_rebase_snapshot "$LAST_MOMENT_SNAPSHOT_DIR"

  collect_stageable_files
  if [ "${#STAGEABLE_FILES[@]}" -gt 0 ]; then
    git add "${STAGEABLE_FILES[@]}"
  fi
  if git diff --cached --quiet; then
    echo "ℹ️ No effective changes after last-moment sync — already up to date"
    exit 0
  fi
  abort_if_conflict_markers_staged "pre-commit"
git commit -m "$COMMIT_MSG"
  # Fall through to the push below
fi

# Push — if rejected, undo commit and re-run sync from step 3
push_attempt=$((push_attempt + 1))
PUSH_BASE_SHA=""
if ! PUSH_BASE_SHA="$(git rev-parse --verify refs/remotes/origin/main^{commit})"; then
  echo "❌ main push guard: cannot resolve refs/remotes/origin/main for the push lease"
  exit 1
fi
PUSH_CANDIDATE_SHA=""
if ! PUSH_CANDIDATE_SHA="$(git rev-parse --verify HEAD^{commit})"; then
  echo "❌ main push guard: cannot resolve HEAD for the guarded candidate"
  exit 1
fi
GUARD_TIMEOUT="$GIT_COMMIT_DATA_PUSH_GUARD_TIMEOUT_SECONDS"
if ! main_push_guard_check "$PUSH_BASE_SHA" "$PUSH_CANDIDATE_SHA" "$GUARD_TIMEOUT"; then
  echo "❌ Main push guard rejected the candidate; refusing to publish a collapsed tree"
  exit 1
fi
# Capture the push output (echoed below either way, so the step log stays
# complete) so exhaustion can be classified on the LAST attempt: only a
# genuine rejection/race may become exit 42.
push_out=""
ensure_git_auth
GUARDED_PUSH_DEADLINE="$(guarded_push_deadline)"
PUSH_TIMEOUT="$(guarded_push_remaining_seconds "$GUARDED_PUSH_DEADLINE")" || exit 1
if push_out="$(run_bounded "$PUSH_TIMEOUT" \
  "git push --no-thin origin <commit>:refs/heads/main" \
  git -c pack.window=0 -c pack.threads=1 push --no-thin \
    "--force-with-lease=refs/heads/main:${PUSH_BASE_SHA}" \
    origin "${PUSH_CANDIDATE_SHA}:refs/heads/main" 2>&1)"; then
  printf '%s\n' "$push_out"
  echo "✅ Pushed successfully"

  # ── 5. Trigger deploy — GITHUB_TOKEN pushes don't trigger other workflows ─
  # When SKIP_AI_TRANSLATION=1 (orchestrated run), skip deploy trigger.
  # The centralized translate-pending pipeline will trigger deploy after translation.
  if [ "${SKIP_AI_TRANSLATION:-0}" = "1" ]; then
    echo "ℹ️ SKIP_AI_TRANSLATION=1 — skipping deploy trigger (translate-pending pipeline will deploy)"
  else
    PUSHED_SHA="$(git rev-parse HEAD)"
    EXPECTED_SHA="$PUSHED_SHA" DEPLOY_REF="main" bash "$(dirname "$0")/trigger-deploy.sh" || true
  fi

  exit 0
fi
printf '%s\n' "$push_out"

if git_push_rejection_is_permanent "$push_out"; then
  echo "❌ Push declined by a repository rule (GH013/GH006) on attempt $push_attempt — not a ref race, re-syncing cannot change the verdict. Check the pushing identity (scripts/lib/configure-main-push-auth.sh) or the ruleset."
  exit 1
fi

if [ "$push_attempt" -ge "$MAX_PUSH_ATTEMPTS" ]; then
  if is_push_contention_output "$push_out"; then
    echo "❌ Push failed after $MAX_PUSH_ATTEMPTS attempts (contention loss — crawl data was fine, the ref race was lost)"
    # 42 = PUSH_CONTENTION_EXHAUSTED (see the grouped path above for rationale).
    exit 42
  fi
  echo "❌ Push failed after $MAX_PUSH_ATTEMPTS attempts and the LAST failure is NOT a ref rejection/race (outage/auth/hook?) — exiting 1 so it surfaces as a real failure."
  exit 1
fi

# Backoff: 5s, 10s, 15s, ... + random jitter (0-5s)
DELAY=$(( push_attempt * 5 + RANDOM % 20 ))
echo "⚠️ Push rejected (attempt $push_attempt/$MAX_PUSH_ATTEMPTS) — waiting ${DELAY}s before resync..."
# Stesso trattamento del percorso grouped-isolated, e qui vale DI PIU': questo e'
# il ramo che usa `translate-pending` (`--slice-only`, quattro volte in un job da
# 350 minuti), cioe' il detentore che nella finestra 23:23-01:25 ha bloccato 19
# gruppi. Sweepare solo l'altro sito avrebbe lasciato in piedi il blocco vero.
global_data_pipeline_lease_release_for_backoff || true
sleep "$DELAY"
global_data_pipeline_lease_resume_after_backoff || exit $?
git reset --mixed HEAD~1

done  # end retry loop
