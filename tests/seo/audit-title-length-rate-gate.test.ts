/**
 * audit-title-length-rate-gate.test.ts
 *
 * Unit coverage for the rate-based offender ratchet in
 * scripts/audit-title-length.mjs. Mirrors
 * tests/seo/audit-text-html-ratio-rate-gate.test.ts's structure — same
 * mode:'rate' baseline shape, same shared `mixAdjustedRateGate.mjs` helper
 * for the total-cap check, same funnel-critical AND-condition
 * `curRate > rateCap && curOff > baseOff + minAbsDelta`.
 *
 * Direct trigger for this migration: spa-locale hit 31 title-length
 * offenders vs a flat legacy cap of 30, purely from organic page-count
 * growth (no per-template quality change) — the exact #1077/#3232-class
 * false-fail the rate ratchet exists to stop.
 *
 * Do NOT relax the thresholds to make a failing build pass (AGENTS.md
 * non-negotiable #1). Fix the root cause instead.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditor } from '../../scripts/audit-title-length.mjs';
import { ROOT } from '../../scripts/lib/audit-runner.mjs';

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

const SHORT_TITLE = '<html><head><title>Short title</title></head><body>x</body></html>';
// 80 chars — well over the default 66-char threshold.
const LONG_TITLE = `<html><head><title>${'x'.repeat(80)}</title></head><body>x</body></html>`;

// spa-locale bucket (classifyFeature → "spa-locale" for /en|de|fr/*, an
// ANCHORED pattern — the locale segment must be the FIRST path segment
// after stripping the "dist/" prefix, so fixtures must live under a real
// ROOT/dist/en/... path rather than a synthetic disconnected root).
const SPA_FEATURE = 'spa-locale';
const spaPath = (n: number) => join(ROOT, 'dist', 'en', `p${n}`, 'index.html');
// Second feature bucket (classifyFeature → "blog") for mixed-feature tests.
const blogPath = (n: number) => join(ROOT, 'dist', 'articoli-frontaliere', `a${n}`, 'index.html');

describe('audit-title-length — rate-mode ratchet', () => {
  let dir: string;
  let baselinePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-title-length-'));
    baselinePath = join(dir, 'baseline.json');
    const baseline = {
      generated: new Date().toISOString(),
      mode: 'rate',
      threshold: 66,
      tolerance: { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 100,
      totalOffenders: 5,
      totalRatePct: 5,
      byFeature: {
        [SPA_FEATURE]: { scanned: 100, offenders: 5, ratePct: 5 },
      },
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  function run(scanned: number, offenders: number): Promise<AuditReport> {
    const auditor = createAuditor({ threshold: 66, baselinePath }) as unknown as Auditor;
    for (let i = 0; i < scanned; i++) {
      const html = i < offenders ? LONG_TITLE : SHORT_TITLE;
      auditor.collect(spaPath(i), html);
    }
    return auditor.report();
  }

  it('(a) flat rate under proportional organic growth → PASS (the spa-locale 31-vs-cap-30 false-fail)', async () => {
    // 4× the pages, same 5 % offender rate → 20 offenders. Absolute count
    // jumps +15 but the RATE is flat, so the gate must NOT fire.
    const r = await run(400, 20);
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(5, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  it('(b) per-template regression (≈3× thin rate) → FAIL', async () => {
    // Same 100-page shard, template regression triples the offender rate to
    // 15 %, exceeding the per-feature cap (5 + min(1,3) + 1 = 7 %) AND the
    // absolute count grows past minAbsDelta (15 > 5 + 5 = 10).
    const r = await run(100, 15);
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(15, 5);
    expect(r.extra.regressedFeatures.map((f) => f.feature)).toContain(SPA_FEATURE);
    expect(r.passed).toBe(false);
  });

  it('AND-condition guard: rate over cap but sub-minAbsDelta count → PASS', async () => {
    // 4 offenders / 40 pages = 10 % (over the 7 % cap) but absolute count
    // (4) does not clear baseOff + minAbsDelta (5 + 5 = 10) → must pass.
    const r = await run(40, 4);
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(10, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  it('(c) mix-shift: thin feature grows SHARE of total, own rate flat → PASS', async () => {
    // A second feature ("blog", baselined at 50 % offender rate) grows from
    // a small slice of the corpus to a much larger one. Its OWN rate holds
    // exactly at baseline (no per-feature regression) but the corpus-wide
    // blended rate mechanically rises purely from its growing share. A
    // static baseline-blended total-rate comparison would false-fail this;
    // the mix-adjusted comparison must not.
    const dir2 = mkdtempSync(join(tmpdir(), 'audit-title-length-mix-'));
    const baselinePath2 = join(dir2, 'baseline.json');
    const baseline2 = {
      generated: new Date().toISOString(),
      mode: 'rate',
      threshold: 66,
      tolerance: { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 200,
      totalOffenders: 55,
      totalRatePct: 27.5,
      byFeature: {
        [SPA_FEATURE]: { scanned: 100, offenders: 5, ratePct: 5 },
        blog: { scanned: 100, offenders: 50, ratePct: 50 },
      },
    };
    writeFileSync(baselinePath2, JSON.stringify(baseline2, null, 2));
    const auditor = createAuditor({ threshold: 66, baselinePath: baselinePath2 }) as unknown as Auditor;
    for (let i = 0; i < 100; i++) auditor.collect(spaPath(i), i < 5 ? LONG_TITLE : SHORT_TITLE);
    // blog grows 4x (100 → 400 pages), rate held exactly at baseline 50 %.
    for (let i = 0; i < 400; i++) auditor.collect(blogPath(i), i < 200 ? LONG_TITLE : SHORT_TITLE);
    const r = await auditor.report();
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(5, 5);
    expect(r.extra.rateByFeature.blog).toBeCloseTo(50, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('(d) genuine across-the-board drift still fails the mix-adjusted total cap', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'audit-title-length-drift-'));
    const baselinePath3 = join(dir3, 'baseline.json');
    const baseline3 = {
      generated: new Date().toISOString(),
      mode: 'rate',
      threshold: 66,
      tolerance: { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 200,
      totalOffenders: 10,
      totalRatePct: 5,
      byFeature: {
        [SPA_FEATURE]: { scanned: 100, offenders: 5, ratePct: 5 },
        blog: { scanned: 100, offenders: 5, ratePct: 5 },
      },
    };
    writeFileSync(baselinePath3, JSON.stringify(baseline3, null, 2));
    const auditor = createAuditor({ threshold: 66, baselinePath: baselinePath3 }) as unknown as Auditor;
    // Both features: rate roughly triples (5 % → ~15 %), each individually
    // over its own per-feature cap with enough absolute growth to clear
    // minAbsDelta too.
    for (let i = 0; i < 100; i++) auditor.collect(spaPath(i), i < 15 ? LONG_TITLE : SHORT_TITLE);
    for (let i = 0; i < 100; i++) auditor.collect(blogPath(i), i < 15 ? LONG_TITLE : SHORT_TITLE);
    const r = await auditor.report();
    expect(r.extra.regressedFeatures.length).toBeGreaterThan(0);
    expect(r.passed).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('legacy (non-rate) baseline still supported for backward compat', async () => {
    const dirLegacy = mkdtempSync(join(tmpdir(), 'audit-title-length-legacy-'));
    const legacyPath = join(dirLegacy, 'baseline.json');
    writeFileSync(legacyPath, JSON.stringify({
      generated: new Date().toISOString(),
      threshold: 66,
      total: 5,
      byFeature: { [SPA_FEATURE]: 5 },
      byLocale: { en: 5 },
    }, null, 2));
    const auditor = createAuditor({ threshold: 66, baselinePath: legacyPath }) as unknown as Auditor;
    // Flat-count legacy ratchet: same count as baseline → pass.
    for (let i = 0; i < 20; i++) auditor.collect(spaPath(i), i < 5 ? LONG_TITLE : SHORT_TITLE);
    const r = await auditor.report();
    expect(r.passed).toBe(true);
    rmSync(dirLegacy, { recursive: true, force: true });
  });
});
