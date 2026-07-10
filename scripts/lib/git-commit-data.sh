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

# ── Parse --slice-only flag ──────────────────────────────────────────────────
SLICE_ONLY=false
# Set to true (below) only for grouped crawler-group invocations, which share
# one working copy across ~25 concurrent sibling crawlers and therefore must
# never mutate the shared worktree/index while committing.
GROUPED_ISOLATED=false
if [ "${1:-}" = "--slice-only" ]; then
  SLICE_ONLY=true
  shift
fi

COMMIT_MSG="${1:?Usage: git-commit-data.sh [--slice-only] 'commit message' [extra-paths...]}"
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
if [ "$SLICE_ONLY" = true ]; then
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

# Resolve input paths to concrete files for snapshot/rebase-merge logic.
# Extra paths may include directories (e.g. data/jobs-crawler-adapters/).
# Directory paths are valid for `git add`, but not for `git show "$sha:$path"`
# where a tree object would break redirection.
declare -A _SEEN_RESOLVED_FILES=()
RESOLVED_FILES=()

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
    # Include tracked files from git index/history (works even if some files
    # are not currently present in working tree).
    while IFS= read -r tracked; do
      [ -n "$tracked" ] || continue
      append_resolved_file "$tracked"
    done < <(git ls-files "$normalized_path" 2>/dev/null || true)

    # Include local untracked/generated files currently present in the folder.
    if [[ -d "$normalized_path" ]]; then
      while IFS= read -r local_file; do
        [ -n "$local_file" ] || continue
        append_resolved_file "$local_file"
      done < <(find "$normalized_path" -type f 2>/dev/null || true)
    fi
    return 0
  fi

  append_resolved_file "$raw_path"
}

for path_item in "${ALL_FILES[@]}"; do
  expand_path_to_files "$path_item"
done

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
      case "$f" in
        data/jobs.json|public/data/jobs.json)
          key_hint="url"
          ;;
        data/jobs/by-crawler/*.json|data/jobs/expired/by-crawler/*.json)
          key_hint="url"
          ;;
        data/jobs-crawler-summaries.json)
          key_hint="key"
          ;;
        data/ticino-companies-extra.json)
          key_hint="website"
          ;;
      esac

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
    if (localData.map.has(key)) mergedMap.set(key, localData.map.get(key));
    else mergedMap.delete(key);
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
# actions/checkout normally persists an HTTP extraheader, but the crawler
# commit loop does several fetch/pull/push retries after long-running jobs. Make
# the token source explicit so retries do not depend on checkout's implicit
# credential state.
CHECKOUT_GIT_EXTRAHEADER="$(git config --local --get http.https://github.com/.extraheader 2>/dev/null || true)"
ensure_git_auth() {
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  local encoded

  if [ -n "$token" ]; then
    encoded="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
    git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic ${encoded}"
    return 0
  fi

  if [ -n "$CHECKOUT_GIT_EXTRAHEADER" ]; then
    git config --local http.https://github.com/.extraheader "$CHECKOUT_GIT_EXTRAHEADER"
  fi
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
  local f local_blob remote_blob base_blob blob_to_stage key_hint
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
    [ -f "$f" ] || continue
    if grep -qE '^(<<<<<<< |======= ?$|>>>>>>> )' "$f" 2>/dev/null; then
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
      # Known limitation: a deleted tracked file is NOT committed as a
      # deletion here (the remote blob stays in the private index). Grouped
      # crawlers never delete their files — they write [] — so this is
      # intentionally unhandled; retirements go through a manual commit.
      [ -f "$f" ] || continue
      if git check-ignore -q "$f" 2>/dev/null; then
        continue
      fi
      local_blob="$(git hash-object -w -- "$f")"
      remote_blob="$(git rev-parse -q --verify "${remote_sha}:${f}" 2>/dev/null || true)"
      base_blob="$(git rev-parse -q --verify "${base_sha}:${f}" 2>/dev/null || true)"
      blob_to_stage="$local_blob"

      # Remote moved for this file since our checkout AND disagrees with our
      # local content → merge instead of clobbering (keeps e.g. translation
      # updates or another group's ai-cache entries pushed mid-run).
      if [[ "$f" == *.json ]] \
        && [ -n "$remote_blob" ] \
        && [ "$remote_blob" != "$base_blob" ] \
        && [ "$remote_blob" != "$local_blob" ]; then
        key_hint=""
        case "$f" in
          data/jobs/by-crawler/*.json|data/jobs/expired/by-crawler/*.json) key_hint="url" ;;
        esac
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
          "$f" \
          "$merge_dir/out/$f" \
          "$key_hint" \
          "$f"; then
          blob_to_stage="$(git hash-object -w -- "$merge_dir/out/$f")"
        else
          # Merge policy elsewhere in this script is "keep local" on
          # unresolvable conflicts; do the same rather than aborting the
          # whole commit (which would lose this crawler's entire run).
          echo "⚠️ grouped-isolated: 3-way merge failed for $f — keeping local content"
        fi
      fi

      GIT_INDEX_FILE="$tmp_index" git update-index --add --cacheinfo "100644,${blob_to_stage},${f}"
    done

    new_tree="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
    if [ "$new_tree" = "$remote_tree" ]; then
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
      echo "✅ Pushed successfully (grouped-isolated commit ${new_commit})"
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=true" >> "$GITHUB_OUTPUT"
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
        echo "❌ Push failed after $MAX_PUSH_ATTEMPTS attempts (contention loss — crawl data was fine, the ref race was lost)"
        # 42 = PUSH_CONTENTION_EXHAUSTED: distinct from generic failure (1) so the
        # grouped failure-report can skip the per-crawler issue for this systemic
        # class (the cycle self-heals at the next scheduled run; persistent loss
        # surfaces via the crawler-health staleness monitor).
        return 42
      fi
      echo "❌ Push failed after $MAX_PUSH_ATTEMPTS attempts and the LAST failure is NOT a ref rejection/race (outage/auth/hook?) — exiting 1 so it surfaces as a real failure."
      return 1
    fi

    delay=$(( push_attempt * 5 + RANDOM % 20 ))
    echo "⚠️ Push rejected (attempt $push_attempt/$MAX_PUSH_ATTEMPTS) — refetching origin/main and rebuilding commit in ${delay}s..."
    sleep "$delay"
  done
}

if [ "$GROUPED_ISOLATED" = true ]; then
  commit_isolated_from_worktree
  exit $?
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

node scripts/validate-crawler-summaries.mjs
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
