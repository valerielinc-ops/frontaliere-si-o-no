import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseJobsSeoBuildLog,
  renderMarkerFile,
  renderSummary,
  validateFullCorpusMeasurement,
} from '../scripts/ci/report-jobs-seo-build-metrics.mjs';

// Verbatim `jobs-seo-full-corpus-markers-<run_id>` artifacts of real production
// deploy runs (build-locale (it)). #9754 shipped `previousSlugEntries > 0`
// tested only against a synthetic log; every healthy production build reports
// 0 there by design, and the invariant failed every deploy until #9773. The
// validator of #9754 exits 1 on each of these files. Any invariant added or
// tightened in validateFullCorpusMeasurement must hold on ALL of them, so a
// check that production does not satisfy fails on the PR instead of on the
// deploy. To add one (retention 14 days):
//   gh run download <run_id> --name jobs-seo-full-corpus-markers-<run_id>
//   mv jobs-seo-markers.txt tests/fixtures/jobs-seo-full-corpus-markers/run-<run_id>.txt
const PRODUCTION_MARKERS_DIR = resolve(import.meta.dirname, 'fixtures/jobs-seo-full-corpus-markers');
const PRODUCTION_MARKERS = readdirSync(PRODUCTION_MARKERS_DIR)
  .filter((file) => /^run-\d+\.txt$/u.test(file))
  .sort()
  .map((file) => ({ file, text: readFileSync(resolve(PRODUCTION_MARKERS_DIR, file), 'utf8') }));

const FULL_CORPUS_LOG = [
  '\u001b[35m[mem]\u001b[0m jobsSeoPages: after-active-pages heapUsed=10602MB (gcFreed=10MB) external=10MB arrayBuffers=2MB rss=11805MB validJobs=22595 bridgeCount=0',
  '[jobs-seo-profile] previous-slug-bridge              120   99000.0   4.0   825.00   800.00   1200.00   100.00   2000.00',
  '[jobs-seo-profile] previous-slug-bridge-legacy-ti     80   54000.0   2.2   675.00   650.00   1000.00    80.00   1500.00',
  '[jobs-seo-profile] TOTAL                             200  153000.0',
  '[mem] jobsSeoPages: after-previous-slug-bridges heapUsed=10500MB (gcFreed=0MB) external=10MB arrayBuffers=2MB rss=11700MB validJobs=22595 bridgeCount=200 previousSlugEntries=320 sitemapEntries=320',
  '[mem] jobsSeoPages: after corpus-release heapUsed=9910MB (gcFreed=1530MB) external=10MB arrayBuffers=2MB rss=11000MB validJobs=0 releasedValidJobs=1 releasedJobHtmlCache=1 releasedRelatedIndexes=1',
].join('\n');

// Reduced from the real production build log of deploy run 36065965021
// (sha 708b43c45d, job build-locale (it)): marker lines verbatim up to rss,
// then only the fields the validator reads plus the previous-slug counters.
// sitemapEntries/previousSlugEntries are 0 by design because the plugin keeps
// INCLUDE_PREV_SLUG_SITEMAP_ENTRIES = false; bridgeCount is the coverage proof.
const PRODUCTION_LOG_RUN_36065965021 = [
  '[mem] jobsSeoPages: after-active-pages heapUsed=11782MB (gcFreed=0MB) external=230MB arrayBuffers=203MB rss=12166MB validJobs=22591 previousSlugWinners=0 previousSlugEntries=0',
  '[mem] jobsSeoPages: after-previous-slug-bridges heapUsed=10272MB (gcFreed=0MB) external=180MB arrayBuffers=153MB rss=10009MB validJobs=22591 previousSlugWinners=161711 previousSlugEntries=0 bridgeCount=132002 bridgeSkippedNotWinner=1776 sitemapEntries=0',
  '[mem] jobsSeoPages: after corpus-release heapUsed=9961MB (gcFreed=407MB) external=150MB arrayBuffers=123MB rss=8783MB validJobs=0 previousSlugWinners=0 previousSlugEntries=0 releasedValidJobs=1 releasedJobHtmlCache=1 releasedRelatedIndexes=1',
  '[jobs-seo-profile] previous-slug-bridge           68021    58097.1   4.0     0.85     0.52    18.56    0.25   730.43',
  '[jobs-seo-profile] previous-slug-bridge-legacy-ti   63981    43200.7   3.0     0.68     0.34    18.43    0.24   249.20',
  '[jobs-seo-profile] TOTAL                        3631082  1436620.6',
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

  it('accepts the real production log of run 36065965021 (bridges emitted, zero previous-slug sitemap entries)', () => {
    const report = parseJobsSeoBuildLog(PRODUCTION_LOG_RUN_36065965021);

    expect(report.previousSlugBridges).toMatchObject({ bridgeCount: 132002, previousSlugEntries: 0 });
    const validation = validateFullCorpusMeasurement(report);
    expect(validation).toEqual({ ok: true, errors: [] });
    const summary = renderSummary(report, { label: 'production/it', validation });
    expect(summary).toContain('| previous-slug checkpoint | 132002 bridges / 0 sitemap entries |');
    expect(summary).toContain('| full-corpus validation | PASS |');
  });

  it('still fails when no bridge was emitted or the previousSlugEntries field is not observable', () => {
    const noBridges = parseJobsSeoBuildLog(PRODUCTION_LOG_RUN_36065965021.replace('bridgeCount=132002', 'bridgeCount=0'));
    expect(validateFullCorpusMeasurement(noBridges).errors).toEqual([
      'after-previous-slug-bridges has no positive bridgeCount',
    ]);

    const noField = parseJobsSeoBuildLog(PRODUCTION_LOG_RUN_36065965021.replace(
      /(after-previous-slug-bridges[^\n]*?) previousSlugEntries=0/u,
      '$1',
    ));
    expect(validateFullCorpusMeasurement(noField).errors).toEqual([
      'after-previous-slug-bridges has no previousSlugEntries field (expected a non-negative integer)',
    ]);
  });
});

describe('replay on real production marker artifacts', () => {
  it('finds the production artifacts (an empty glob would make the replay vacuous)', () => {
    expect(PRODUCTION_MARKERS.map(({ file }) => file)).toEqual(expect.arrayContaining([
      'run-36065965021.txt',
      'run-36077807468.txt',
      'run-36088944074.txt',
    ]));
  });

  it.each(PRODUCTION_MARKERS)('$file satisfies every full-corpus invariant', ({ text }) => {
    const report = parseJobsSeoBuildLog(text);

    expect(validateFullCorpusMeasurement(report)).toEqual({ ok: true, errors: [] });
    // The production fact #9754 got wrong: bridges are emitted by the tens of
    // thousands while none is advertised in the sitemap.
    expect(report.previousSlugBridges.bridgeCount).toBeGreaterThan(0);
    expect(report.previousSlugBridges.previousSlugEntries).toBe(0);
  });

  it.each(PRODUCTION_MARKERS)('$file replays to the verdict the deploy computed on the full log', ({ text }) => {
    // Interleave the non-marker noise a real build log carries, including
    // marker-looking text that is not at the start of the line.
    const noisyLog = text
      .split('\n')
      .flatMap((line, index) => [
        `vite v6 transforming (${index}) src/pages/Page${index}.tsx`,
        `  warn: see [jobs-seo-sample] docs, not a marker ${index}`,
        line,
      ])
      .join('\n');

    const fromLog = parseJobsSeoBuildLog(noisyLog);
    const fromArtifact = parseJobsSeoBuildLog(renderMarkerFile(fromLog));

    expect(fromArtifact.markerLines).toEqual(fromLog.markerLines);
    expect(validateFullCorpusMeasurement(fromArtifact)).toEqual(validateFullCorpusMeasurement(fromLog));
    expect(validateFullCorpusMeasurement(fromLog).ok).toBe(true);
  });
});
