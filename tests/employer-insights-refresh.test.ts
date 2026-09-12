import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { commitInChunks } from '../scripts/lib/firestore-batch.mjs';

const REFRESH_WORKFLOW_SOURCE = readFileSync(
  new URL('../.github/workflows/employer-insights-refresh.yml', import.meta.url),
  'utf8',
);

describe('employer insights refresh rollback', () => {
  it('runs the now-supported GA4 identity feed on the periodic trigger', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(/on:\s*[\s\S]*schedule:\s*[\s\S]*cron:\s*'15 5 \* \* \*'/);
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(/ga4\) ;;/);
    expect(REFRESH_WORKFLOW_SOURCE).not.toContain('has no complete GA4 identity feed yet');
  });

  it('compares document coverage with the selected source, not legacy roots', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('const expectedSource = process.env.INSIGHTS_SOURCE;');
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(/snapshot\.docs\s*\.filter\(\(doc\) => doc\.data\(\)\?\.source === expectedSource\)/);
    expect(REFRESH_WORKFLOW_SOURCE).toContain('has no ${expectedSource} documents');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('source: expectedSource');
  });

  it('reports items committed before a later Firestore chunk fails', async () => {
    let commitCount = 0;
    const committedBatches: unknown[][] = [];
    const db = {
      batch() {
        const operations: unknown[] = [];
        const batch = {
          set(ref: unknown, data: unknown) {
            operations.push({ ref, data });
            return batch;
          },
          update(ref: unknown, data: unknown) {
            operations.push({ ref, data });
            return batch;
          },
          delete(ref: unknown) {
            operations.push({ ref });
            return batch;
          },
          async commit() {
            commitCount += 1;
            committedBatches.push(operations);
            if (commitCount === 2) throw new Error('second chunk unavailable');
          },
        };
        return batch;
      },
    };

    const result = await commitInChunks(
      db as never,
      ['before-a', 'before-b', 'after-a'],
      (batch, item) => batch.set({ id: item } as never, { item }),
      { chunkSize: 2 },
    ).catch((error: unknown) => error as Error & { committedItems?: number });

    expect(result).toMatchObject({
      message: 'second chunk unavailable',
      committedItems: 2,
    });
    expect(committedBatches).toHaveLength(2);
    expect(committedBatches[0]).toHaveLength(2);
    expect(committedBatches[1]).toHaveLength(1);
  });

  it('keeps rollback completion and partial progress visible in the workflow error', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('error?.committedItems');
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(
      /rollback incomplete: committed \$\{committed\}\/\$\{attempted\} documents \(Firestore items\)/,
    );
    expect(REFRESH_WORKFLOW_SOURCE).toContain('restoreEmployerInsightsSnapshot');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('expectedDocuments: expected');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('error?.attemptedItems');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('rollbackResult.committed');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('rollback status:');
  });

  it('verifies additional-window shards after the root write', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('employerInsightsWindowAdsSubcollection');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('after.windowAds');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('storedSummary.adsStorage');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('storedAdsForWindow.size');
  });
});
