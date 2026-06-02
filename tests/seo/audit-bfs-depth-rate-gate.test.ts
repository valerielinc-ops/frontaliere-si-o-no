/**
 * audit-bfs-depth-rate-gate.test.ts
 *
 * Unit coverage for the rate-based BFS-depth ratchet introduced in PR #1085
 * and the new-shard hard-fail added for issue #1095. The gating decision lives
 * in the pure, exported `evaluateBfsGate` (scripts/audit-bfs-depth.mjs) so it
 * can be exercised without crawling a live dist.
 *
 * The gate is funnel-critical: it is the primary defence against false-fails
 * from organic URL growth (churn category #1077) while still catching a real
 * internal-link regression that buries previously-shallow URLs (orphan from
 * Ahrefs/Googlebot → zero organic traffic). A future edit that weakens it —
 * flipping the AND (`&&`) to OR, dropping `minAbsDelta`, or removing the
 * new-shard hard-fail — MUST break one of these tests.
 *
 * Do NOT relax the asserted thresholds to make a failing build pass
 * (AGENTS.md non-negotiable #1). Fix the gate's root cause instead.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateBfsGate,
  DEFAULT_BFS_TOL,
  NEW_SHARD_BURIED_RATE_FAIL,
} from '../../scripts/audit-bfs-depth.mjs';

type SitemapRow = { total: number; atDepthGtMax: number; deepest: number };

const evaluate = evaluateBfsGate as (args: {
  perSitemap: Record<string, SitemapRow>;
  baseline: unknown;
  tol?: Record<string, number>;
}) => {
  regressions: Array<{ name: string; prev: number; current: number; curRate?: number; rateCap?: number }>;
  unbaselined: Array<{ name: string; atDepthGtMax: number; ratePct: number }>;
  buriedNewShards: Array<{ name: string; atDepthGtMax: number; total: number; ratePct: number }>;
};

const TOL = DEFAULT_BFS_TOL as { relPct: number; absPp: number; minAbsDelta: number; maxDeltaPp: number };

/** Build a rate-mode baseline (v2) from a per-sitemap snapshot. */
function rateBaseline(perSitemap: Record<string, SitemapRow>): unknown {
  const out: Record<string, { total: number; atDepthGtMax: number; ratePct: number }> = {};
  for (const [name, row] of Object.entries(perSitemap)) {
    out[name] = {
      total: row.total,
      atDepthGtMax: row.atDepthGtMax,
      ratePct: row.total ? Number((row.atDepthGtMax / row.total * 100).toFixed(4)) : 0,
    };
  }
  return { version: 2, mode: 'rate', maxDepth: 4, tolerance: TOL, perSitemap: out };
}

const row = (total: number, atDepthGtMax: number, deepest = 6): SitemapRow => ({ total, atDepthGtMax, deepest });

describe('evaluateBfsGate — rate-mode ratchet (#1085)', () => {
  it('(a) flat rate under proportional organic growth → PASS', () => {
    // Baseline: 100 URLs, 5 buried (5%). The shard 4× in size (organic growth)
    // with the SAME 5% buried rate → 20 buried. Absolute count jumps +15 but the
    // RATE is flat, so the gate must NOT fire (this is the #1077 false-fail it
    // was built to stop).
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(100, 5) });
    const { regressions } = evaluate({
      perSitemap: { 'sitemap-jobs.xml': row(400, 20) },
      baseline,
    });
    expect(regressions).toHaveLength(0);
  });

  it('(b) per-template regression (≈2.4× thin rate) → FAIL', () => {
    // Baseline 5% buried (rateCap = 5 + min(5*.15, 8) + 5 = 10.75%). A real
    // internal-link regression buries 12% on a same-size shard. Rate exceeds the
    // cap AND absolute count grows by more than minAbsDelta (120 > 50+20) →
    // must FAIL.
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(1000, 50) });
    const { regressions } = evaluate({
      perSitemap: { 'sitemap-jobs.xml': row(1000, 120) },
      baseline,
    });
    expect(regressions).toHaveLength(1);
    expect(regressions[0].name).toBe('sitemap-jobs.xml');
    expect(regressions[0].current).toBe(120);
  });

  it('(c) absolute noise (+ a few offenders, rate ~unchanged) → PASS', () => {
    // Baseline 5% buried on 1000 URLs. +minAbsDelta worth of absolute noise but
    // the rate barely moves (stays within tolerance) → the absolute-delta arm of
    // the AND-condition is not enough on its own; gate must NOT fire.
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(1000, 50) });
    const { regressions } = evaluate({
      perSitemap: { 'sitemap-jobs.xml': row(1000, 52) },
      baseline,
    });
    expect(regressions).toHaveLength(0);
  });

  it('AND-condition guard: a rate spike with a sub-minAbsDelta count bump does NOT fail', () => {
    // Tiny shard: rate doubles (high relative) but only +3 absolute offenders,
    // below minAbsDelta. The `&&` (not `||`) means BOTH arms must trip. If a
    // future edit flips `&&`→`||`, this rate-only spike would wrongly FAIL and
    // break this test.
    const baseline = rateBaseline({ 'sitemap-tiny.xml': row(40, 2) });
    const { regressions } = evaluate({
      perSitemap: { 'sitemap-tiny.xml': row(40, 5) },
      baseline,
    });
    expect(regressions).toHaveLength(0);
  });

  it('minAbsDelta guard: rate clearly over cap but count delta == minAbsDelta does NOT fail', () => {
    // Baseline 1/100 = 1% (rateCap = 1 + min(1*.15, 8) + 5 = 6.15%). New rate
    // jumps to 21% (clearly over cap → the RATE arm of the AND trips), but the
    // count grows by exactly minAbsDelta (not strictly more) so the COUNT arm
    // does NOT. The `> baseOff + minAbsDelta` guard keeps it green. If a future
    // edit drops that arm, this rate spike would wrongly FAIL and break the test.
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(100, 1) });
    const atExactlyDelta = 1 + TOL.minAbsDelta; // count delta == minAbsDelta (21)
    const { regressions } = evaluate({
      perSitemap: { 'sitemap-jobs.xml': row(100, atExactlyDelta) },
      baseline,
    });
    expect(regressions).toHaveLength(0);
  });

  it('legacy absolute-count baseline (v1) fails on any growth', () => {
    // mode/version absent → isRate false → any atDepthGtMax > prev fails.
    const baseline = { maxDepth: 4, perSitemap: { 'sitemap-jobs.xml': { atDepthGtMax: 5, total: 100 } } };
    const { regressions } = evaluate({
      perSitemap: { 'sitemap-jobs.xml': row(400, 6) },
      baseline,
    });
    expect(regressions).toHaveLength(1);
  });
});

describe('evaluateBfsGate — new non-baseline shard (#1095 item 2)', () => {
  it('100% buried new tier over minAbsDelta URLs → hard-fail (buriedNewShards)', () => {
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(100, 0) });
    const buriedCount = NEW_SHARD_BURIED_RATE_FAIL; // ≥ minAbsDelta and 100% buried
    const { buriedNewShards, unbaselined, regressions } = evaluate({
      perSitemap: { 'sitemap-new-tier.xml': row(buriedCount, buriedCount) },
      baseline,
    });
    expect(regressions).toHaveLength(0);
    expect(unbaselined.map((u) => u.name)).toContain('sitemap-new-tier.xml');
    expect(buriedNewShards).toHaveLength(1);
    expect(buriedNewShards[0].name).toBe('sitemap-new-tier.xml');
    expect(buriedNewShards[0].ratePct).toBe(100);
  });

  it('small new tier (< minAbsDelta buried URLs) only WARNs, never hard-fails', () => {
    // A legit new tier with a shallow hub path may have a handful of deep URLs;
    // we must NOT false-fail it. Below minAbsDelta → warning only.
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(100, 0) });
    const tiny = TOL.minAbsDelta - 1;
    const { buriedNewShards, unbaselined } = evaluate({
      perSitemap: { 'sitemap-small-tier.xml': row(tiny, tiny) },
      baseline,
    });
    expect(buriedNewShards).toHaveLength(0);
    expect(unbaselined.map((u) => u.name)).toContain('sitemap-small-tier.xml');
  });

  it('partly-buried new tier below the rate threshold only WARNs, never hard-fails', () => {
    // Large new shard but only ~50% buried (below NEW_SHARD_BURIED_RATE_FAIL).
    // Not "an entire tier below crawl depth" → warning, not a hard-fail.
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(100, 0) });
    const { buriedNewShards, unbaselined } = evaluate({
      perSitemap: { 'sitemap-half.xml': row(200, 100) },
      baseline,
    });
    expect(buriedNewShards).toHaveLength(0);
    expect(unbaselined.find((u) => u.name === 'sitemap-half.xml')?.ratePct).toBe(50);
  });

  it('fully-reachable new tier produces no warning and no hard-fail', () => {
    const baseline = rateBaseline({ 'sitemap-jobs.xml': row(100, 0) });
    const { buriedNewShards, unbaselined } = evaluate({
      perSitemap: { 'sitemap-clean.xml': row(500, 0) },
      baseline,
    });
    expect(buriedNewShards).toHaveLength(0);
    expect(unbaselined).toHaveLength(0);
  });
});
