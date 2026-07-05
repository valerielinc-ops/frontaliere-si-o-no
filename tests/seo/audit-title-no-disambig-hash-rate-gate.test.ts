/**
 * audit-title-no-disambig-hash-rate-gate.test.ts
 *
 * Unit coverage for the rate-based offender ratchet in
 * scripts/audit-title-no-disambig-hash.mjs. Mirrors
 * tests/seo/audit-title-length-rate-gate.test.ts's structure — same
 * mode:'rate' baseline shape, same shared `mixAdjustedRateGate.mjs` helper
 * for the total-cap check, same funnel-critical AND-condition
 * `curRate > rateCap && curOff > baseOff + minAbsDelta`.
 *
 * This migration was flagged by PR #3595's reviewer as a funnel-critical
 * sibling (wired via scripts/audit-all.mjs) still on the legacy flat-count
 * ratchet after audit-title-length.mjs/audit-text-html-ratio.mjs were
 * migrated — same organic-growth false-fail class (#3232).
 *
 * Do NOT relax the thresholds to make a failing build pass (AGENTS.md
 * non-negotiable #1). Fix the root cause instead.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditor } from '../../scripts/audit-title-no-disambig-hash.mjs';
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

// Offender: title carries the " (#abcdef12)" disambiguator.
const HASHED = '<html><head><title>Some Job Title (#abcdef12)</title></head><body>x</body></html>';
// Clean title, no hash.
const CLEAN = '<html><head><title>Some Job Title</title></head><body>x</body></html>';

const SPA_FEATURE = 'spa-locale';
const spaPath = (n: number) => join(ROOT, 'dist', 'en', `p${n}`, 'index.html');
const blogPath = (n: number) => join(ROOT, 'dist', 'articoli-frontaliere', `a${n}`, 'index.html');

describe('audit-title-no-disambig-hash — rate-mode ratchet', () => {
  let dir: string;
  let baselinePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-title-no-disambig-hash-'));
    baselinePath = join(dir, 'baseline.json');
    const baseline = {
      generated: new Date().toISOString(),
      mode: 'rate',
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
    const auditor = createAuditor({ baselinePath }) as unknown as Auditor;
    for (let i = 0; i < scanned; i++) {
      const html = i < offenders ? HASHED : CLEAN;
      auditor.collect(spaPath(i), html);
    }
    return auditor.report();
  }

  it('(a) flat rate under proportional organic growth → PASS', async () => {
    const r = await run(400, 20);
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(5, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  it('(b) per-template regression (≈3× rate) → FAIL', async () => {
    const r = await run(100, 15);
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(15, 5);
    expect(r.extra.regressedFeatures.map((f) => f.feature)).toContain(SPA_FEATURE);
    expect(r.passed).toBe(false);
  });

  it('AND-condition guard: rate over cap but sub-minAbsDelta count → PASS', async () => {
    const r = await run(40, 4);
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(10, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });

  it('(c) mix-shift: thin feature grows SHARE of total, own rate flat → PASS', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'audit-title-no-disambig-hash-mix-'));
    const baselinePath2 = join(dir2, 'baseline.json');
    const baseline2 = {
      generated: new Date().toISOString(),
      mode: 'rate',
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
    const auditor = createAuditor({ baselinePath: baselinePath2 }) as unknown as Auditor;
    for (let i = 0; i < 100; i++) auditor.collect(spaPath(i), i < 5 ? HASHED : CLEAN);
    for (let i = 0; i < 400; i++) auditor.collect(blogPath(i), i < 200 ? HASHED : CLEAN);
    const r = await auditor.report();
    expect(r.extra.rateByFeature[SPA_FEATURE]).toBeCloseTo(5, 5);
    expect(r.extra.rateByFeature.blog).toBeCloseTo(50, 5);
    expect(r.extra.regressedFeatures).toHaveLength(0);
    expect(r.passed).toBe(true);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('(d) genuine across-the-board drift still fails the mix-adjusted total cap', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'audit-title-no-disambig-hash-drift-'));
    const baselinePath3 = join(dir3, 'baseline.json');
    const baseline3 = {
      generated: new Date().toISOString(),
      mode: 'rate',
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
    const auditor = createAuditor({ baselinePath: baselinePath3 }) as unknown as Auditor;
    for (let i = 0; i < 100; i++) auditor.collect(spaPath(i), i < 15 ? HASHED : CLEAN);
    for (let i = 0; i < 100; i++) auditor.collect(blogPath(i), i < 15 ? HASHED : CLEAN);
    const r = await auditor.report();
    expect(r.extra.regressedFeatures.length).toBeGreaterThan(0);
    expect(r.passed).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('legacy (non-rate) baseline still supported for backward compat', async () => {
    const dirLegacy = mkdtempSync(join(tmpdir(), 'audit-title-no-disambig-hash-legacy-'));
    const legacyPath = join(dirLegacy, 'baseline.json');
    writeFileSync(legacyPath, JSON.stringify({
      generated: new Date().toISOString(),
      total: 5,
      byFeature: { [SPA_FEATURE]: 5 },
      byLocale: { en: 5 },
    }, null, 2));
    const auditor = createAuditor({ baselinePath: legacyPath }) as unknown as Auditor;
    for (let i = 0; i < 20; i++) auditor.collect(spaPath(i), i < 5 ? HASHED : CLEAN);
    const r = await auditor.report();
    expect(r.passed).toBe(true);
    rmSync(dirLegacy, { recursive: true, force: true });
  });
});
