/**
 * Logical store for the job-board history.
 *
 * The legacy `data/jobs-stats-history.json` is kept as a read fallback so the
 * migration does not require a 50+ MB one-shot rewrite. Entries are written
 * as one shard per day (`YYYY-MM-DD.json` in the shard directory); legacy
 * monthly shards (`YYYY-MM.json`, #9409) are still read and are migrated into
 * daily shards by the next write. Shards are authoritative for dates they
 * contain; this lets the first post-migration refresh replace the legacy copy
 * of today's entry without rewriting the legacy blob.
 */
import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic, writeShardFileIfChanged } from './atomic-shard-write.mjs';
import { assertAccumulatorByteFloor } from './accumulator-byte-floor-guard.mjs';

export const JOB_STATS_HISTORY_LEGACY_FILE = 'data/jobs-stats-history.json';
export const JOB_STATS_HISTORY_SHARD_DIR = 'data/jobs-stats-history';
export const JOB_STATS_HISTORY_MANIFEST_FILE = `${JOB_STATS_HISTORY_SHARD_DIR}/manifest.json`;
export const JOB_STATS_HISTORY_RETENTION_LIMIT = 180;
export const JOB_STATS_HISTORY_COMPACT_AFTER_DAYS = 30;

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/;
const MONTH_SHARD_RE = /^(\d{4}-(?:0[1-9]|1[0-2]))\.json$/;
const DAY_SHARD_RE = /^(\d{4}-(?:0[1-9]|1[0-2])-\d{2})\.json$/;

/**
 * Hard ceiling for one shard file, below GitHub's 100 MB per-file push limit.
 * A single verbose day weighs ~20 MB (2026-09), so a daily shard stays far
 * under it; the guard only fires if one day alone grows past it.
 */
export const JOB_STATS_HISTORY_SHARD_MAX_BYTES = 90_000_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sortedUniqueStrings(...values) {
  return [...new Set(values.flatMap((value) => (Array.isArray(value) ? value : [])))]
    .filter((value) => typeof value === 'string')
    .sort();
}

function mergeStatItems(a = {}, b = {}) {
  const merged = { ...a, ...b };
  if (a.name && !b.name) merged.name = a.name;
  if (a.url && !b.url) merged.url = a.url;

  merged.addedKeys = sortedUniqueStrings(a.addedKeys, b.addedKeys);
  merged.updatedKeys = sortedUniqueStrings(a.updatedKeys, b.updatedKeys);
  merged.removedKeys = sortedUniqueStrings(a.removedKeys, b.removedKeys);

  const updatedCount = Math.max(
    merged.updatedKeys.length,
    numeric(a.updatedCount),
    numeric(b.updatedCount),
  );
  const removedCount = Math.max(
    merged.removedKeys.length,
    numeric(a.removedCount),
    numeric(b.removedCount),
  );
  if (updatedCount > 0) merged.updatedCount = updatedCount;
  else delete merged.updatedCount;
  if (removedCount > 0) merged.removedCount = removedCount;
  else delete merged.removedCount;

  return merged;
}

function mergeStatBuckets(a = [], b = []) {
  const byKey = new Map();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || item.name || '');
    if (!key) continue;
    byKey.set(key, byKey.has(key) ? mergeStatItems(byKey.get(key), item) : clone(item));
  }
  return [...byKey.values()].sort((left, right) =>
    String(left.key || left.name || '').localeCompare(String(right.key || right.name || ''))
  );
}

/**
 * Merge entries produced by concurrent writers of one shard.
 *
 * The history writer is monotone within a date: action keys are unioned and
 * scalar counts are never allowed to fall below either side. This is also the
 * semantic used by the pre-existing in-memory same-date deduplicator.
 */
export function mergeJobStatsHistoryEntries(...entryLists) {
  const byDate = new Map();
  for (const list of entryLists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== 'object' || !DATE_RE.test(String(entry.date || ''))) continue;
      const date = String(entry.date);
      byDate.set(date, byDate.has(date) ? mergeHistoryEntry(byDate.get(date), entry) : clone(entry));
    }
  }
  return [...byDate.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
}

function mergeHistoryEntry(a = {}, b = {}) {
  const merged = { ...a, ...b };
  merged.date = String(a.date || b.date);
  merged.totalJobs = Math.max(numeric(a.totalJobs), numeric(b.totalJobs));

  for (const action of ['added', 'updated', 'removed']) {
    const keys = sortedUniqueStrings(a[`${action}Keys`], b[`${action}Keys`]);
    merged[`${action}Keys`] = keys;
    merged[action] = Math.max(keys.length, numeric(a[action]), numeric(b[action]));
  }

  for (const bucket of ['companyStats', 'locationStats', 'titleStats']) {
    merged[bucket] = mergeStatBuckets(a[bucket], b[bucket]);
  }
  return merged;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function historyEntries(value) {
  return Array.isArray(value?.entries)
    ? value.entries.filter((entry) => entry && typeof entry === 'object' && DATE_RE.test(String(entry.date || '')))
    : [];
}

function legacyHistory(rootDir) {
  const parsed = readJson(path.resolve(rootDir, JOB_STATS_HISTORY_LEGACY_FILE));
  return {
    version: Math.max(1, numeric(parsed?.version)),
    generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : '',
    entries: mergeJobStatsHistoryEntries(historyEntries(parsed)),
  };
}

/**
 * Path of one shard. A `YYYY-MM-DD` key names a daily shard (the format
 * written since #9654); a `YYYY-MM` key names a legacy monthly shard, which is
 * still read and migrated but never written again.
 */
export function jobStatsHistoryShardFile(key, rootDir = process.cwd()) {
  const value = String(key);
  if (!MONTH_RE.test(value) && !DATE_RE.test(value)) {
    throw new Error(`Invalid job stats history shard key: ${key}`);
  }
  return path.resolve(rootDir, JOB_STATS_HISTORY_SHARD_DIR, `${value}.json`);
}

export function listJobStatsHistoryShardFiles(rootDir = process.cwd()) {
  const dir = path.resolve(rootDir, JOB_STATS_HISTORY_SHARD_DIR);
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => MONTH_SHARD_RE.test(name) || DAY_SHARD_RE.test(name)).sort();
  } catch {
    return [];
  }
  return names.map((name) => path.join(dir, name));
}

/** Canonical on-disk form of a shard, shared by the writer and the merge driver. */
export function serializeJobStatsHistoryShard(entries = []) {
  return JSON.stringify({ entries }, null, 2) + '\n';
}

/**
 * Refuse to produce a shard GitHub would reject at push time. Failing here
 * names the file and the size, instead of a remote `pre-receive hook declined`
 * after the commit has already been built (#9654).
 */
export function assertJobStatsHistoryShardSize(filePath, serialized, maxBytes = JOB_STATS_HISTORY_SHARD_MAX_BYTES) {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(
      `Job stats history shard ${filePath} would be ${(bytes / 1e6).toFixed(2)} MB, above the `
      + `${(maxBytes / 1e6).toFixed(2)} MB guard (GitHub rejects files over 100 MB); refusing to write it`,
    );
  }
  return bytes;
}

function readShardDocument(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, ok: true, entries: [] };
  const parsed = readJson(filePath);
  if (!parsed || !Array.isArray(parsed.entries)) return { exists: true, ok: false, entries: [] };
  const entries = historyEntries(parsed);
  if (parsed.entries.length > 0 && entries.length === 0) {
    return {
      exists: true,
      ok: false,
      reason: 'no-valid-date-entries',
      entries: [],
    };
  }
  return { exists: true, ok: true, entries };
}

function isCompactedHistoryEntry(entry = {}) {
  // Compaction keeps addedKeys and the bucket identities for the 30-day
  // leader views. It only removes the key arrays that consumers never read by
  // value (entry/bucket updatedKeys and removedKeys). Treating non-empty
  // titleStats as evidence of an un-compacted entry made the guard reject the
  // legitimate locale-migration rewrite of 2026-09-24 (#9876).
  if (!Array.isArray(entry.addedKeys)
    || !Array.isArray(entry.updatedKeys)
    || !Array.isArray(entry.removedKeys)
    || entry.updatedKeys.length > 0
    || entry.removedKeys.length > 0) {
    return false;
  }

  return ['companyStats', 'locationStats', 'titleStats'].every((bucket) =>
    Array.isArray(entry[bucket])
    && entry[bucket].every((item) =>
      item
      && (!Array.isArray(item.updatedKeys) || item.updatedKeys.length === 0)
      && (!Array.isArray(item.removedKeys) || item.removedKeys.length === 0)
    )
  );
}

function hasSameHistoryCounters(previous = {}, next = {}) {
  return previous.date === next.date
    && ['totalJobs', 'added', 'updated', 'removed'].every((field) =>
      numeric(previous[field]) === numeric(next[field])
    );
}

function actionCount(item = {}, action) {
  return Math.max(
    sortedUniqueStrings(item[`${action}Keys`]).length,
    numeric(item[`${action}Count`]),
  );
}

function preservesCompactionPayload(previous = {}, next = {}) {
  if (!Array.isArray(previous.addedKeys) || !Array.isArray(next.addedKeys)) return false;

  const nextAddedKeys = new Set(sortedUniqueStrings(next.addedKeys));
  if (!sortedUniqueStrings(previous.addedKeys).every((key) => nextAddedKeys.has(key))) return false;

  return ['companyStats', 'locationStats', 'titleStats'].every((bucket) => {
    const previousItems = Array.isArray(previous[bucket]) ? previous[bucket] : [];
    const nextItems = Array.isArray(next[bucket]) ? next[bucket] : [];

    return previousItems.every((previousItem) => {
      const previousIdentity = String(previousItem?.key || previousItem?.name || '');
      const previousAddedKeys = sortedUniqueStrings(previousItem?.addedKeys);
      const previousUpdatedCount = actionCount(previousItem || {}, 'updated');
      const previousRemovedCount = actionCount(previousItem || {}, 'removed');

      // Buckets with no action payload are only descriptive indexes. Locale
      // migration is allowed to merge/drop those rows because no consumer
      // reads their identity without an added/updated/removed value. Requiring
      // an exact identity for every empty historical bucket made a legitimate
      // 18k -> 1.5k title rewrite look like catastrophic truncation.
      if (previousAddedKeys.length === 0
        && previousUpdatedCount === 0
        && previousRemovedCount === 0) {
        return true;
      }

      return nextItems.some((nextItem) => {
        const sameIdentity = previousIdentity !== ''
          && String(nextItem?.key || nextItem?.name || '') === previousIdentity;
        const nextItemAddedKeys = sortedUniqueStrings(nextItem?.addedKeys);
        const preservesAddedKeys = previousAddedKeys.every((key) => nextItemAddedKeys.includes(key));
        const preservesCounts = actionCount(nextItem || {}, 'updated') >= previousUpdatedCount
          && actionCount(nextItem || {}, 'removed') >= previousRemovedCount;

        // Locale migration can change a title key/name, so its stable added
        // job keys are also an acceptable identity. The payload itself must
        // still survive; matching an empty replacement is never enough.
        return preservesAddedKeys
          && preservesCounts
          && (sameIdentity || previousAddedKeys.length > 0);
      });
    });
  });
}

function readShardedHistory(rootDir) {
  const entriesByDate = new Map();
  for (const filePath of listJobStatsHistoryShardFiles(rootDir)) {
    const document = readShardDocument(filePath);
    if (!document.ok) continue;
    for (const entry of document.entries) {
      const date = String(entry.date);
      entriesByDate.set(
        date,
        entriesByDate.has(date)
          ? mergeHistoryEntry(entriesByDate.get(date), entry)
          : clone(entry),
      );
    }
  }
  return [...entriesByDate.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
}

/**
 * Read the logical history from the legacy fallback plus daily and legacy
 * monthly shards.
 * Shards override legacy entries for the dates they contain.
 */
export function readJobsStatsHistory(rootDir = process.cwd()) {
  const legacy = legacyHistory(rootDir);
  const byDate = new Map(legacy.entries.map((entry) => [entry.date, entry]));
  for (const entry of readShardedHistory(rootDir)) byDate.set(entry.date, entry);

  return {
    version: legacy.version,
    generatedAt: legacy.generatedAt,
    entries: [...byDate.values()].sort((left, right) => String(left.date).localeCompare(String(right.date))),
  };
}

/**
 * Write the logical history as one shard per day.
 *
 * Monthly shards (#9409) grew with every day of the month: the current month
 * kept each past day verbatim, ~20 MB per day, and 2026-09 hit 105 MB after
 * five days, which GitHub refuses to push (#9654). A daily shard is bounded by
 * one day's payload by construction.
 *
 * Every date already materialized in a shard (daily or legacy monthly) is
 * rewritten from the canonical history: past days in their slimmed/compacted
 * form, the current day verbatim. Legacy monthly shards are thereby migrated
 * into daily files and removed. Legacy-monolith dates are deliberately not
 * backfilled: the reader keeps them visible without a 50+ MB diff. Dates the
 * canonical history no longer holds (retention) are dropped.
 */
export function writeJobsStatsHistory(history = {}, rootDir = process.cwd(), options = {}) {
  const entries = historyEntries(history);
  const currentDate = String(options.currentDate || entries.at(-1)?.date || '');
  if (!DATE_RE.test(currentDate)) throw new Error('A valid currentDate is required to write job stats history');
  const maxShardBytes = Number(options.maxShardBytes) > 0
    ? Number(options.maxShardBytes)
    : JOB_STATS_HISTORY_SHARD_MAX_BYTES;
  const retentionLimit = Number(options.historyLimit) > 0
    ? Number(options.historyLimit)
    : JOB_STATS_HISTORY_RETENTION_LIMIT;

  const filePath = jobStatsHistoryShardFile(currentDate, rootDir);
  const currentEntry = entries.find((entry) => entry.date === currentDate);
  if (!currentEntry) throw new Error(`History does not contain current date ${currentDate}`);

  const canonicalByDate = new Map(entries.map((entry) => [entry.date, entry]));
  const targetDates = new Set([currentDate]);
  const obsoleteFiles = [];

  for (const shardFile of listJobStatsHistoryShardFiles(rootDir)) {
    const existing = readShardDocument(shardFile);
    if (!existing.ok) {
      if (existing.reason === 'no-valid-date-entries') {
        throw new Error(
          `Cannot safely update job stats shard with non-empty entries but no valid dates: ${shardFile}`,
        );
      }
      if (shardFile === filePath) {
        throw new Error(`Cannot safely update corrupt job stats shard: ${shardFile}`);
      }
      // A corrupt shard cannot be migrated: leave it for a human, never delete it.
      continue;
    }
    for (const existingEntry of existing.entries) {
      if (canonicalByDate.has(existingEntry.date)) targetDates.add(existingEntry.date);
    }
    obsoleteFiles.push({
      filePath: shardFile,
      entries: existing.entries,
    });
  }

  // Serialize and size-check every shard before touching the disk, so an
  // oversized day leaves the previous store intact.
  const planned = [...targetDates].sort().map((date) => {
    const shardFile = jobStatsHistoryShardFile(date, rootDir);
    const entry = date === currentDate ? currentEntry : canonicalByDate.get(date);
    const serialized = serializeJobStatsHistoryShard([clone(entry)]);
    assertJobStatsHistoryShardSize(shardFile, serialized, maxShardBytes);
    // Older entries are intentionally compacted after the verbose window.
    // Locale migration can also collapse equivalent historical title buckets.
    // Exempt either rewrite only when the existing shard is valid and all
    // logical counters are preserved; an empty/degraded fallback therefore
    // remains fail-closed even if it happens to have the compacted shape.
    const existing = readShardDocument(shardFile);
    const existingEntry = existing.entries.find((item) => item.date === date);
    const isControlledHistoricalRewrite = date < currentDate
      && existing.ok
      && hasSameHistoryCounters(existingEntry || {}, entry)
      && isCompactedHistoryEntry(entry)
      && preservesCompactionPayload(existingEntry || {}, entry);
    if (fs.existsSync(shardFile) && !isControlledHistoricalRewrite) {
      assertAccumulatorByteFloor(
        fs.statSync(shardFile).size,
        Buffer.byteLength(serialized, 'utf8'),
        { label: shardFile },
      );
    }
    return { shardFile, serialized };
  });

  let shardChanged = false;
  const written = new Set();
  fs.mkdirSync(path.resolve(rootDir, JOB_STATS_HISTORY_SHARD_DIR), { recursive: true });
  for (const { shardFile, serialized } of planned) {
    shardChanged = writeShardFileIfChanged(shardFile, serialized) || shardChanged;
    written.add(shardFile);
  }
  for (const { filePath, entries: obsoleteEntries } of obsoleteFiles) {
    if (written.has(filePath)) continue;
    // A valid old shard normally has a replacement daily shard in `planned`.
    // If its date vanished from the canonical history, only permit deleting a
    // small file; a large deletion is indistinguishable from a degraded read
    // that fell back to an empty history and must fail closed.
    const canonicalDates = [...canonicalByDate.keys()].sort();
    const oldestCanonicalDate = canonicalDates[0] || '';
    const retentionDrop = canonicalDates.length >= retentionLimit
      && obsoleteEntries.every((entry) => entry.date < oldestCanonicalDate || canonicalByDate.has(entry.date));
    const safeDeletion = obsoleteEntries.every((entry) =>
      canonicalByDate.has(entry.date) || (retentionDrop && entry.date < oldestCanonicalDate));
    if (!safeDeletion && fs.existsSync(filePath)) {
      assertAccumulatorByteFloor(fs.statSync(filePath).size, 0, { label: filePath });
    }
    fs.unlinkSync(filePath);
    shardChanged = true;
  }

  const days = listJobStatsHistoryShardFiles(rootDir)
    .map((file) => path.basename(file, '.json'))
    .filter((key) => DATE_RE.test(key))
    .sort();
  const manifestPath = path.resolve(rootDir, JOB_STATS_HISTORY_MANIFEST_FILE);
  writeFileAtomic(
    manifestPath,
    JSON.stringify({
      version: 2,
      format: 'daily-entry-shards',
      legacyFallback: JOB_STATS_HISTORY_LEGACY_FILE,
      days,
    }, null, 2) + '\n',
  );

  return { month: currentDate.slice(0, 7), date: currentDate, shardChanged, days, filePath };
}
