import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeAuditAllVerdict, readAuditAllVerdict } from './helpers/auditAllMirror';

function distWithReport(report: unknown, distMtime?: Date): string {
  const dist = mkdtempSync(join(tmpdir(), 'audit-all-mirror-'));
  writeFileSync(join(dist, 'index.html'), '<html></html>');
  if (distMtime) utimesSync(join(dist, 'index.html'), distMtime, distMtime);
  mkdirSync(join(dist, 'audit-reports'));
  writeFileSync(join(dist, 'audit-reports', 'faqpage-validity.json'), typeof report === 'string' ? report : JSON.stringify(report));
  return dist;
}

const now = () => new Date().toISOString();

describe('readAuditAllVerdict — mirrors defer to the audit:all report of THIS dist', () => {
  it('returns a failing verdict as-is, so the mirror goes red with the auditor', () => {
    const dist = distWithReport(
      { audit: 'faqpage-validity', ranAt: now(), passed: false, offendersTotal: 3, sampleRate: 0.25, topOffenders: [{ path: '/a/' }] },
      new Date(Date.now() - 60_000),
    );
    const v = readAuditAllVerdict(dist, 'faqpage-validity');
    expect(v).not.toBeNull();
    expect(v!.passed).toBe(false);
    expect(v!.offendersTotal).toBe(3);
    expect(describeAuditAllVerdict(v!)).toContain('passed=false offenders=3 sampleRate=0.25');
  });

  it('ignores a report older than the dist (it judged another build)', () => {
    const dist = distWithReport(
      { audit: 'faqpage-validity', ranAt: new Date(Date.now() - 3_600_000).toISOString(), passed: true },
      new Date(),
    );
    expect(readAuditAllVerdict(dist, 'faqpage-validity')).toBeNull();
  });

  it('ignores a missing, malformed or mislabelled report', () => {
    const dist = distWithReport('{not json');
    expect(readAuditAllVerdict(dist, 'faqpage-validity')).toBeNull();
    expect(readAuditAllVerdict(dist, 'breadcrumb-coverage')).toBeNull();
    const other = distWithReport({ audit: 'breadcrumb-coverage', ranAt: now(), passed: true }, new Date(Date.now() - 60_000));
    expect(readAuditAllVerdict(other, 'faqpage-validity')).toBeNull();
  });
});
