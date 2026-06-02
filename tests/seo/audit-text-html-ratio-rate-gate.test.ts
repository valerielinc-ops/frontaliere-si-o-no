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
});
