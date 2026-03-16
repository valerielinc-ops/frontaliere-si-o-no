#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/git-commit-data.sh — Centralised git commit+push for job crawlers
#
# Usage:
#   bash scripts/lib/git-commit-data.sh "commit message" [extra-paths ...]
#
# Extra paths are appended to the standard file list (e.g. data/jobs-crawler-adapters/).
#
# GitHub Actions outputs (via $GITHUB_OUTPUT):
#   has_changes=true|false   — whether any data files were modified
#
# Exit codes:
#   0  — success (committed+pushed, or nothing to commit)
#   1  — push still failing after retries (should not happen normally)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

COMMIT_MSG="${1:?Usage: git-commit-data.sh 'commit message' [extra-paths...]}"
shift
EXTRA_PATHS=("$@")

# ── Standard data files committed by every crawler ──────────────────────────
STANDARD_FILES=(
  data/jobs.json
  public/data/jobs.json
  data/jobs-meta.json
  data/jobs-stats-history.json
  data/jobs-stats.json
  public/data/jobs-stats.json
  data/jobs-crawler-audit.json
  data/jobs-crawler-summaries.json
  data/jobs-crawler-config.json
  data/ticino-companies-extra.json
)
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

  const objectItems = arrays.flat().filter((item) => isPlainObject(item));
  if (objectItems.length === 0) return '';

  for (const candidate of candidates) {
    let present = 0;
    const seen = new Set();
    let duplicate = 0;
    for (const item of objectItems) {
      const key = primitiveKey(item[candidate]);
      if (!key) continue;
      present += 1;
      const full = `${candidate}:${key}`;
      if (seen.has(full)) duplicate += 1;
      seen.add(full);
    }
    const coverage = present / objectItems.length;
    const uniqueness = present > 0 ? (present - duplicate) / present : 0;
    if (coverage >= 0.6 && uniqueness >= 0.85) return candidate;
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

# ── 0. Refresh derived job-board statistics before change detection ────────
if [ -f "data/jobs.json" ]; then
  node scripts/generate-job-board-stats.mjs
fi

# ── 1. Detect changes ──────────────────────────────────────────────────────
if git diff --quiet && git diff --cached --quiet; then
  echo "ℹ️ No changes detected"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "📝 Changes detected:"
git status --short
[ -n "${GITHUB_OUTPUT:-}" ] && echo "has_changes=true" >> "$GITHUB_OUTPUT"

# ── 2. Configure git identity ──────────────────────────────────────────────
git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

# ── 3+4 loop: Sync, align, commit, push (with retry on race conditions) ────
MAX_PUSH_ATTEMPTS=8
push_attempt=0

while true; do

# ── 3. Sync with remote (stash → rebase → pop → merge if needed) ──────────
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "⚠️ Remote updated — syncing before commit..."
  BASE_SHA="$LOCAL"

  # Save local copies so we can merge after rebase if stash-pop conflicts
  TMPDIR=$(mktemp -d)
  for f in "${RESOLVED_FILES[@]}"; do
    if [ -f "$f" ]; then
      mkdir -p "$TMPDIR/local/$(dirname "$f")"
      cp "$f" "$TMPDIR/local/$f"
    fi
    if git cat-file -e "$BASE_SHA:$f" 2>/dev/null; then
      mkdir -p "$TMPDIR/base/$(dirname "$f")"
      git show "$BASE_SHA:$f" > "$TMPDIR/base/$f"
    fi
  done

  # Stash local changes so rebase can proceed cleanly
  git stash --include-untracked

  if ! git pull --rebase origin main; then
    git rebase --abort 2>/dev/null || true
    echo "⚠️ Fast-rebase failed — pulling with merge..."
    git pull --no-rebase origin main || true
  fi

  # Restore local changes
  if ! git stash pop 2>/dev/null; then
    echo "⚠️ Stash-pop conflict — merging data files..."
    CONFLICT_FILES="$(git diff --name-only --diff-filter=U || true)"

    # Reset index conflict markers so we can write clean files
    git reset HEAD -- . 2>/dev/null || true

    # Resolve conflicted tracked JSON files with safe 3-way merge (base/local/remote).
    # Non-JSON files keep local version (run output is authoritative).
    for f in "${RESOLVED_FILES[@]}"; do
      [ -f "$TMPDIR/local/$f" ] || continue
      if [ -n "$CONFLICT_FILES" ] && ! printf '%s\n' "$CONFLICT_FILES" | grep -Fxq "$f"; then
        continue
      fi

      if [[ "$f" == *.json ]]; then
        mkdir -p "$TMPDIR/remote/$(dirname "$f")"
        if git cat-file -e "HEAD:$f" 2>/dev/null; then
          git show "HEAD:$f" > "$TMPDIR/remote/$f"
        fi

        key_hint=""
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

        merge_json_3way \
          "$TMPDIR/base/$f" \
          "$TMPDIR/remote/$f" \
          "$TMPDIR/local/$f" \
          "$f" \
          "$key_hint" \
          "$f" || {
          echo "❌ Failed safe merge for $f"
          exit 1
        }
      else
        cp "$TMPDIR/local/$f" "$f"
      fi
    done

    UNMERGED="$(git diff --name-only --diff-filter=U || true)"
    if [ -n "$UNMERGED" ]; then
      echo "❌ Unmerged files remain after conflict resolution:"
      echo "$UNMERGED"
      exit 1
    fi

    # Drop the failed stash entry
    git stash drop 2>/dev/null || true
  fi

  rm -rf "$TMPDIR"
fi

# ── 4. Stage, commit, push ────────────────────────────────────────────────
# Keep canonical files aligned after any merge path.
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

if (jobs && fs.existsSync(publicJobsPath)) {
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

# Validate critical JSON files before staging/commit to avoid destructive pushes.
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

git add "${ALL_FILES[@]}"

# After merge/rebase the diff might be empty (remote already had the same data)
if git diff --cached --quiet; then
  echo "ℹ️ No effective changes after sync — already up to date"
  exit 0
fi

git commit -m "$COMMIT_MSG"

# Last-moment rebase: fetch latest remote right before push to minimise race window
git fetch origin main
if ! git rebase origin/main 2>/dev/null; then
  echo "⚠️ Last-moment rebase conflict — resolving with 3-way JSON merge..."
  git rebase --abort 2>/dev/null || true
  git reset --mixed HEAD~1

  # Re-pull with merge strategy to get remote changes
  git stash --include-untracked 2>/dev/null || true
  git pull --no-rebase origin main || true

  if ! git stash pop 2>/dev/null; then
    echo "  🔀 Resolving stash-pop conflict after last-moment rebase..."
    CONFLICT_FILES="$(git diff --name-only --diff-filter=U || true)"
    git reset HEAD -- . 2>/dev/null || true

    for f in "${RESOLVED_FILES[@]}"; do
      [ -f "$TMPDIR/local/$f" ] || continue
      if [ -n "$CONFLICT_FILES" ] && ! printf '%s\n' "$CONFLICT_FILES" | grep -Fxq "$f"; then
        continue
      fi
      if [[ "$f" == *.json ]]; then
        mkdir -p "$TMPDIR/remote/$(dirname "$f")"
        if git cat-file -e "HEAD:$f" 2>/dev/null; then
          git show "HEAD:$f" > "$TMPDIR/remote/$f"
        fi
        key_hint=""
        case "$f" in
          data/jobs.json|public/data/jobs.json) key_hint="url" ;;
          data/jobs-crawler-summaries.json) key_hint="key" ;;
          data/ticino-companies-extra.json) key_hint="website" ;;
        esac
        merge_json_3way "$TMPDIR/base/$f" "$TMPDIR/remote/$f" "$TMPDIR/local/$f" "$f" "$key_hint"
      else
        cp "$TMPDIR/local/$f" "$f"
      fi
    done
    git checkout -- . 2>/dev/null || true
  fi

  git add "${ALL_FILES[@]}"
  if git diff --cached --quiet; then
    echo "ℹ️ No effective changes after last-moment sync — already up to date"
    exit 0
  fi
  git commit -m "$COMMIT_MSG"
  # Fall through to the push below
fi

# Push — if rejected, undo commit and re-run sync from step 3
push_attempt=$((push_attempt + 1))
if git push origin main; then
  echo "✅ Pushed successfully"

  # ── 5. Trigger deploy — GITHUB_TOKEN pushes don't trigger other workflows ─
  PUSHED_SHA="$(git rev-parse HEAD)"
  EXPECTED_SHA="$PUSHED_SHA" DEPLOY_REF="main" bash "$(dirname "$0")/trigger-deploy.sh" || true

  exit 0
fi

if [ "$push_attempt" -ge "$MAX_PUSH_ATTEMPTS" ]; then
  echo "❌ Push failed after $MAX_PUSH_ATTEMPTS attempts"
  exit 1
fi

# Backoff: 5s, 10s, 15s, ... + random jitter (0-5s)
DELAY=$(( push_attempt * 5 + RANDOM % 6 ))
echo "⚠️ Push rejected (attempt $push_attempt/$MAX_PUSH_ATTEMPTS) — waiting ${DELAY}s before resync..."
sleep "$DELAY"
git reset --mixed HEAD~1

done  # end retry loop
