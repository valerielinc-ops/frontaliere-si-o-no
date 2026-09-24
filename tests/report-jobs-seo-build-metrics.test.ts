import { describe, expect, it } from 'vitest';
import {
  parseJobsSeoBuildLog,
  renderSummary,
  validateFullCorpusMeasurement,
} from '../scripts/ci/report-jobs-seo-build-metrics.mjs';

const FULL_CORPUS_LOG = [
  '\u001b[35m[mem]\u001b[0m jobsSeoPages: after-active-pages heapUsed=10602MB (gcFreed=10MB) external=10MB arrayBuffers=2MB rss=11805MB validJobs=22595 bridgeCount=0',
  '[jobs-seo-profile] previous-slug-bridge              120   99000.0   4.0   825.00   800.00   1200.00   100.00   2000.00',
  '[jobs-seo-profile] previous-slug-bridge-legacy-ti     80   54000.0   2.2   675.00   650.00   1000.00    80.00   1500.00',
  '[jobs-seo-profile] TOTAL                             200  153000.0',
  '[mem] jobsSeoPages: after-previous-slug-bridges heapUsed=10500MB (gcFreed=0MB) external=10MB arrayBuffers=2MB rss=11700MB validJobs=22595 bridgeCount=200 previousSlugEntries=320 sitemapEntries=320',
  '[mem] jobsSeoPages: after corpus-release heapUsed=9910MB (gcFreed=1530MB) external=10MB arrayBuffers=2MB rss=11000MB validJobs=0 releasedValidJobs=1 releasedJobHtmlCache=1 releasedRelatedIndexes=1',
].join('\n');

describe('report-jobs-seo-build-metrics', () => {
  it('parses ANSI memory lines and the profiler percentage column', () => {
    const report = parseJobsSeoBuildLog(FULL_CORPUS_LOG);

    expect(report.activePages).toMatchObject({
      heapUsedMb: 10602,
      rssMb: 11805,
      validJobs: 22595,
    });
    expect(report.profiles.get('previous-slug-bridge')).toMatchObject({
      count: 120,
      totalMs: 99000,
      percent: 4,
      avgMs: 825,
    });
    expect(report.profiles.get('previous-slug-bridge-legacy-ti')).toMatchObject({
      count: 80,
      totalMs: 54000,
    });
    expect(report.profiles.has('TOTAL')).toBe(false);
  });

  it('accepts a complete full-corpus report with both bridge profiles', () => {
    const report = parseJobsSeoBuildLog(FULL_CORPUS_LOG);

    expect(validateFullCorpusMeasurement(report)).toEqual({ ok: true, errors: [] });
    expect(renderSummary(report, {
      label: 'production/it',
      wallSeconds: '7200',
      validation: validateFullCorpusMeasurement(report),
    })).toContain('| full-corpus validation | PASS |');
  });

  it('rejects sampled, truncated, or incomplete evidence instead of calling it full corpus', () => {
    const report = parseJobsSeoBuildLog([
      FULL_CORPUS_LOG,
      '[jobs-seo-sample] fraction=0.1 selected=2259 of 22595',
      '[build-stop-after] requested=jobsSeoPages',
    ].join('\n'));

    const validation = validateFullCorpusMeasurement(report);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('jobs-seo-sample'),
      expect.stringContaining('build-stop-after'),
    ]));
  });

  it('requires the bridge checkpoint, release flags, and both positive profile rows', () => {
    const incomplete = parseJobsSeoBuildLog(
      FULL_CORPUS_LOG
        .replace(/^.*after-previous-slug-bridges[^\n]*\n/um, '')
        .replace(/^.*previous-slug-bridge-legacy-ti[^\n]*\n/um, '')
        .replace(/releasedRelatedIndexes=1/u, 'releasedRelatedIndexes=0'),
    );

    const validation = validateFullCorpusMeasurement(incomplete);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'jobsSeoPages: after-previous-slug-bridges marker is missing',
      '[jobs-seo-profile] previous-slug-bridge-legacy-ti row is missing',
      'after corpus-release did not release related indexes (expected releasedRelatedIndexes=1)',
    ]));
  });
});
