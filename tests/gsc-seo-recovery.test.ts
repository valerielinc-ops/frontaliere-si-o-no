import { describe, expect, it } from 'vitest';
import malformedQueryFixture from './fixtures/gsc-seo-recovery/malformed-query-rows.json';
import nullPositionFixture from './fixtures/gsc-seo-recovery/null-position-zero-impressions.json';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fixture from './fixtures/gsc-seo-recovery/operational-input.json';
import { selectLatestGscFinalWindow } from '../scripts/lib/gsc-final-window.mjs';
import {
  assessGscRecoveryComparability,
  buildGscRecoveryReport,
  createGscRecoverySnapshot,
  gscRecoverySnapshotHash,
  renderGscRecoveryMarkdown,
} from '../scripts/lib/gsc-recovery-report.mjs';

function operationalPair({ queryRowsComplete = true } = {}) {
  const selection = selectLatestGscFinalWindow({
    today: fixture.today,
    availableDates: fixture.availableDates,
    firstIncompleteDate: fixture.firstIncompleteDate,
  });
  return {
    selection,
    current: createGscRecoverySnapshot({
      assessment: selection,
      pageRows: fixture.currentPageRows,
      queryRows: fixture.currentQueryRows,
      pageRowsComplete: true,
      queryRowsComplete,
    }),
    baseline: createGscRecoverySnapshot({
      assessment: selection.previous,
      pageRows: fixture.previousPageRows,
      queryRows: fixture.previousQueryRows,
      pageRowsComplete: true,
      queryRowsComplete: true,
    }),
  };
}

describe('GSC SEO recovery report', () => {
  it('compares two complete consecutive final windows and keeps locale/template/canton on each page', () => {
    const { selection, current, baseline } = operationalPair();
    const report = buildGscRecoveryReport({
      current,
      baseline,
      baselineSource: 'previous-final-window',
      indexabilityEvidence: fixture.indexabilityEvidence,
      generatedAt: '2026-10-21T00:00:00.000Z',
    });

    expect(selection).toMatchObject({
      status: 'measurable',
      window: { start: '2026-10-12', end: '2026-10-18' },
      previousWindow: { start: '2026-10-05', end: '2026-10-11' },
      previous: { status: 'measurable', complete: true },
    });
    expect(report).toMatchObject({ status: 'measurable', comparability: { status: 'measurable', days: 7 } });
    expect(new Set(report.pages.map((page) => page.locale))).toEqual(new Set(['it', 'en', 'de', 'fr']));
    expect(report.pages.find((page) => page.path.includes('jobs-in-der-waadt'))).toMatchObject({
      locale: 'de',
      template: 'jobs_search',
      canton: 'VD',
    });
  });

  it('uses segmented CTR for content recovery while preserving the unsegmented GSC delta', () => {
    const { current, baseline } = operationalPair();
    const report = buildGscRecoveryReport({ current, baseline });
    const article = report.pages.find((page) => page.path === '/en/swiss-articles/permit-guide/');

    expect(article.metrics.ctr.delta).toBe(0);
    expect(article.metrics.segmentedCtr.delta).toBe(-0.2);
    expect(report.queues.ctrContent.map((page) => page.path)).toContain(article.path);
    expect(article.querySegments.status).toBe('measurable');
  });

  it('separates visibility and non-200 evidence and leaves unverified redirects unknown', () => {
    const { current, baseline } = operationalPair();
    const report = buildGscRecoveryReport({ current, baseline, indexabilityEvidence: fixture.indexabilityEvidence });
    const missing = report.queues.indexability.find((row) => row.path.includes('assurance-maladie'));
    const redirect = report.queues.unknown.find((row) => row.path.includes('ancienne-offre'));
    const visibility = report.queues.visibilityLoss.find((row) => row.path.includes('jobs-in-der-waadt'));

    expect(missing).toMatchObject({
      status: 'indexability',
      code: 'non_200',
      evidence: { httpStatus: 404 },
      metrics: { clicks: { delta: -5 }, impressions: { delta: -80 } },
    });
    expect(redirect).toMatchObject({ status: 'unknown', code: 'redirect_target_unverified', evidence: { redirectTarget: 'unknown' } });
    expect(redirect).not.toHaveProperty('target');
    expect(redirect.metrics.impressions.delta).toBe(0);
    expect(report.queues.ctrContent.map((page) => page.path)).not.toContain(redirect.path);
    expect(report.queues.visibilityLoss.map((page) => page.path)).not.toContain(redirect.path);
    expect(visibility).toMatchObject({ locale: 'de', metrics: { impressions: { delta: -600 }, position: { delta: 4 } } });
  });

  it('accepts a dated explicit baseline snapshot as read-only and records its stable hash', () => {
    const { current } = operationalPair();
    const baseline = createGscRecoverySnapshot({
      assessment: {
        status: 'measurable',
        complete: true,
        window: { start: '2026-09-01', end: '2026-09-07' },
        firstIncompleteDate: null,
      },
      pageRows: fixture.previousPageRows,
      queryRows: fixture.previousQueryRows,
      pageRowsComplete: true,
      queryRowsComplete: true,
      snapshotId: 'fixed-baseline-fixture',
    });
    const before = JSON.stringify(baseline);
    const hash = gscRecoverySnapshotHash(baseline);
    const report = buildGscRecoveryReport({ current, baseline, baselineSource: 'immutable-snapshot' });

    expect(report).toMatchObject({
      status: 'measurable',
      baseline: {
        source: 'immutable-snapshot',
        window: { start: '2026-09-01', end: '2026-09-07' },
        snapshotHash: hash,
      },
    });
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it('marks missing dates, incomplete page rows, and unequal windows unmeasurable', () => {
    const { current, baseline } = operationalPair();
    const incompleteSelection = selectLatestGscFinalWindow({
      today: fixture.today,
      availableDates: fixture.availableDates.filter((date) => date.endsWith('0') || date.endsWith('2') || date.endsWith('4') || date.endsWith('6') || date.endsWith('8')),
    });
    const incomplete = createGscRecoverySnapshot({ assessment: incompleteSelection, pageRowsComplete: false });
    const report = buildGscRecoveryReport({ current: incomplete, baseline });
    const truncated = createGscRecoverySnapshot({
      assessment: current.assessment,
      pageRows: fixture.currentPageRows,
      queryRows: fixture.currentQueryRows,
      pageRowsComplete: false,
      queryRowsComplete: true,
    });
    const durationMismatch = createGscRecoverySnapshot({
      assessment: { status: 'measurable', complete: true, window: { start: '2026-09-01', end: '2026-09-14' } },
      pageRows: fixture.previousPageRows,
      queryRows: fixture.previousQueryRows,
      pageRowsComplete: true,
      queryRowsComplete: true,
    });

    expect(incompleteSelection.status).toBe('unmeasurable');
    expect(report.status).toBe('unmeasurable');
    expect(assessGscRecoveryComparability(truncated, baseline).status).toBe('unmeasurable');
    expect(assessGscRecoveryComparability(current, durationMismatch)).toMatchObject({ status: 'unmeasurable', reason: expect.stringContaining('durations differ') });
  });

  it('keeps page visibility measurable when query-segment data is incomplete, but suppresses CTR/content', () => {
    const { current, baseline } = operationalPair({ queryRowsComplete: false });
    const report = buildGscRecoveryReport({ current, baseline });

    expect(report.status).toBe('measurable');
    expect(report.queues.visibilityLoss.length).toBeGreaterThan(0);
    expect(report.queues.ctrContent).toHaveLength(0);
    expect(report.comparability.querySegments.status).toBe('unmeasurable');
  });

  it('fails closed when malformed query rows are discarded from a supposedly complete CTR snapshot', () => {
    const { current, baseline } = operationalPair();
    const malformedCurrent = createGscRecoverySnapshot({
      assessment: current.assessment,
      pageRows: fixture.currentPageRows,
      queryRows: malformedQueryFixture.rows,
      pageRowsComplete: true,
      queryRowsComplete: true,
    });
    const report = buildGscRecoveryReport({ current: malformedCurrent, baseline });

    expect(malformedCurrent).toMatchObject({
      queryRowsComplete: false,
      queryRowsError: 'discarded 2 malformed query row(s)',
      queryRows: [],
    });
    expect(report.status).toBe('measurable');
    expect(report.queues.ctrContent).toHaveLength(0);
    expect(report.comparability.querySegments).toMatchObject({ status: 'unmeasurable', reason: 'discarded 2 malformed query row(s)' });
  });

  it('does not coerce null page metrics into zero on a complete snapshot', () => {
    const { current, baseline } = operationalPair();
    const malformedCurrent = createGscRecoverySnapshot({
      assessment: current.assessment,
      pageRows: [{ path: '/en/swiss-articles/permit-guide/', clicks: null, impressions: 100, position: 5 }],
      queryRows: [],
      pageRowsComplete: true,
      queryRowsComplete: true,
    });

    expect(malformedCurrent).toMatchObject({
      pageRowsComplete: false,
      pageRowsError: 'discarded or rejected 1 malformed page row(s)',
    });
    expect(buildGscRecoveryReport({ current: malformedCurrent, baseline }).status).toBe('unmeasurable');
  });

  it('keeps position unknown when rows have null position or zero impressions', () => {
    const { selection } = operationalPair();
    const current = createGscRecoverySnapshot({
      assessment: selection,
      pageRows: nullPositionFixture.currentRows,
      queryRows: [],
      pageRowsComplete: true,
      queryRowsComplete: true,
    });
    const baseline = createGscRecoverySnapshot({
      assessment: selection.previous,
      pageRows: nullPositionFixture.baselineRows,
      queryRows: [],
      pageRowsComplete: true,
      queryRowsComplete: true,
    });
    const report = buildGscRecoveryReport({ current, baseline });
    const page = report.pages.find((row) => row.path === nullPositionFixture.path);

    expect(page.metrics.position).toMatchObject({ current: null, baseline: 5, delta: null, relativeDelta: null });
    expect(report.queues.visibilityLoss.map((row) => row.path)).not.toContain(nullPositionFixture.path);
  });

  it('renders all four queues and explains unknown redirects without guessing destinations', () => {
    const { current, baseline } = operationalPair();
    const report = buildGscRecoveryReport({ current, baseline, indexabilityEvidence: fixture.indexabilityEvidence });
    const markdown = renderGscRecoveryMarkdown(report, { limit: 3 });

    expect(markdown).toContain('## Non-200 e indexability');
    expect(markdown).toContain('## Perdita di visibilità');
    expect(markdown).toContain('## CTR e contenuto');
    expect(markdown).toContain('## Evidenza unknown');
    expect(markdown).toContain('nessuna destinazione viene dedotta');
  });

  it('runs the recovery CLI from an offline fixture without GSC credentials', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'gsc-seo-recovery-'));
    const fixturePath = resolve(process.cwd(), 'tests/fixtures/gsc-seo-recovery/operational-input.json');
    const scriptPath = resolve(process.cwd(), 'scripts/gsc-content-opportunity-score.mjs');
    try {
      execFileSync(process.execPath, [
        scriptPath,
        '--mode=recovery',
        `--fixture=${fixturePath}`,
        `--out=${outputDir}`,
        '--top=10',
      ], { cwd: process.cwd(), encoding: 'utf8' });
      const report = JSON.parse(readFileSync(join(outputDir, 'recovery-report.json'), 'utf8'));
      expect(report).toMatchObject({ status: 'measurable', summary: { indexability: 1, visibilityLoss: expect.any(Number), ctrContent: expect.any(Number), unknown: 1 } });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
