#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/git-commit-data.sh — Centralised git commit+push for job crawlers
#
# Usage:
#   bash scripts/lib/git-commit-data.sh "commit message" [extra-paths ...]
#   bash scripts/lib/git-commit-data.sh --slice-only "commit message" [extra-paths ...]
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
# Exit codes:
#   0  — success (committed+pushed, or nothing to commit)
#   1  — push still failing after retries for a NON-contention reason
#        (network outage, auth failure, hook decline, ...) — must stay a
#        red step, never silently absorbed
#   42 — PUSH_CONTENTION_EXHAUSTED: retries exhausted AND the LAST push
#        failure was a ref rejection/race (output matched rejected /
#        fetch first / cannot lock ref / non-fast-forward). Only this
#        class is safe for callers to treat as "self-heals next run".
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

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
# Same registration for the crawlers' AI response cache
# (.gitattributes `merge=ai-cache`, data/jobs-ai-cache.json, issue #4248
# follow-up): union by entry key keeping the newest observation, then re-apply
# the byte budget. Without it git's generic array union can push the merged file
# back over GitHub's 100 MB limit that the persist-time budget just enforced.
git config merge.ai-cache.driver 'node scripts/ci/merge-ai-cache.mjs %O %A %B' || true

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
# Set to true (below) only for grouped crawler-group invocations, which share
# one working copy across ~25 concurrent sibling crawlers and therefore must
# never mutate the shared worktree/index while committing.
GROUPED_ISOLATED=false
if [ "${1:-}" = "--group-batch" ]; then
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
if [ "$GROUP_BATCH" = true ]; then
  # Paths are loaded below from the successful crawlers' immutable descriptors.
  # Keeping this list empty is load-bearing: the batch must never sweep a
  # failed sibling's partial files merely because they remain dirty in the
  # shared worktree.
  STANDARD_FILES=()
elif [ "$SLICE_ONLY" = true ]; then
  # Slice-only mode: only commit per-crawler slice files + ai-cache.
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
  # Falls back to the old directory-wide behavior when unset (non-grouped
  # callers, e.g. translate-pending.yml, which legitimately touches every
  # crawler's slice in one sequential job).
  if [ -n "${JOBS_SLICE_FILE:-}" ]; then
    SLICE_BASENAME="$(basename "$JOBS_SLICE_FILE")"
    STANDARD_FILES=(
      "data/jobs/by-crawler/${SLICE_BASENAME}"
      "data/jobs/expired/by-crawler/${SLICE_BASENAME}"
      "data/jobs-crawler-summaries/by-crawler/${SLICE_BASENAME}"
      "data/translation-cache/${SLICE_BASENAME}"
      data/jobs-ai-cache.json
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
      data/translation-cache/
      data/jobs-ai-cache.json
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
    data/translation-cache/
    data/jobs-ai-cache.json
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
# exact per-crawler standard files plus explicit file extras. The shared AI
# cache is deliberately excluded for the same reason; it is not attributable
# to one crawler in the shared worktree and heals through sequential writers.
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
    [ "$path_item" = "data/jobs-ai-cache.json" ] || ALL_FILES+=("$path_item")
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
# The retirement-vs-first-run disambiguation below depends on `git log`
# telling the truth, so unshallow once (cached per process, mirroring the
# roster cache above) before trusting an empty result. If the unshallow
# itself fails, callers must fail closed instead of guessing: an empty `git
# log` at that point could mean "never existed" (safe to create) or "retired
# 51+ commits ago" (must stay dropped), and picking wrong either resurrects
# retired data or permanently blocks a genuinely new slice.
_SHALLOW_CHECKOUT_STATUS=""

ensure_full_history() {
  if [ -z "$_SHALLOW_CHECKOUT_STATUS" ]; then
    if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
      if git fetch --unshallow origin main >/dev/null 2>&1 \
        && [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" != "true" ]; then
        _SHALLOW_CHECKOUT_STATUS="unshallowed"
      else
        _SHALLOW_CHECKOUT_STATUS="shallow"
      fi
    else
      _SHALLOW_CHECKOUT_STATUS="complete"
    fi
  fi
  [ "$_SHALLOW_CHECKOUT_STATUS" != "shallow" ]
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

# Optional shadow-only generation receipt. Disabled callers execute only the
# empty-env guard below; enabled callers receive a best-effort observation of
# the exact private-index tree. Receipt failure must never change this helper's
# push, stdout contract or exit code: the group finalizer treats a missing or
# corrupt receipt as invalid instead.
emit_crawler_generation_receipt() {
  local outcome="${1:-}"
  local commit_sha="${2:-}"
  local remote_base_sha="${3:-}"
  [ -n "${CRAWLER_GENERATION_RECEIPT_DIR:-}" ] || return 0

  local receipt_args=("${RESOLVED_FILES[@]}")
  if [ "$GROUP_BATCH" = true ]; then
    receipt_args=(--batch-receipts)
  fi
  if ! CRAWLER_GENERATION_RECEIPT_OUTCOME="$outcome" \
    CRAWLER_GENERATION_RECEIPT_COMMIT="$commit_sha" \
    CRAWLER_GENERATION_RECEIPT_REMOTE_BASE="$remote_base_sha" \
    node "$(dirname "$0")/crawler-generation-receipt.mjs" "${receipt_args[@]}"; then
    echo "::warning::crawler generation receipt failed (shadow only); push outcome remains unchanged"
  fi
  return 0
}

if [ "${CRAWLER_GROUP_DEFER_COMMIT:-0}" = "1" ]; then
  if [ "$GROUP_BATCH" = true ] || [ "$GROUPED_ISOLATED" != true ]; then
    echo "❌ crawler group defer mode requires one --slice-only crawler invocation"
    exit 1
  fi
  if ! CRAWLER_GROUP_COMMIT_MESSAGE="$COMMIT_MSG" \
    node "$(dirname "$0")/crawler-generation-receipt.mjs" --defer-group-commit "${RESOLVED_FILES[@]}"; then
    echo "❌ crawler group defer mode could not persist its commit descriptor"
    exit 1
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

restore_stashed_changes_with_safe_merge() {
  local snapshot_dir="$1"
  local conflict_message="$2"
  local conflict_files=""
  local unmerged=""
  local f
  local key_hint=""

  if git stash pop 2>/dev/null; then
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

      merge_json_3way \
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
// Deliberate trade-off: a genuine removal (cleanPreviousSlugsPerLocale
// dropping an entry equal to the active slug, decontaminate-prev-slugs)
// that races a concurrent writer survives one extra cycle before the next
// writer drops it again. Resurrect-then-redrop is convergent and free;
// deleting a live historical slug is permanent SEO loss. Same asymmetry the
// `merge=union` drivers in .gitattributes are documented to accept.
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
  const note = (v) => { if (typeof v === 'string' && v.trim()) reachable.add(v.trim()); };
  note(merged.slug);
  if (isPlainObject(merged.slugByLocale)) for (const v of Object.values(merged.slugByLocale)) note(v);
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

  const remoteMap = isPlainObject(remoteObj?.slugByLocale) ? remoteObj.slugByLocale : {};
  const localMap = isPlainObject(localObj?.slugByLocale) ? localObj.slugByLocale : {};
  for (const locale of new Set([...Object.keys(remoteMap), ...Object.keys(localMap)])) {
    bank(remoteMap[locale], locale);
    bank(localMap[locale], locale);
  }
  bank(remoteObj?.slug, '');
  bank(localObj?.slug, '');
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

function mergeValue(baseValue, remoteValue, localValue, warnings, pathLabel, forcedKey = '') {
  if (isSame(localValue, baseValue)) return clone(remoteValue);
  if (isSame(remoteValue, baseValue)) return clone(localValue);
  if (isSame(localValue, remoteValue)) return clone(localValue);

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
    if git fetch origin main; then
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
#     data/jobs-ai-cache.json touched by another group, or a slice updated by
#     translate-pending) are 3-way merged content-wise (base = checkout HEAD,
#     remote = origin/main, local = worktree) via the same merge_json_3way
#     used by the legacy path, so concurrent remote additions survive.
commit_isolated_from_worktree() {
  local base_sha remote_sha remote_tree new_tree new_commit
  local tmp_index merge_dir
  local f local_blob remote_blob base_blob blob_to_stage key_hint mode_to_stage local_merge_path conflict_scan_path
  local snapshot_operation snapshot_state registry_status
  local delay

  base_sha="$(git rev-parse HEAD)"
  tmp_index="$(mktemp /tmp/crawler-commit-index.XXXXXX)"
  merge_dir="$(mktemp -d /tmp/crawler-commit-merge.XXXXXX)"
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
    ensure_git_auth
    git_fetch_retry || return 1
    remote_sha="$(git rev-parse origin/main)"
    remote_tree="$(git rev-parse "${remote_sha}^{tree}")"

    # Private index seeded from the CURRENT remote head — never the shared
    # .git/index (GIT_INDEX_FILE scopes every index operation below).
    GIT_INDEX_FILE="$tmp_index" git read-tree "$remote_sha"

    for f in "${RESOLVED_FILES[@]}"; do
      remote_blob="$(git rev-parse -q --verify "${remote_sha}:${f}" 2>/dev/null || true)"
      local_merge_path="$f"
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
        [ -f "$f" ] || continue
        if git check-ignore -q "$f" 2>/dev/null; then
          continue
        fi
        local_blob="$(git hash-object -w -- "$f")"
        base_blob="$(git rev-parse -q --verify "${base_sha}:${f}" 2>/dev/null || true)"
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
                # a path that was ever committed still shows up in `git log`
                # even after being removed from the tree, while a brand-new
                # slice (issue #7151 item 1: pre-registration ordering between
                # the roster-regeneration step and a crawler's first data
                # commit isn't asserted anywhere else) has no history at all.
                # `git log` only tells the truth about that if the checkout
                # isn't shallow (issue #7221 review follow-up): crawler-group
                # workflows pin fetch-depth 50, so a retirement more than 50
                # commits before this checkout would otherwise be misread as
                # first-run create and silently resurrected.
                if ! ensure_full_history; then
                  echo "❌ grouped-isolated: cannot verify retirement history for $f — checkout remains shallow after an unshallow attempt, refusing to guess between first-run create and resurrection"
                  return 1
                fi
                history_blob="$(git log -1 --format=%H -- "$f" 2>/dev/null || true)"
                if [ -z "$history_blob" ]; then
                  echo "⚠️ grouped-isolated: $f is absent from the primary slice registry and has no prior history — treating as an unregistered first-run create instead of dropping (roster may not be pre-registered yet)"
                else
                  echo "⚠️ grouped-isolated: $f is absent from the primary slice registry — preserving retirement and dropping local content"
                  continue
                fi
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

      blob_to_stage="$local_blob"

      # Remote moved for this file since our checkout AND disagrees with our
      # local content → merge instead of clobbering (keeps e.g. translation
      # updates or another group's ai-cache entries pushed mid-run).
      if [[ "$f" == *.json ]] \
        && [ -n "$remote_blob" ] \
        && [ "$remote_blob" != "$base_blob" ] \
        && [ "$remote_blob" != "$local_blob" ]; then
        key_hint=""
        is_job_slice_path "$f" && key_hint="url"
        mkdir -p "$merge_dir/base/$(dirname "$f")" "$merge_dir/remote/$(dirname "$f")" "$merge_dir/out/$(dirname "$f")"
        if [ -n "$base_blob" ]; then
          git cat-file blob "$base_blob" > "$merge_dir/base/$f"
        else
          rm -f "$merge_dir/base/$f"
        fi
        git cat-file blob "$remote_blob" > "$merge_dir/remote/$f"
        if merge_json_3way \
          "$merge_dir/base/$f" \
          "$merge_dir/remote/$f" \
          "$local_merge_path" \
          "$merge_dir/out/$f" \
          "$key_hint" \
          "$f"; then
          blob_to_stage="$(git hash-object -w -- "$merge_dir/out/$f")"
        else
          if [ "$GROUP_BATCH" = true ]; then
            echo "❌ crawler group batch: snapshot merge failed for $f — refusing a partial commit"
            return 1
          fi
          # Preserve the established non-batch policy for sequential callers.
          echo "⚠️ grouped-isolated: 3-way merge failed for $f — keeping local content"
        fi
      fi

      GIT_INDEX_FILE="$tmp_index" git update-index --add --cacheinfo "${mode_to_stage},${blob_to_stage},${f}"
    done

    new_tree="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
    if [ "$new_tree" = "$remote_tree" ]; then
      emit_crawler_generation_receipt "noop" "$remote_sha" "$remote_sha"
      echo "ℹ️ No effective changes for this crawler's files vs origin/main — nothing to commit"
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=false" >> "$GITHUB_OUTPUT"
      return 0
    fi

    new_commit="$(git commit-tree "$new_tree" -p "$remote_sha" -m "$COMMIT_MSG")"

    ensure_git_auth
    # Capture the push output (echoed below either way, so the step log stays
    # complete) so exhaustion can be classified on the LAST attempt: only a
    # genuine rejection/race may become exit 42.
    push_out=""
    if push_out="$(git push origin "${new_commit}:refs/heads/main" 2>&1)"; then
      printf '%s\n' "$push_out"
      emit_crawler_generation_receipt "pushed" "$new_commit" "$remote_sha"
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
    printf '%s\n' "$push_out"

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
    sleep "$delay"
  done
}

if [ "$GROUPED_ISOLATED" = true ]; then
  # `|| _commit_result=$?` (not a bare call + separate `$?` capture) is
  # LOAD-BEARING under `set -e` (L31): a bare simple command's non-zero
  # return trips errexit immediately, skipping every line after it —
  # including the `_commit_result=$?` capture and the soft-fail mapping
  # below, so the script would exit 42 unconditionally regardless of
  # caller type. Attaching `||` puts the call in a tested context, which
  # `set -e` exempts (PR #4191 round-1 review).
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

while true; do

# ── 3. Sync with remote (stash → rebase → pop → merge if needed) ──────────
ensure_git_auth
git_fetch_retry
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
  if ! git pull --rebase origin main; then
    git rebase --abort 2>/dev/null || true
    echo "⚠️ Fast-rebase failed — pulling with merge..."
    ensure_git_auth
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
STAGEABLE_FILES=()
for _sf in "${ALL_FILES[@]}"; do
  if [[ ! -e "$_sf" && "$_sf" != */ ]]; then
    continue
  elif git check-ignore -q "$_sf" 2>/dev/null; then
    echo "ℹ️ Skipping gitignored path: $_sf"
  else
    STAGEABLE_FILES+=("$_sf")
  fi
done
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
  git pull --no-rebase origin main || true

  restore_stashed_changes_with_safe_merge \
    "$LAST_MOMENT_SNAPSHOT_DIR" \
    "  🔀 Resolving stash-pop conflict after last-moment rebase..."
  cleanup_rebase_snapshot "$LAST_MOMENT_SNAPSHOT_DIR"

  STAGEABLE_FILES=()
  for _sf in "${ALL_FILES[@]}"; do
    if [[ ! -e "$_sf" && "$_sf" != */ ]]; then
      continue
    elif git check-ignore -q "$_sf" 2>/dev/null; then
      echo "ℹ️ Skipping gitignored path: $_sf"
    else
      STAGEABLE_FILES+=("$_sf")
    fi
  done
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
ensure_git_auth
# Capture the push output (echoed below either way, so the step log stays
# complete) so exhaustion can be classified on the LAST attempt: only a
# genuine rejection/race may become exit 42.
push_out=""
if push_out="$(git push origin main 2>&1)"; then
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
sleep "$DELAY"
git reset --mixed HEAD~1

done  # end retry loop
