/**
 * Logical store for the job-board history.
 *
 * The legacy `data/jobs-stats-history.json` is kept as a read fallback so the
 * migration does not require a 50+ MB one-shot rewrite. New daily entries are
 * written to the current calendar-month shard only. Shards are authoritative
 * for dates they contain; this lets the first post-migration refresh replace
 * the legacy copy of today's entry without rewriting the legacy blob.
 */
import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic, writeShardFileIfChanged } from './atomic-shard-write.mjs';

export const JOB_STATS_HISTORY_LEGACY_FILE = 'data/jobs-stats-history.json';
export const JOB_STATS_HISTORY_SHARD_DIR = 'data/jobs-stats-history';
export const JOB_STATS_HISTORY_MANIFEST_FILE = `${JOB_STATS_HISTORY_SHARD_DIR}/manifest.json`;

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/;
const MONTH_SHARD_RE = /^(\d{4}-(?:0[1-9]|1[0-2]))\.json$/;

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
 * Merge entries produced by concurrent writers of one monthly shard.
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

export function jobStatsHistoryShardFile(month, rootDir = process.cwd()) {
  if (!MONTH_RE.test(String(month))) throw new Error(`Invalid job stats history month: ${month}`);
  return path.resolve(rootDir, JOB_STATS_HISTORY_SHARD_DIR, `${month}.json`);
}

export function listJobStatsHistoryShardFiles(rootDir = process.cwd()) {
  const dir = path.resolve(rootDir, JOB_STATS_HISTORY_SHARD_DIR);
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => MONTH_SHARD_RE.test(name)).sort();
  } catch {
    return [];
  }
  return names.map((name) => path.join(dir, name));
}

function readShardDocument(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, ok: true, entries: [] };
  const parsed = readJson(filePath);
  if (!parsed || !Array.isArray(parsed.entries)) return { exists: true, ok: false, entries: [] };
  return { exists: true, ok: true, entries: historyEntries(parsed) };
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
 * Read the logical history from the legacy fallback plus monthly shards.
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
 * Write only the current month's shard. Existing legacy dates are deliberately
 * not backfilled: the first post-migration run writes today's complete entry,
 * and the reader keeps older legacy dates visible without a 50+ MB diff.
 */
export function writeJobsStatsHistory(history = {}, rootDir = process.cwd(), options = {}) {
  const entries = historyEntries(history);
  const currentDate = String(options.currentDate || entries.at(-1)?.date || '');
  if (!DATE_RE.test(currentDate)) throw new Error('A valid currentDate is required to write job stats history');

  const month = currentDate.slice(0, 7);
  const filePath = jobStatsHistoryShardFile(month, rootDir);
  const existing = readShardDocument(filePath);
  if (!existing.ok) throw new Error(`Cannot safely update corrupt job stats shard: ${filePath}`);

  const currentEntry = entries.find((entry) => entry.date === currentDate);
  if (!currentEntry) throw new Error(`History does not contain current date ${currentDate}`);

  const shardEntries = new Map(existing.entries.map((entry) => [entry.date, clone(entry)]));
  shardEntries.set(currentDate, clone(currentEntry));
  const serialized = JSON.stringify({ entries: [...shardEntries.values()].sort((a, b) => a.date.localeCompare(b.date)) }, null, 2) + '\n';

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const shardChanged = writeShardFileIfChanged(filePath, serialized);
  const months = listJobStatsHistoryShardFiles(rootDir)
    .map((file) => path.basename(file, '.json'))
    .sort();
  const manifestPath = path.resolve(rootDir, JOB_STATS_HISTORY_MANIFEST_FILE);
  writeFileAtomic(
    manifestPath,
    JSON.stringify({
      version: 1,
      format: 'monthly-entry-shards',
      legacyFallback: JOB_STATS_HISTORY_LEGACY_FILE,
      months,
    }, null, 2) + '\n',
  );

  return { month, shardChanged, months, filePath };
}
