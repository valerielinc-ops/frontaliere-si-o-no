/**
 * Longest-Processing-Time (LPT) shard partitioner.
 *
 * Used by the custom vitest `sequence.sequencer` (see vitest.config.ts) to
 * split the test suite across `--shard=i/N` runners by *estimated duration*
 * instead of vitest's default sha1-of-path hash. The hash split is balanced by
 * file COUNT, not time, so a shard that happens to collect two of the heavy
 * synchronous source-scan guards (no-inlanguage-on-forbidden-schemas,
 * blog-body-typescript-syntax, …) becomes the long pole and pins the gate wall.
 * LPT spreads the heaviest files across distinct bins, equalising per-shard
 * wall and lowering the slowest-shard (= gate) time.
 *
 * Correctness invariant: every item lands in exactly one bin, so the union of
 * all N shards is the full file set with no overlap and no gap — vitest still
 * runs every file exactly once (tests/lpt-shard.test.ts proves this). The
 * partition is deterministic (sort by weight desc, path asc tiebreak; assign
 * to the lowest-index least-loaded bin) so each of the N independent
 * `vitest run --shard=i/N` processes computes an identical, disjoint cover.
 */

/**
 * Partition `items` into `count` weight-balanced bins via greedy LPT.
 * @template T
 * @param {readonly T[]} items
 * @param {{ count: number, weightOf: (item: T) => number, keyOf: (item: T) => string }} opts
 * @returns {{ load: number, items: T[] }[]} bins, index 0..count-1
 */
export function lptBins(items, { count, weightOf, keyOf }) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`lptBins: count must be a positive integer, got ${count}`);
  }
  const sorted = [...items].sort((a, b) => {
    const wb = weightOf(b);
    const wa = weightOf(a);
    if (wb !== wa) return wb - wa; // heaviest first
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0; // deterministic tiebreak
  });
  const bins = Array.from({ length: count }, () => ({ load: 0, items: [] }));
  for (const item of sorted) {
    // Lowest-index least-loaded bin (deterministic).
    let min = 0;
    for (let i = 1; i < count; i++) {
      if (bins[i].load < bins[min].load) min = i;
    }
    bins[min].items.push(item);
    bins[min].load += weightOf(item);
  }
  return bins;
}

/**
 * Return the items assigned to a single shard (1-based `index` of `count`).
 * @template T
 * @param {readonly T[]} items
 * @param {{ index: number, count: number, weightOf: (item: T) => number, keyOf: (item: T) => string }} opts
 * @returns {T[]}
 */
export function shardItems(items, { index, count, weightOf, keyOf }) {
  if (!Number.isInteger(index) || index < 1 || index > count) {
    throw new Error(`shardItems: index must be 1..${count}, got ${index}`);
  }
  return lptBins(items, { count, weightOf, keyOf })[index - 1].items;
}
