/**
 * File naming of the sharded expired archive — the ONE place this convention
 * lives (see scripts/lib/expired-slice-store.mjs for the layout and why).
 *
 *   <key>.json              index 0 — the historical monolith
 *   <key>.shard-NNN.json    index N >= 1
 *
 * Dependency-free on purpose (node:path + the slice predicate): the post-push
 * guard and the retired-archive observer read git trees with it in sparse
 * checkouts that hold `scripts/` only.
 */
import path from 'node:path';
import { isSliceFile } from './crawler-slice-files.mjs';

/** Matches `<key>.shard-NNN.json`; the key is everything before `.shard-`. */
export const EXPIRED_SLICE_SHARD_RE = /^(.+)\.shard-(\d{3,})\.json$/u;

/** File name of shard `index` of `key`: 0 is the monolith `<key>.json`. */
export function expiredSliceFileName(key, index = 0) {
  if (!key) throw new TypeError('expired slice key is required');
  if (!Number.isInteger(index) || index < 0) throw new TypeError(`invalid shard index ${index}`);
  return index === 0 ? `${key}.json` : `${key}.shard-${String(index).padStart(3, '0')}.json`;
}

/**
 * `{ key, index }` for a slice file name, or null when the name is not an
 * expired slice (scratch files, locale caches, non-JSON).
 */
export function parseExpiredSliceFileName(name) {
  const base = path.basename(String(name || ''));
  if (!isSliceFile(base)) return null;
  const shard = EXPIRED_SLICE_SHARD_RE.exec(base);
  if (shard) return { key: shard[1], index: Number(shard[2]) };
  return { key: base.slice(0, -'.json'.length), index: 0 };
}

/** The crawler key that owns a slice file name (`coop-ticino.shard-001.json` → `coop-ticino`). */
export function expiredSliceKeyOf(name) {
  return parseExpiredSliceFileName(name)?.key ?? null;
}

/**
 * The names (from any listing — a directory, a `git ls-tree`) that belong to
 * `key`, in index order. Pure: callers reading a git tree use it too.
 */
export function expiredSliceNamesForKey(names, key) {
  return [...names]
    .map((name) => ({ name, parsed: parseExpiredSliceFileName(name) }))
    .filter(({ parsed }) => parsed && parsed.key === key)
    .sort((a, b) => a.parsed.index - b.parsed.index)
    .map(({ name }) => name);
}
