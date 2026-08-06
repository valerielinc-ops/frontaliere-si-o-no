#!/usr/bin/env node
// merge-ai-cache.mjs — custom git merge driver for data/jobs-ai-cache.json.
//
// WHY THIS EXISTS
// ---------------
// The crawler enforces a byte budget on this cache when it persists it
// (scripts/lib/ai-cache-budget.mjs) so the blob can never reach GitHub's hard
// 100 MB push limit. That budget is necessary but NOT sufficient on its own,
// because the file is written by ~40 crawlers racing each other's pushes and
// git reconciles their commits afterwards.
//
// The generic 3-way merge in scripts/lib/git-commit-data.sh auto-detects `key`
// as the array key for `entries` and UNIONS both sides. A union of two sides
// that are each exactly at budget is ABOVE budget — so the merge step could
// silently undo the very bound the persist step just applied, and the push
// would be rejected with GH001 for the whole crawler group. (git-commit-data.sh
// already notes the shape of this hazard for slug arrays: "each writer caps its
// own output through capSlugArray() before this" — capping the writer does not
// cap the merge.)
//
// This driver applies the cache's real merge semantics and then re-applies the
// bound:
//   1. union `entries` by `key`, keeping the observation with the newest
//      `touchedAt` — the same recency rule persistAiCacheToDisk uses when it
//      folds in a sibling's on-disk snapshot;
//   2. sort oldest-first and evict least-recently-used until the rendered
//      document fits the byte budget.
// So the merged result is bounded by construction, not by luck.
//
// Deletions are deliberately NOT honoured as deletions. In an accumulator
// (see merge-known-slugs-shard.mjs / merge-orphan-enriched-shard.mjs) a
// removed key must never be resurrected, because nothing can rebuild it. Here
// a "deletion" is only an LRU eviction, and resurrecting an entry costs at most
// one avoided LLM call while step 2 keeps the total bounded either way. Failing
// closed on an empty side would be wrong for the same reason: an empty cache is
// a perfectly legal state that costs a few LLM calls, not data loss.
//
// Registered in .gitattributes as `merge=ai-cache`; wired up with
// `git config merge.ai-cache.driver` inside the shared rebase helpers
// (scripts/lib/git-push-with-retry.sh and scripts/lib/git-commit-data.sh) so
// every concurrent producer gets it. Invoked by git as:
//   node scripts/ci/merge-ai-cache.mjs %O %A %B
// git reads the merged result back from %A (ours); exit 0 = resolved.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  trimAiCacheEntriesToByteBudget,
  resolveAiCacheDiskMaxBytes,
  renderAiCacheDocument,
} from '../lib/ai-cache-budget.mjs';

const [, , basePath, oursPath, theirsPath] = process.argv; // %O %A %B

const AI_CACHE_FILE_VERSION = 1;

/**
 * Read one merge stage into a `key → entry` map. A missing/corrupt/empty side
 * is an empty cache rather than a hard failure: unlike the accumulator stores,
 * losing cache entries costs LLM calls, not data, so surfacing a conflict here
 * would wedge the push-retry loop for no benefit.
 */
function loadEntries(p) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return new Map();
  }
  if (raw.trim() === '') return new Map();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const map = new Map();
  for (const e of list) {
    const key = typeof e?.key === 'string' ? e.key.trim() : '';
    if (!key) continue;
    const touchedAt = Number(e?.touchedAt) || 0;
    const prev = map.get(key);
    if (!prev || touchedAt > prev.touchedAt) map.set(key, { key, touchedAt, value: e?.value });
  }
  return map;
}

const ours = loadEntries(oursPath);
const theirs = loadEntries(theirsPath);
// The ancestor is read only so a same-key disagreement can prefer the side that
// actually moved; it never causes a deletion (see the docblock).
loadEntries(basePath);

const merged = new Map(ours);
for (const [key, entry] of theirs) {
  const prev = merged.get(key);
  if (!prev || entry.touchedAt > prev.touchedAt) merged.set(key, entry);
}

const ordered = [...merged.values()].sort((a, b) => a.touchedAt - b.touchedAt);
const { entries } = trimAiCacheEntriesToByteBudget(ordered, resolveAiCacheDiskMaxBytes());

writeFileSync(
  oursPath,
  renderAiCacheDocument(entries, AI_CACHE_FILE_VERSION, new Date().toISOString()),
);
process.exit(0);
