/**
 * audit-text-html-ratio-rate-gate.test.ts
 *
 * Unit coverage for the rate-based offender ratchet in
 * scripts/audit-text-html-ratio.mjs (PR #1085). The existing tests exercise
 * the per-page threshold / offender-detection path; this file drives the
 * `mode:'rate'` baseline comparison — the funnel-critical AND-condition
 * `curRate > rateCap && curOff > baseOff + minAbsDelta`.
 *
 * The gate is the primary defence against false-fails from organic content
 * growth (more pages of the same template, same per-page quality → flat rate)
 * while still catching a genuine per-template quality regression (the offender
 * RATE rising). A future edit that weakens it — flipping `&&`→`||` or dropping
 * `minAbsDelta` — MUST break one of these tests.
 *
 * Do NOT relax the thresholds to make a failing build pass (AGENTS.md
 * non-negotiable #1). Fix the root cause instead.
 *
 * The auditor is driven directly via `createAuditor` + an on-disk baseline
 * file; no live dist crawl. Feature classification is path-driven, so the
 * fixtures use `cerca-lavoro-ticino/...` (→ feature "job-board") paths and
 * craft HTML with a known visible-text-to-HTML ratio.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditor } from '../../scripts/audit-text-html-ratio.mjs';

interface AuditReport {
  passed: boolean;
  offendersTotal: number;
  baselineDelta: { before: number; after: number; beforeRate?: number; afterRate?: number } | null;
  extra: {
    regressedFeatures: Array<{ feature: string; count: number; rate?: number; maxRate?: number }>;
    rateByFeature: Record<string, number>;
  };
}

type Auditor = {
  collect: (file: string, html: string) => void;
  report: () => Promise<AuditReport>;
};

// An OFFENDER page: tag-heavy, almost no visible text → ratio well under the
// 10 % hard floor (empirically ~0.4 %).
const THIN = `<html><body><div class="x">${'<span></span>'.repeat(40)}t</div></body></html>`;
// A HEALTHY page: lots of visible prose → ratio ~98 %, never an offender.
const FAT = `<html><body><p>${'word '.repeat(120)}</p></body></html>`;

// All fixtures live under cerca-lavoro-ticino/* so classifyFeature() buckets
// them as the single feature "job-board".
const FEATURE = 'job-board';
const jobPath = (root: string, n: number) => join(root, 'cerca-lavoro-ticino', `p${n}`, 'index.html');
// A second feature bucket (classifyFeature → "blog") for the mixed-feature
// denominator test below.
const blogPath = (root: string, n: number) => join(root, 'articoli-frontaliere', `a${n}`, 'index.html');

describe('audit-text-html-ratio — rate-mode ratchet (#1085)', () => {
  let dir: string;
  let baselinePath: string;

  // Write a rate baseline: feature "job-board" at 5 % offender rate
  // (5 offenders / 100 scanned), total 5 % as well.
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-text-ratio-'));
    baselinePath = join(dir, 'baseline.json');
    const baseline = {
      generated: new Date().toISOString(),
      mode: 'rate',
      threshold: 10,
      tolerance: { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 100,
      totalOffenders: 5,
      totalRatePct: 5,
      byFeature: {
        [FEATURE]: { scanned: 100, offenders: 5, ratePct: 5 },
      },
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Feed `scanned` synthetic job-board pages, `offenders` of them thin. */
  function run(scanned: number, offenders: number): Promise<AuditReport> {
    const auditor = createAuditor({ threshold: 10, baselinePath }) as unknown as Auditor;
    for (let i = 0; i < scanned; i++) {
      const html = i < offenders ? THIN : FAT;
      auditor.collect(jobPath('/dist', i), html);
    }
    return auditor.report();
  }

  it('(a) flat rate under proportional organic growth → PASS', async () => {
    // 4× the pages, same 5 % offender rate → 20 offenders. Absolute count jumps
    // +15 but the RATE is flat, so the gate must NOT fire (the #1077 false-fail
    // it was built to stop).
    const r = await run(400, 20);
    expect(r.extra.rateByFeature[FEATURE]).toBeCloseTo(5, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  it('(b) per-template regression (≈3× thin rate) → FAIL', async () => {
    // Same 100-page shard, but a template regression triples the offender rate
    // to 15 %. Rate exceeds the feature cap baseRate + min(baseRate*relPct/100,
    // maxDeltaPp) + absPp = 5 + min(1, 3) + 1 = 7 % AND the absolute count grows
    // by more than minAbsDelta (15 > 5 + 5 = 10) → must FAIL.
    const r = await run(100, 15);
    expect(r.extra.rateByFeature[FEATURE]).toBeCloseTo(15, 5);
    expect(r.extra.regressedFeatures.map((f) => f.feature)).toContain(FEATURE);
    expect(r.passed).toBe(false);
  });

  it('(c) absolute noise (+2 offenders, rate ~unchanged) → PASS', async () => {
    // Grow the shard so +2 offenders barely moves the rate: 7 offenders / 140
    // pages = 5 % (flat). Absolute count up by 2 but rate within tolerance →
    // gate must NOT fire.
    const r = await run(140, 7);
    expect(r.extra.rateByFeature[FEATURE]).toBeCloseTo(5, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  it('AND-condition guard: high relative rate spike but sub-minAbsDelta count does NOT fail', async () => {
    // Tiny shard: 4 offenders / 40 pages = 10 % (rate over the 7 % cap) but only
    // +(4-? ) — absolute offender count is 4, baseline 5, so the count arm
    // (curOff > baseOff + minAbsDelta = 5 + 5 = 10) is false. The `&&` (not `||`)
    // keeps it green. If a future edit flips `&&`→`||`, this rate-only spike
    // would wrongly FAIL and break the test.
    const r = await run(40, 4);
    expect(r.extra.rateByFeature[FEATURE]).toBeCloseTo(10, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  it('(d) mix-shift: thin feature grows SHARE of total, own rate flat/improved → PASS (#3232)', async () => {
    // Recurrence of #3232: a second feature ("blog", baselined at 50 %
    // offender rate) grows from a small slice of the corpus to a much
    // larger one. Its OWN rate holds exactly at baseline (50 %, no
    // per-feature regression) but the corpus-wide blended rate mechanically
    // rises because "blog" now makes up more of the total. A static
    // baseline-blended total-rate comparison would false-fail this; the
    // mix-adjusted comparison must not.
    const dir2 = mkdtempSync(join(tmpdir(), 'audit-text-ratio-mix-'));
    const baselinePath2 = join(dir2, 'baseline.json');
    const baseline2 = {
      generated: new Date().toISOString(),
      mode: 'rate',
      threshold: 10,
      tolerance: { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 200,
      totalOffenders: 55,
      totalRatePct: 27.5, // blended: (5/100 job-board + 50/100 blog) / 200
      byFeature: {
        [FEATURE]: { scanned: 100, offenders: 5, ratePct: 5 },
        blog: { scanned: 100, offenders: 50, ratePct: 50 },
      },
    };
    writeFileSync(baselinePath2, JSON.stringify(baseline2, null, 2));
    const auditor = createAuditor({ threshold: 10, baselinePath: baselinePath2 }) as unknown as Auditor;
    // job-board: 100 pages, same 5 % rate as baseline (flat, no growth).
    for (let i = 0; i < 100; i++) auditor.collect(jobPath('/dist', i), i < 5 ? THIN : FAT);
    // blog: grows 4x (100 → 400 pages), rate held exactly at baseline 50 %.
    for (let i = 0; i < 400; i++) auditor.collect(blogPath('/dist', i), i < 200 ? THIN : FAT);
    const r = await auditor.report();
    expect(r.extra.rateByFeature[FEATURE]).toBeCloseTo(5, 5);
    expect(r.extra.rateByFeature.blog).toBeCloseTo(50, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    // Blended total rate DID rise vs the static baseline blend (27.5 % →
    // ~41 %) purely from blog's growing share — but nothing regressed.
    expect(r.passed).toBe(true);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('(e) genuine across-the-board drift still fails the mix-adjusted total cap', async () => {
    // Every feature's rate rises just enough to stay under each one's OWN
    // per-feature cap (rate + tol), but the aggregate creep across all
    // features is real — the mix-adjusted total must still catch it since
    // it's anchored to baseline PER-FEATURE rates, not a flat blend.
    const dir3 = mkdtempSync(join(tmpdir(), 'audit-text-ratio-drift-'));
    const baselinePath3 = join(dir3, 'baseline.json');
    const baseline3 = {
      generated: new Date().toISOString(),
      mode: 'rate',
      threshold: 10,
      tolerance: { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 200,
      totalOffenders: 10,
      totalRatePct: 5,
      byFeature: {
        [FEATURE]: { scanned: 100, offenders: 5, ratePct: 5 },
        blog: { scanned: 100, offenders: 5, ratePct: 5 },
      },
    };
    writeFileSync(baselinePath3, JSON.stringify(baseline3, null, 2));
    const auditor = createAuditor({ threshold: 10, baselinePath: baselinePath3 }) as unknown as Auditor;
    // Both features: rate roughly triples (5 % → ~15 %), each individually
    // over its own per-feature cap (5 + min(1,3) + 1 = 7 %) with enough
    // absolute growth to clear minAbsDelta too.
    for (let i = 0; i < 100; i++) auditor.collect(jobPath('/dist', i), i < 15 ? THIN : FAT);
    for (let i = 0; i < 100; i++) auditor.collect(blogPath('/dist', i), i < 15 ? THIN : FAT);
    const r = await auditor.report();
    expect(r.extra.regressedFeatures.length).toBeGreaterThan(0);
    expect(r.passed).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('rate denominator is PER-FEATURE scanned, not global samples (#1143 item 1)', async () => {
    // Adversarial concern from #1138 review: if `scanned` (the rate denominator)
    // counted ALL collected pages instead of only same-feature pages, the
    // asserted per-feature rates above would be wrong. Every other fixture here
    // feeds a single feature, so they pass whether the denominator is per-feature
    // OR global — they cannot discriminate the two. This mixed-feature dist does:
    // 5 thin job-board pages / 100 job-board scanned = 5 % (per-feature), which is
    // NOT 5 / (100 + 200) = 1.67 % (global). Pins production's per-feature
    // `scannedByFeature[f]` divisor so a refactor to `samples.length` breaks here.
    const auditor = createAuditor({ threshold: 10, baselinePath }) as unknown as Auditor;
    for (let i = 0; i < 100; i++) auditor.collect(jobPath('/dist', i), i < 5 ? THIN : FAT);
    for (let i = 0; i < 200; i++) auditor.collect(blogPath('/dist', i), FAT);
    const r = await auditor.report();
    expect(r.extra.rateByFeature[FEATURE]).toBeCloseTo(5, 5); // 5/100, not 5/300
    expect(r.extra.rateByFeature.blog).toBeCloseTo(0, 5);
    expect(r.passed).toBe(true);
  });
});
