/**
 * audit-dist-multi-rate-gate.test.ts
 *
 * Unit coverage for issue #3596: scripts/audit-dist-multi.mjs's runRatio()
 * and runTitle() independently reimplement the text-html-ratio /
 * title-length baseline-ratchet comparison inline instead of delegating to
 * scripts/audit-text-html-ratio.mjs / scripts/audit-title-length.mjs's own
 * createAuditor().report(). Both reimplementations were hardcoded to the old
 * flat-count baseline shape (`baseline.total`, `baseline.byFeature[feat]` as
 * a plain number) with no `mode:'rate'` branch, even though both
 * data/text-html-ratio-baseline.json and data/title-length-baseline.json
 * are already in `mode:'rate'` shape:
 *
 *   - runRatio(): `baseTotal = Number(baseline.total ?? 0)` evaluated to 0
 *     for a rate-mode baseline (no `total` key) → totalRegression fired
 *     almost unconditionally (any offenders > 0).
 *   - runTitle(): `count > cap` where `cap` is baseline.byFeature[feat]
 *     (an object in rate mode, not a number) coerces to NaN → the
 *     comparison was always false → the per-feature regression check
 *     silently stopped firing, permanently.
 *
 * Mirrors tests/seo/audit-text-html-ratio-rate-gate.test.ts and
 * tests/seo/audit-title-length-rate-gate.test.ts's fixtures/structure —
 * same mode:'rate' baseline shape, same shared `mixAdjustedRateGate.mjs`
 * helper for the total-cap check, same funnel-critical AND-condition
 * `curRate > rateCap && curOff > baseOff + minAbsDelta`.
 *
 * H1Audit/runH1() (mirroring scripts/audit-h1-title-duplicates.mjs) carries
 * the identical sibling bug (AGENTS.md non-negotiable #6): in rate mode
 * `baseline.byFeature[feat]` is an object, so `count > cap` coerced to
 * `count > NaN` (always false) — the per-feature regression check silently
 * stopped firing. Covered below alongside runRatio()/runTitle().
 *
 * Do NOT relax the thresholds to make a failing build pass (AGENTS.md
 * non-negotiable #1). Fix the root cause instead.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RatioAudit, TitleAudit, H1Audit, runRatio, runTitle, runH1 } from '../../scripts/audit-dist-multi.mjs';

// An OFFENDER page: tag-heavy, almost no visible text → ratio well under the
// 10 % hard floor (empirically ~0.4 %).
const THIN = `<html><body><div class="x">${'<span></span>'.repeat(40)}t</div></body></html>`;
// A HEALTHY page: lots of visible prose → ratio ~98 %, never an offender.
const FAT = `<html><body><p>${'word '.repeat(120)}</p></body></html>`;
const SHORT_TITLE = '<html><head><title>Short title</title></head><body>x</body></html>';
const LONG_TITLE = `<html><head><title>${'x'.repeat(80)}</title></head><body>x</body></html>`;

// classifyFeature() buckets this path as "job-board" (shared with the two
// originals' own rate-gate test fixtures).
const jobPath = (n: number) => join('dist', 'cerca-lavoro-ticino', `p${n}`, 'index.html');

describe('audit-dist-multi runRatio() — rate-mode ratchet (#3596)', () => {
  let dir: string;
  let baselinePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-dist-multi-ratio-'));
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
        'job-board': { scanned: 100, offenders: 5, ratePct: 5 },
      },
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(scanned: number, offenders: number) {
    const audit = new RatioAudit();
    for (let i = 0; i < scanned; i++) {
      const html = i < offenders ? THIN : FAT;
      const bytes = Buffer.byteLength(html, 'utf8');
      audit.ingest(jobPath(i), html, bytes, jobPath(i));
    }
    return runRatio(audit, baselinePath);
  }

  it('reproduces the pre-fix bug: rate-mode baseline must NOT be read as baseTotal=0', async () => {
    // Before the fix, `Number(baseline.total ?? 0)` was 0 for this
    // rate-mode baseline (no `total` key) so ANY offenders failed the gate
    // unconditionally — even flat organic growth at the exact baselined
    // rate. This is the core repro for #3596's runRatio() half.
    const r = await run(100, 5);
    expect(r.passed).toBe(true);
  });

  it('flat rate under proportional organic growth → PASS', async () => {
    // 4x the pages, same 5 % offender rate -> 20 offenders. Absolute count
    // jumps +15 but the RATE is flat, so the gate must NOT fire.
    const r = await run(400, 20);
    expect(r.passed).toBe(true);
  });

  it('per-template regression (~3x thin rate) -> FAIL', async () => {
    // Rate triples to 15 %, exceeding the feature cap (5 + min(1,3) + 1 = 7 %)
    // AND the absolute count grows past minAbsDelta (15 > 5 + 5 = 10).
    const r = await run(100, 15);
    expect(r.passed).toBe(false);
  });

  it('legacy (non-rate) baseline still supported for backward compat', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'audit-dist-multi-ratio-legacy-'));
    const legacyPath = join(legacyDir, 'baseline.json');
    writeFileSync(legacyPath, JSON.stringify({
      generated: new Date().toISOString(),
      threshold: 10,
      total: 5,
      byFeature: { 'job-board': 5 },
    }, null, 2));
    const audit = new RatioAudit();
    for (let i = 0; i < 100; i++) {
      const html = i < 5 ? THIN : FAT;
      const bytes = Buffer.byteLength(html, 'utf8');
      audit.ingest(jobPath(i), html, bytes, jobPath(i));
    }
    const r = await runRatio(audit, legacyPath);
    expect(r.passed).toBe(true);
    rmSync(legacyDir, { recursive: true, force: true });
  });
});

describe('audit-dist-multi runTitle() — rate-mode ratchet (#3596)', () => {
  let dir: string;
  let baselinePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-dist-multi-title-'));
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
        'job-board': { scanned: 100, offenders: 5, ratePct: 5 },
      },
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(scanned: number, offenders: number) {
    const audit = new TitleAudit();
    for (let i = 0; i < scanned; i++) {
      const html = i < offenders ? LONG_TITLE : SHORT_TITLE;
      audit.ingest(jobPath(i), html, jobPath(i));
    }
    return runTitle(audit, baselinePath);
  }

  it('reproduces the pre-fix bug: a genuine per-feature regression must still FAIL', async () => {
    // Before the fix, `cap = baseline.byFeature[feat] ?? 0` was an object
    // in rate mode; `count > cap` coerced the object to NaN and was always
    // false, so this real regression silently passed. This is the core
    // repro for #3596's runTitle() half.
    const r = await run(100, 15);
    expect(r.passed).toBe(false);
  });

  it('flat rate under proportional organic growth → PASS', async () => {
    const r = await run(400, 20);
    expect(r.passed).toBe(true);
  });

  it('legacy (non-rate) baseline still supported for backward compat', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'audit-dist-multi-title-legacy-'));
    const legacyPath = join(legacyDir, 'baseline.json');
    writeFileSync(legacyPath, JSON.stringify({
      generated: new Date().toISOString(),
      threshold: 66,
      total: 5,
      byFeature: { 'job-board': 5 },
    }, null, 2));
    const audit = new TitleAudit();
    for (let i = 0; i < 100; i++) {
      const html = i < 5 ? LONG_TITLE : SHORT_TITLE;
      audit.ingest(jobPath(i), html, jobPath(i));
    }
    const rOk = await runTitle(audit, legacyPath);
    expect(rOk.passed).toBe(true);

    const auditFail = new TitleAudit();
    for (let i = 0; i < 100; i++) {
      const html = i < 12 ? LONG_TITLE : SHORT_TITLE;
      auditFail.ingest(jobPath(i), html, jobPath(i));
    }
    const rFail = await runTitle(auditFail, legacyPath);
    expect(rFail.passed).toBe(false);
    rmSync(legacyDir, { recursive: true, force: true });
  });
});

// H1Audit flags an OFFENDER page as one where <title> and <h1> are the same
// text (case/whitespace-insensitive) — a duplicate-content smell, not a
// length threshold. DUP = offender, DISTINCT = healthy (non-offender).
const DUP_TITLE_H1 = '<html><head><title>Same Heading Text</title></head><body><h1>Same Heading Text</h1></body></html>';
const DISTINCT_TITLE_H1 = '<html><head><title>Page Title</title></head><body><h1>A Different Heading</h1></body></html>';

describe('audit-dist-multi runH1() — rate-mode ratchet (#3596)', () => {
  let dir: string;
  let baselinePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-dist-multi-h1-'));
    baselinePath = join(dir, 'baseline.json');
    const baseline = {
      generated: new Date().toISOString(),
      mode: 'rate',
      tolerance: { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 100,
      totalOffenders: 5,
      totalRatePct: 5,
      byFeature: {
        'job-board': { scanned: 100, offenders: 5, ratePct: 5 },
      },
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(scanned: number, offenders: number) {
    const audit = new H1Audit();
    for (let i = 0; i < scanned; i++) {
      const html = i < offenders ? DUP_TITLE_H1 : DISTINCT_TITLE_H1;
      audit.ingest(jobPath(i), html, jobPath(i));
    }
    return runH1(audit, baselinePath);
  }

  it('reproduces the pre-fix bug: rate-mode baseline must NOT be read as byFeature[feat]=NaN', async () => {
    // Pre-fix, `count > (baseline.byFeature[feat] ?? 0)` compared against an
    // OBJECT (not a number) in rate mode, so `count > NaN` was always false —
    // the per-feature check silently never fired again. Flat rate matching
    // the baselined 5 % exactly must PASS (this exercises the fixed
    // comparison path without tripping it).
    const r = await run(100, 5);
    expect(r.passed).toBe(true);
  });

  it('flat rate under proportional organic growth → PASS', async () => {
    const r = await run(400, 20);
    expect(r.passed).toBe(true);
  });

  it('per-template regression (~3x thin rate) -> FAIL', async () => {
    const r = await run(100, 15);
    expect(r.passed).toBe(false);
  });

  it('legacy (non-rate) baseline still supported for backward compat', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'audit-dist-multi-h1-legacy-'));
    const legacyPath = join(legacyDir, 'baseline.json');
    writeFileSync(legacyPath, JSON.stringify({
      generated: new Date().toISOString(),
      total: 5,
      byFeature: { 'job-board': 5 },
    }, null, 2));
    const audit = new H1Audit();
    for (let i = 0; i < 100; i++) {
      const html = i < 5 ? DUP_TITLE_H1 : DISTINCT_TITLE_H1;
      audit.ingest(jobPath(i), html, jobPath(i));
    }
    const rOk = await runH1(audit, legacyPath);
    expect(rOk.passed).toBe(true);

    const auditFail = new H1Audit();
    for (let i = 0; i < 100; i++) {
      const html = i < 12 ? DUP_TITLE_H1 : DISTINCT_TITLE_H1;
      auditFail.ingest(jobPath(i), html, jobPath(i));
    }
    const rFail = await runH1(auditFail, legacyPath);
    expect(rFail.passed).toBe(false);
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
