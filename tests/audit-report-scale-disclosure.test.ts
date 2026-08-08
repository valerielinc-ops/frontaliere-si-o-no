// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { auditReportPath, writeAuditReport } from '../scripts/lib/auditReport.mjs';

/**
 * Two properties of an audit report that a reader cannot infer from the
 * numbers, and that have each already caused a wrong conclusion:
 *
 *  1. `topOffenders` is the worst 100. Absence from it is not evidence of
 *     absence. `text-html-ratio` named spa-locale and spa-other as its
 *     regressed features while neither appeared once in `topOffenders` —
 *     `eventi` and `employer-profiles` had filled the list.
 *  2. Under `AUDIT_SAMPLE_RATE` every count is a sample count.
 *     `h1-title-duplicates` reporting 5 offenders at 0.25 meant 29 real ones.
 *     #5312's own post-mortem records the same class of misread.
 *
 * The fix is disclosure at the single writer every audit goes through. These
 * tests pin the disclosure, because a field that silently stops being written
 * fails exactly like the bug it prevents: quietly, and only for the reader.
 */
describe('audit report discloses its own scale and truncation', () => {
  const AUDIT = 'zz-scale-disclosure-fixture';
  const prevRate = process.env.AUDIT_SAMPLE_RATE;

  const offenders = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `dist/p${i}/index.html`, feature: i < 5 ? 'rare' : 'bulk', metric: 1000 - i }));

  const read = () => JSON.parse(fs.readFileSync(auditReportPath(AUDIT), 'utf8'));

  beforeEach(() => { delete process.env.AUDIT_SAMPLE_RATE; });
  afterEach(() => {
    if (prevRate === undefined) delete process.env.AUDIT_SAMPLE_RATE;
    else process.env.AUDIT_SAMPLE_RATE = prevRate;
    try { fs.rmSync(auditReportPath(AUDIT)); } catch { /* never written */ }
  });

  it('says so when topOffenders is a slice, and how many it dropped', async () => {
    await writeAuditReport({ audit: AUDIT, passed: false, offenders: offenders(250) });
    const r = read();
    expect(r.offendersTotal).toBe(250);
    expect(r.topOffenders.length).toBe(100);
    expect(r.topOffendersTruncated).toBe(true);
    expect(r.topOffendersOmitted).toBe(150);
    expect(r.topOffendersLimit).toBe(100);
  });

  it('does not claim truncation when the list fits', async () => {
    await writeAuditReport({ audit: AUDIT, passed: true, offenders: offenders(7) });
    const r = read();
    expect(r.topOffendersTruncated).toBe(false);
    expect(r.topOffendersOmitted).toBe(0);
    expect(r.topOffenders.length).toBe(7);
  });

  it('names the sample scale and projects the total to the real population', async () => {
    process.env.AUDIT_SAMPLE_RATE = '0.25';
    await writeAuditReport({ audit: AUDIT, passed: false, offenders: offenders(5) });
    const r = read();
    // The exact h1-title-duplicates misread: 5 shown, 20-29 real.
    expect(r.sampleRate).toBe(0.25);
    expect(r.offendersTotal).toBe(5);
    expect(r.offendersTotalExtrapolated).toBe(20);
  });

  it('reports scale 1 for a full walk, and for a nonsense rate', async () => {
    await writeAuditReport({ audit: AUDIT, passed: true, offenders: offenders(3) });
    expect(read().sampleRate).toBe(1);
    expect(read().offendersTotalExtrapolated).toBe(3);

    // A malformed env var must not silently rescale every count in the file.
    for (const bad of ['', 'abc', '0', '-1', '2']) {
      process.env.AUDIT_SAMPLE_RATE = bad;
      await writeAuditReport({ audit: AUDIT, passed: true, offenders: offenders(3) });
      expect(read().sampleRate, `AUDIT_SAMPLE_RATE=${JSON.stringify(bad)}`).toBe(1);
    }
  });

  it('leaves byFeature and offendersTotal on the raw sampled scale', async () => {
    // Deliberate: rescaling them would break every existing consumer and every
    // baseline comparison. The scale is disclosed alongside, not applied.
    process.env.AUDIT_SAMPLE_RATE = '0.25';
    await writeAuditReport({ audit: AUDIT, passed: false, offenders: offenders(12) });
    const r = read();
    expect(r.offendersTotal).toBe(12);
    expect(r.byFeature).toEqual({ rare: 5, bulk: 7 });
  });
});
