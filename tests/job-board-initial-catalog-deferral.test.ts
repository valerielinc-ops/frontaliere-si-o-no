import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const JOB_BOARD_SOURCE = fs.readFileSync(path.join(ROOT, 'components/community/JobBoard.tsx'), 'utf8');

describe('job-board catalog loading after the first listing paint', () => {
  it('waits for board interaction after the slim first page before fetching the canton shard', () => {
    const runStart = JOB_BOARD_SOURCE.indexOf('const run = async (): Promise<void> => {');
    const runEnd = JOB_BOARD_SOURCE.indexOf('// On a seeded detail page', runStart);
    const run = JOB_BOARD_SOURCE.slice(runStart, runEnd);
    const firstPagePaint = run.indexOf('await finalize(scopeJobsToCanton(firstPage, targetCanton))');
    const interactionWait = run.indexOf('await waitForCatalogInteraction()');
    const cantonFetch = run.indexOf('await fetchJobsForCanton(targetCanton, locale)');

    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(runEnd).toBeGreaterThan(runStart);
    expect(run).toContain('if (firstPage && !cancelled)');
    expect(firstPagePaint).toBeGreaterThanOrEqual(0);
    expect(run).not.toContain('waitForInitialPaintOpportunity');
    expect(interactionWait).toBeGreaterThan(firstPagePaint);
    expect(cantonFetch).toBeGreaterThan(interactionWait);
    expect(JOB_BOARD_SOURCE).toContain('jobBoardInteractionSeenRef.current = true');
    expect(JOB_BOARD_SOURCE).toContain('if (!event.isTrusted) return;');
    expect(JOB_BOARD_SOURCE).toContain("'pointerdown', 'keydown', 'wheel', 'touchmove', 'scroll', 'focusin'");
    expect(JOB_BOARD_SOURCE).toContain("input, select, textarea, nav button, [role=\"group\"] button, [data-job-board-filter-control]");
    expect(JOB_BOARD_SOURCE).toContain('data-job-board-filter-control');
    expect(JOB_BOARD_SOURCE).not.toContain("'pointerdown', 'keydown', 'wheel', 'touchstart', 'focusin'");
    expect(JOB_BOARD_SOURCE).toContain('if (jobBoardInteractionSeenRef.current)');
  });

  it('shows a resolving state when a filter needs the full catalog', () => {
    expect(JOB_BOARD_SOURCE).toMatch(/fullLoadPending && \(activeFilterCount > 0 \|\| salaryRangeFilter\.min !== null\)/);
  });

  it('keeps the external static page until non-empty listing results are renderable', () => {
    const readinessStart = JOB_BOARD_SOURCE.indexOf('const initialContentReadyRef = useRef(false)');
    const readinessEnd = JOB_BOARD_SOURCE.indexOf('// The canonical unfiltered TI/aggregate listing', readinessStart);
    const readiness = JOB_BOARD_SOURCE.slice(readinessStart, readinessEnd);

    expect(JOB_BOARD_SOURCE).toContain('onInitialContentReady?: () => void');
    expect(readiness).toContain('jobsLoading || jobs.length === 0 || resultsResolving');
    expect(readiness).toContain('onInitialContentReady?.()');
  });
  it('releases the catalog when a filter is already active, without any board interaction', () => {
    expect(JOB_BOARD_SOURCE).toContain('const filterAwaitsCatalog = fullLoadPending && (activeFilterCount > 0 || salaryRangeFilter.min !== null);');
    expect(JOB_BOARD_SOURCE).toContain('if (filterAwaitsCatalog) noteJobBoardInteraction();');
    expect(JOB_BOARD_SOURCE).toMatch(/\|\| filterAwaitsCatalog\)\s+&& !clusterSeedApplies/);
  });
});
