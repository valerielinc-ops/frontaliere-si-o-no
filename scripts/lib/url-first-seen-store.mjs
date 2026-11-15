/**
 * Sharded store for the `url-first-seen` accumulator: `{ "<path>": "YYYY-MM-DD" }`,
 * the first day a URL reached a sitemap. Monotonic (the earliest date wins) and
 * never pruned.
 *
 * Why this exists (2026-11-15): the accumulator was a single committed file,
 * `data/url-first-seen.json`. A publish run produced a 213.54 MB version of it
 * (2 170 968 entries, 1 285 542 of them minted in November) and the history
 * commit was rejected by GitHub on every attempt:
 *
 *   remote: error: File data/url-first-seen.json is 213.54 MB; this exceeds
 *   GitHub's file size limit of 100.00 MB
 *   remote: error: GH001: Large files detected.
 *
 * Five rebases later the step ended `Failed to push after 5 attempts` inside a
 * `continue-on-error` job, so the run stayed green while `main` kept a file
 * frozen at 13/11. Stripping the indentation recovers 4%, and pruning is a SEO
 * decision that belongs to the owner, so this is the same lossless fix as
 * `scripts/lib/all-known-job-slugs-store.mjs` (#4248): a fixed set of plain-JSON
 * shards, each far below the limit.
 *
 * Layout: `data/url-first-seen/<h>.json`, `<h>` being the first hex digit of
 * `sha1(normalizedPath)` (16 shards, ~14 MB each today). The assignment is
 * deterministic, so a per-shard 3-way merge is correct and the `json-first-seen`
 * merge driver (`scripts/ci/merge-json-first-seen.mjs`) applies unchanged. Every
 * shard is `{ path: date }`, keys sorted, 2-space indent, one entry per line:
 * a commit only diffs the lines that changed.
 *
 * Single source of truth: the directory, the legacy path, the prefix length and
 * the shard-name pattern live HERE. Every writer, reader, workflow helper and
 * test imports them; nothing else spells `data/url-first-seen/` or a shard
 * regex.
 *
 * Migration: the legacy monolith may still exist next to the directory while the
 * first sharded publish is on its way to `main`. `loadFirstSeen` reads both and
 * keeps the EARLIEST date per path, whatever the order, so a reader never
 * regresses to an empty ledger and "first seen" stays what it says.
 *
 * Failure policy. A shard that exists but cannot be read is NEVER swallowed:
 * `loadFirstSeen` always names it in the returned report. Readers that must keep
 * going (the build filter is fail-open: a URL without a first-seen date leaves
 * the noindex band, which is the safe side) get the partial map plus that
 * report; readers that would WRITE (`strict: true`) or fail closed throw
 * instead, because rewriting a shard from a partial read destroys history.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeShardFileIfChanged } from './atomic-shard-write.mjs';

/** Repo-relative directory that holds the shards. */
export const URL_FIRST_SEEN_DIR = 'data/url-first-seen';

/** Repo-relative path of the legacy single-file ledger. */
export const URL_FIRST_SEEN_LEGACY_FILE = 'data/url-first-seen.json';

/** Hex digits of sha1(path) that select a shard: 1 digit = 16 shards. */
export const URL_FIRST_SEEN_SHARD_PREFIX_LENGTH = 1;

/** Every shard id, in file-name order: `0`..`f` for a one-digit prefix. */
export const URL_FIRST_SEEN_SHARD_IDS = Object.freeze(
  Array.from({ length: 16 ** URL_FIRST_SEEN_SHARD_PREFIX_LENGTH }, (_unused, i) =>
    i.toString(16).padStart(URL_FIRST_SEEN_SHARD_PREFIX_LENGTH, '0'),
  ),
);

/** Matches a shard file name, e.g. `a.json`. */
export const URL_FIRST_SEEN_SHARD_FILE_RE = new RegExp(
  `^[0-9a-f]{${URL_FIRST_SEEN_SHARD_PREFIX_LENGTH}}\\.json$`,
);

/**
 * Same normalisation as `build-plugins/shared/trafficEvidenceFilter.ts` and the
 * GSC refiner (leading slash, no query/hash, `index.html` folded, no trailing
 * slash): a key is the pathname the filter will look up.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizeFirstSeenPath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try { s = new URL(s).pathname; } catch { return ''; }
  }
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  s = s.replace(/\/index\.html$/, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

/**
 * Deterministic shard id of a path: the leading hex digit(s) of the sha1 of the
 * normalised path.
 *
 * @param {string} pathKey
 * @returns {string}
 */
export function urlFirstSeenShardId(pathKey) {
  return createHash('sha1')
    .update(normalizeFirstSeenPath(pathKey))
    .digest('hex')
    .slice(0, URL_FIRST_SEEN_SHARD_PREFIX_LENGTH);
}

/** File name of a shard: `a.json`. */
export function urlFirstSeenShardFileName(id) {
  return `${id}.json`;
}

/** Repo-relative path of a shard: `data/url-first-seen/a.json`. */
export function urlFirstSeenShardRelPath(id) {
  return `${URL_FIRST_SEEN_DIR}/${urlFirstSeenShardFileName(id)}`;
}

/**
 * True for the repo-relative path of one shard. The allowlist of the history
 * commit job is built on this, so a stray file in the directory is refused.
 *
 * @param {string} relPath
 */
export function isUrlFirstSeenShardRelPath(relPath) {
  const prefix = `${URL_FIRST_SEEN_DIR}/`;
  const value = String(relPath ?? '');
  return value.startsWith(prefix) && URL_FIRST_SEEN_SHARD_FILE_RE.test(value.slice(prefix.length));
}

/**
 * Resolved store locations for a repo root. `dir` and `legacyFile` may be
 * overridden independently (tests, `--out`); `null` means "not used".
 *
 * @param {string} rootDir
 * @returns {{ dir: string, legacyFile: string }}
 */
export function urlFirstSeenStorePaths(rootDir = process.cwd()) {
  return {
    dir: path.resolve(rootDir, URL_FIRST_SEEN_DIR),
    legacyFile: path.resolve(rootDir, URL_FIRST_SEEN_LEGACY_FILE),
  };
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The earlier of two ISO dates. Compares parsed timestamps; an unparseable date
 * loses against a parseable one, and two unparseable ones fall back to string
 * order so the result never depends on argument order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function earlierFirstSeen(a, b) {
  if (a === b) return a;
  // Fast path for the shape every writer produces (YYYY-MM-DD): lexical order is
  // chronological order. Measured on 2.17 M duplicated entries during the
  // migration, where parsing both sides of every pair dominated the load.
  if (ISO_DAY_RE.test(a) && ISO_DAY_RE.test(b)) return b < a ? b : a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  const aOk = Number.isFinite(ta);
  const bOk = Number.isFinite(tb);
  if (aOk && bOk) return tb < ta ? b : a;
  if (aOk) return a;
  if (bOk) return b;
  return b < a ? b : a;
}

/**
 * @typedef {object} FirstSeenLoadReport
 * @property {'directory'|'legacy'|'both'|'none'} source what was found on disk
 * @property {number} shardsExpected
 * @property {number} shardsRead
 * @property {string[]} shardsMissing ids of shards absent while the directory exists
 * @property {{ file: string, error: string }[]} shardsUnreadable
 * @property {{ present: boolean, read: boolean, error: string|null, entries: number }} legacy
 * @property {number} legacyContributed entries for which the legacy file supplied
 *   the winning date (absent from the shards, or earlier than theirs)
 * @property {number} skippedEntries entries with a non-string date
 * @property {number} entries merged entries
 */

function readObjectFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) throw new Error('file is empty');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('not a path -> date object');
  }
  return parsed;
}

function describeError(error) {
  return String(error?.message ?? error).split('\n')[0];
}

/**
 * Merge the shard directory and the legacy file into one map, earliest date
 * per path. Either location may be absent.
 *
 * `strict: true` throws on the first unreadable shard or legacy file (and on a
 * directory with missing shards) instead of returning a partial map: use it
 * wherever the result is written back or a wrong answer is worse than none.
 * Otherwise problems are returned in `report`, never swallowed.
 *
 * @param {{ dir?: string|null, legacyFile?: string|null, strict?: boolean }} [options]
 * @returns {{ entries: Map<string, string>, report: FirstSeenLoadReport }}
 */
export function loadFirstSeen({ dir = null, legacyFile = null, strict = false } = {}) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  /** @type {FirstSeenLoadReport} */
  const report = {
    source: 'none',
    shardsExpected: URL_FIRST_SEEN_SHARD_IDS.length,
    shardsRead: 0,
    shardsMissing: [],
    shardsUnreadable: [],
    legacy: { present: false, read: false, error: null, entries: 0 },
    legacyContributed: 0,
    skippedEntries: 0,
    entries: 0,
  };

  const merge = (source, fromLegacy) => {
    for (const [key, date] of Object.entries(source)) {
      if (typeof date !== 'string' || !date) { report.skippedEntries++; continue; }
      const cur = entries.get(key);
      if (cur === undefined) {
        entries.set(key, date);
        if (fromLegacy) report.legacyContributed++;
      } else {
        const winner = earlierFirstSeen(cur, date);
        if (winner !== cur) {
          entries.set(key, winner);
          if (fromLegacy) report.legacyContributed++;
        }
      }
    }
  };

  const hasDir = Boolean(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  if (hasDir) {
    const present = new Set(
      fs.readdirSync(dir).filter((name) => URL_FIRST_SEEN_SHARD_FILE_RE.test(name)),
    );
    for (const id of URL_FIRST_SEEN_SHARD_IDS) {
      const name = urlFirstSeenShardFileName(id);
      if (!present.has(name)) { report.shardsMissing.push(id); continue; }
      const file = path.join(dir, name);
      try {
        merge(readObjectFile(file), false);
        report.shardsRead++;
      } catch (error) {
        const entry = { file: name, error: describeError(error) };
        if (strict) throw new Error(`[url-first-seen] shard ${file} is present but unreadable: ${entry.error}`);
        report.shardsUnreadable.push(entry);
      }
    }
    if (strict && report.shardsMissing.length > 0) {
      throw new Error(
        `[url-first-seen] ${dir} exists but shards are missing: ${report.shardsMissing.map(urlFirstSeenShardFileName).join(', ')}`,
      );
    }
  }

  const hasLegacy = Boolean(legacyFile) && fs.existsSync(legacyFile);
  if (hasLegacy) {
    report.legacy.present = true;
    try {
      const legacy = readObjectFile(legacyFile);
      report.legacy.entries = Object.keys(legacy).length;
      merge(legacy, true);
      report.legacy.read = true;
    } catch (error) {
      report.legacy.error = describeError(error);
      if (strict) throw new Error(`[url-first-seen] legacy ledger ${legacyFile} is present but unreadable: ${report.legacy.error}`);
    }
  }

  report.source = hasDir && hasLegacy ? 'both' : hasDir ? 'directory' : hasLegacy ? 'legacy' : 'none';
  report.entries = entries.size;
  return { entries, report };
}

/**
 * One line that says what was read, from where, and what was not. Always names
 * every unreadable shard: a degraded read must never look like a clean one.
 *
 * @param {FirstSeenLoadReport} report
 * @returns {{ level: 'log'|'warn', message: string }}
 */
export function describeFirstSeenLoad(report) {
  const parts = [
    `source=${report.source}`,
    `shards read=${report.shardsRead}/${report.shardsExpected}`,
    `unreadable=${report.shardsUnreadable.length}`,
    `missing=${report.shardsMissing.length}`,
    `legacy=${report.legacy.present ? (report.legacy.read ? `read(${report.legacy.entries})` : 'UNREADABLE') : 'absent'}`,
    `entries=${report.entries}`,
  ];
  const problems = [];
  for (const { file, error } of report.shardsUnreadable) problems.push(`unreadable shard ${file}: ${error}`);
  if (report.source !== 'none' && report.shardsMissing.length > 0 && report.source !== 'legacy') {
    problems.push(`missing shards: ${report.shardsMissing.map(urlFirstSeenShardFileName).join(', ')}`);
  }
  if (report.legacy.present && !report.legacy.read) problems.push(`legacy file unreadable: ${report.legacy.error}`);
  if (report.skippedEntries > 0) problems.push(`${report.skippedEntries} entries with a non-string date skipped`);
  const message = `[url-first-seen] ${parts.join(' ')}${problems.length ? ` | ${problems.join(' | ')}` : ''}`;
  return { level: problems.length ? 'warn' : 'log', message };
}

/**
 * Split a map into one sorted `{ path: date }` object per shard. Every shard id
 * is present, empty ones included, so a full write always leaves 16 files.
 *
 * @param {Iterable<[string, string]>} entries
 * @returns {Map<string, Record<string, string>>}
 */
export function partitionFirstSeen(entries) {
  /** @type {Map<string, Record<string, string>>} */
  const buckets = new Map(URL_FIRST_SEEN_SHARD_IDS.map((id) => [id, Object.create(null)]));
  for (const [key, date] of entries) buckets.get(urlFirstSeenShardId(key))[key] = date;
  /** @type {Map<string, Record<string, string>>} */
  const sortedBuckets = new Map();
  for (const [id, bucket] of buckets) {
    const sorted = {};
    for (const key of Object.keys(bucket).sort()) sorted[key] = bucket[key];
    sortedBuckets.set(id, sorted);
  }
  return sortedBuckets;
}

/** Serialised shard: 2-space pretty print, trailing newline (matches the merge driver). */
export function serializeFirstSeenShard(shard) {
  return JSON.stringify(shard, null, 2) + '\n';
}

/**
 * Write every shard (atomically, skipping byte-identical ones).
 *
 * @param {string} dir absolute shard directory
 * @param {Iterable<[string, string]>} entries
 * @returns {{ written: string[], unchanged: string[], bytes: Record<string, number> }}
 */
export function writeFirstSeenShards(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const unchanged = [];
  const bytes = {};
  for (const [id, shard] of partitionFirstSeen(entries)) {
    const content = serializeFirstSeenShard(shard);
    bytes[id] = Buffer.byteLength(content);
    const changed = writeShardFileIfChanged(path.join(dir, urlFirstSeenShardFileName(id)), content);
    (changed ? written : unchanged).push(id);
  }
  return { written, unchanged, bytes };
}
