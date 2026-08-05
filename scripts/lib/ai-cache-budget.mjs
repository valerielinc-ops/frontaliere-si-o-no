/**
 * Byte budget for `data/jobs-ai-cache.json` — the ONE place the cache's size
 * bound lives (AGENTS.md #6).
 *
 * Why a byte budget at all (issue #4248 follow-up)
 * -----------------------------------------------
 * The cache was bounded in the wrong unit. `AI_CACHE_DISK_MAX_ENTRIES` caps it
 * at 30,000 ENTRIES, while GitHub rejects a push — the entire push, every file
 * travelling with it — when any single blob crosses 100 MB, a limit in BYTES.
 * Entry size here spans two orders of magnitude (median 2.0 KB, mean 3.5 KB,
 * max 73.7 KB: a `__RAW__` marker sits next to a four-locale translation with
 * full descriptions), so a count cap cannot bound the file. Measured
 * 2026-08-05: 24,602 entries / 85.5 MB, i.e. the DEFAULT cap already permits
 * ~104 MB, and the env override allows 100,000 entries — about 347 MB.
 *
 * Not hypothetical: the committed blob went 72.93 MB (2026-07-26) → 85.49 MB
 * (2026-08-05), ~1.26 MB/day, so it reaches 100 MB in roughly eleven days. And
 * every crawler commits it through `STANDARD_FILES` in
 * scripts/lib/git-commit-data.sh, so unlike #4248 — which took down one
 * workflow for three weeks — this would take down ~40 at once, all with the
 * same opaque GH001.
 *
 * Why a budget instead of sharding
 * --------------------------------
 * The three other oversize stores were sharded (compat-paths-store #2988,
 * all-known-job-slugs-store and orphan-enriched-store #4248) because they are
 * ACCUMULATORS: nothing can rebuild them, so eviction is permanent data loss
 * and sharding was the only lossless option. This one is a CACHE, and
 * `persistAiCacheToDisk` says so itself — a dropped entry "just costs one extra
 * LLM call next run, not permanent data loss". Sharding a least-recently-used
 * cache would also break its eviction policy: recency is global, so per-shard
 * eviction would drop hot entries from a busy shard while keeping stale ones in
 * a quiet shard, and a byte bound would STILL be needed on top. Bounding the
 * right unit is both smaller and more correct.
 *
 * Why this module is shared
 * -------------------------
 * Two writers must agree on the bound or it does not hold: the crawler
 * (`scripts/lib/shared-jobs-crawler.mjs`, at persist time) and the git merge
 * driver (`scripts/ci/merge-ai-cache.mjs`, when two crawlers' commits are
 * reconciled). The merge unions both sides' entries by key, so a merged file
 * can be larger than either input — a budget enforced only at persist time
 * would be silently re-exceeded by the very merge that follows it.
 */

/** Default ceiling on the SERIALIZED cache file. */
export const AI_CACHE_DISK_MAX_BYTES_DEFAULT = 64 * 1024 * 1024;

/** Smallest budget an override may request — below this the cache stops paying for itself. */
export const AI_CACHE_DISK_MIN_BYTES = 8 * 1024 * 1024;

/**
 * Largest budget an override may request. Deliberately below GitHub's 100 MB:
 * the old entry cap could be raised to a value that permits an unpushable file,
 * and a byte budget that could be raised past the push limit would reintroduce
 * exactly the bug it exists to remove. The clamp is the guarantee, not the
 * default.
 */
export const AI_CACHE_DISK_MAX_BYTES_CEILING = 90 * 1024 * 1024;

/**
 * Resolved at call time (same convention as `resolveAiCachePath`) so tests and
 * one-off runs can drive it via `JOBS_AI_CACHE_DISK_MAX_BYTES` without
 * rebuilding the module. Unset in every prod/CI path → the default.
 */
export function resolveAiCacheDiskMaxBytes(env = process.env) {
  const raw = Number(env.JOBS_AI_CACHE_DISK_MAX_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) return AI_CACHE_DISK_MAX_BYTES_DEFAULT;
  return Math.min(Math.max(raw, AI_CACHE_DISK_MIN_BYTES), AI_CACHE_DISK_MAX_BYTES_CEILING);
}

/**
 * Serialized cost of one entry as rendered INSIDE the cache document.
 *
 * `writeJsonAtomic` pretty-prints at 2-space indent, so an entry sitting in
 * `{ "entries": [ … ] }` is two levels deeper than `JSON.stringify(entry, null,
 * 2)` renders it: every line gains 4 spaces, plus the leading indent and the
 * `,\n` separator. Measuring the rendered form and not the compact one matters
 * — on the real cache pretty-printing is a genuine 5% (81.4 MB compact vs
 * 85.5 MB on disk), so a budget measured on the compact form would be silently
 * over.
 */
export function aiCacheEntryCost(entry) {
  const s = JSON.stringify(entry, null, 2);
  let newlines = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 10) newlines += 1;
  }
  // BYTES, not `s.length`. `String.prototype.length` counts UTF-16 code units,
  // and this cache is job descriptions in German, French and Italian — every
  // `ü`, `é`, `à` is one code unit but two UTF-8 bytes, and git's limit is on
  // bytes. Measured on the real 24,602-entry cache the difference is ~1.7%: a
  // merge verified with `.length` produced a 65.11 MB file against a 64 MB
  // budget and reported itself compliant.
  return Buffer.byteLength(s, 'utf8') + newlines * 4 + 6;
}

/** UTF-8 byte size of the rendered document — the unit git actually enforces. */
export function aiCacheDocumentBytes(entries) {
  return Buffer.byteLength(renderAiCacheDocument(entries), 'utf8');
}

/** The document both writers emit, rendered exactly as it lands on disk. */
export function renderAiCacheDocument(entries, version = 1, savedAt = new Date(0).toISOString()) {
  return `${JSON.stringify({ version, savedAt, entries }, null, 2)}\n`;
}

/**
 * Evict least-recently-used entries until the rendered document fits
 * `budgetBytes`.
 *
 * `entries` must arrive sorted OLDEST FIRST (both callers sort on `touchedAt`),
 * so the newest suffix is kept and the oldest prefix dropped — the same LRU
 * order the in-memory cache uses, applied to the one unit GitHub enforces.
 * Eviction is decided over the whole entry set on ONE global recency ranking;
 * that is exactly the property sharding this file would have destroyed.
 *
 * Deterministic by construction, which is what makes it safe under the ~40
 * crawlers that persist this file concurrently: each re-reads the on-disk
 * snapshot and merges by `touchedAt` before trimming, so two siblings writing
 * in the same minute apply the identical "keep the most recent that fit" rule
 * to the same merged set and converge on the same file instead of fighting.
 *
 * The cost estimate is exact enough to be right first time, but the result is
 * VERIFIED against a real serialization rather than trusted: the whole point of
 * this function is an invariant on the blob that reaches git, and an
 * off-by-a-little estimate would downgrade that invariant to "probably".
 *
 * @param {Array<{key: string, touchedAt: number, value: unknown}>} entries
 * @param {number} budgetBytes
 * @returns {{entries: Array<object>, droppedEntries: number, droppedBytes: number}}
 */
export function trimAiCacheEntriesToByteBudget(entries, budgetBytes) {
  const list = Array.isArray(entries) ? entries : [];
  const unchanged = { entries: list, droppedEntries: 0, droppedBytes: 0 };
  if (list.length === 0 || !Number.isFinite(budgetBytes) || budgetBytes <= 0) return unchanged;

  const costs = list.map(aiCacheEntryCost);
  const totalBytes = costs.reduce((a, b) => a + b, 0);

  const ENVELOPE = 1024; // `{ version, savedAt, entries: [ … ] }` scaffolding
  let firstKept = 0;
  if (totalBytes + ENVELOPE > budgetBytes) {
    let acc = 0;
    firstKept = list.length;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (acc + costs[i] + ENVELOPE > budgetBytes) break;
      acc += costs[i];
      firstKept = i;
    }
  }

  // Verify, and keep shrinking if the estimate was optimistic. Converges in one
  // step in practice; the loop is what turns the estimate into a postcondition.
  let kept = list.slice(firstKept);
  while (kept.length > 0 && aiCacheDocumentBytes(kept) > budgetBytes) {
    firstKept += Math.max(1, Math.ceil(kept.length * 0.02));
    kept = list.slice(firstKept);
  }

  if (firstKept === 0) return unchanged;
  const droppedBytes = costs.slice(0, firstKept).reduce((a, b) => a + b, 0);
  return { entries: kept, droppedEntries: firstKept, droppedBytes };
}
