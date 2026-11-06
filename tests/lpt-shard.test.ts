/**
 * Guards the LPT shard partitioner that vitest.config.ts's BalancedSequencer
 * uses to split `--shard=i/N`. The critical invariant is a DISJOINT COVER:
 * every test file lands in exactly one shard, so the union of all N shards is
 * the full suite with no overlap and no gap. If this broke, vitest would
 * silently skip files (a test never runs → false-green gate) or double-run
 * them — so this guard is itself part of the safety story for replacing
 * vitest's default hash split.
 */
import { describe, it, expect } from 'vitest';
import { lptBins, shardItems } from '../scripts/ci/lpt-shard.mjs';

interface Item {
  k: string;
  w: number;
}

// A spread of weights incl. a few heavy outliers (mirrors the real suite: a
// long tail of ~1s files + a handful of 14-60s source-scan guards).
const items: Item[] = Array.from({ length: 503 }, (_, i) => ({
  k: `tests/file-${String(i).padStart(3, '0')}.test.ts`,
  w: i % 97 === 0 ? 40_000 : (i % 11) * 200 + 100,
}));
const opts = {
  count: 8,
  keyOf: (x: Item) => x.k,
  weightOf: (x: Item) => x.w,
};

describe('LPT shard partition', () => {
  it('is a disjoint cover — every item in exactly one shard, union = all', () => {
    const seen = new Map<string, number>();
    for (let index = 1; index <= opts.count; index++) {
      for (const it of shardItems(items, { ...opts, index })) {
        seen.set(it.k, (seen.get(it.k) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(items.length);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it('balances bins: slowest bin <= average + heaviest single item (LPT bound)', () => {
    const bins = lptBins(items, opts);
    const loads = bins.map((b) => b.load);
    const total = loads.reduce((s, x) => s + x, 0);
    const avg = total / opts.count;
    const heaviest = Math.max(...items.map(opts.weightOf));
    // Standard greedy-LPT guarantee: the bin that ends up heaviest was the
    // least-loaded (<= avg) right before its final item was placed.
    expect(Math.max(...loads)).toBeLessThanOrEqual(avg + heaviest);
  });

  it('beats a naive count-balanced split on imbalance', () => {
    const lpt = lptBins(items, opts).map((b) => b.load);
    // Naive: round-robin by original order (count-balanced, weight-blind).
    const naive = Array.from({ length: opts.count }, () => 0);
    items.forEach((it, i) => {
      naive[i % opts.count] += it.w;
    });
    const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
    expect(spread(lpt)).toBeLessThan(spread(naive));
  });

  it('is deterministic across repeated calls (same input → same partition)', () => {
    const a = shardItems(items, { ...opts, index: 3 }).map((x) => x.k);
    const b = shardItems(items, { ...opts, index: 3 }).map((x) => x.k);
    expect(a).toEqual(b);
  });

  it('rejects out-of-range shard index', () => {
    expect(() => shardItems(items, { ...opts, index: 9 })).toThrow();
    expect(() => shardItems(items, { ...opts, index: 0 })).toThrow();
  });
});
