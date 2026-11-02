import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const JOB_BOARD_SOURCE = fs.readFileSync(path.join(ROOT, 'components/community/JobBoard.tsx'), 'utf8');

describe('job-board catalog loading after the first listing paint', () => {
  it('waits for LCP and idle after the slim first page before fetching the canton shard', () => {
    const runStart = JOB_BOARD_SOURCE.indexOf('const run = async (): Promise<void> => {');
    const runEnd = JOB_BOARD_SOURCE.indexOf('// On a seeded detail page', runStart);
    const run = JOB_BOARD_SOURCE.slice(runStart, runEnd);
    const firstPagePaint = run.indexOf('await finalize(scopeJobsToCanton(firstPage, targetCanton))');
    const lcpWait = run.indexOf('await waitForInitialPaintOpportunity({ waitForLargestContentfulPaint: true })');
    const idleWait = run.indexOf('await waitForCatalogIdle()');
    const cantonFetch = run.indexOf('await fetchJobsForCanton(targetCanton, locale)');

    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(runEnd).toBeGreaterThan(runStart);
    expect(run).toContain('if (firstPage && !cancelled)');
    expect(firstPagePaint).toBeGreaterThanOrEqual(0);
    expect(lcpWait).toBeGreaterThan(firstPagePaint);
    expect(idleWait).toBeGreaterThan(lcpWait);
    expect(cantonFetch).toBeGreaterThan(idleWait);
  });

  it('keeps the external static page until non-empty listing results are renderable', () => {
    const readinessStart = JOB_BOARD_SOURCE.indexOf('const initialContentReadyRef = useRef(false)');
    const readinessEnd = JOB_BOARD_SOURCE.indexOf('// The canonical unfiltered TI/aggregate listing', readinessStart);
    const readiness = JOB_BOARD_SOURCE.slice(readinessStart, readinessEnd);

    expect(JOB_BOARD_SOURCE).toContain('onInitialContentReady?: () => void');
    expect(readiness).toContain('jobsLoading || jobs.length === 0 || resultsResolving');
    expect(readiness).toContain('onInitialContentReady?.()');
  });
});
