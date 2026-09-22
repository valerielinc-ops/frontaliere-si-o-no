import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as employerInsightsBuilder from '../scripts/build-employer-insights.mjs';
import { validateD18Artifact } from '../scripts/ci/validate-employer-insights-d18-payload.mjs';
import { commitInChunks } from '../scripts/lib/firestore-batch.mjs';

const REFRESH_WORKFLOW_SOURCE = readFileSync(
  new URL('../.github/workflows/employer-insights-refresh.yml', import.meta.url),
  'utf8',
);

describe('employer insights refresh rollback', () => {
  it('runs and validates the bounded D18 two-regime artifact beside the legacy writer', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('--d18-json-out /tmp/employer-insights-d18.json');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('--d18-include-applications');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('validate-employer-insights-d18-payload.mjs');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('--require-live-ga4');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('Upload D18 bounded artifact');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('/tmp/employer-insights-d18.json');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('/tmp/employer-insights-builder.log');
    expect(REFRESH_WORKFLOW_SOURCE).not.toMatch(/^\s+- posthog$/m);
  });

  it('accepts a D18 fixture with both regimes and keeps the period total non-summable', () => {
    const window = {
      from: '2026-09-01T00:00:00+02:00',
      to: '2026-09-12T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const catalog = employerInsightsBuilder.buildIdentityCatalog([{
      id: 'job-1',
      companyKey: 'acme',
      company: 'Acme SA',
      title: 'Role',
      slug: 'role-it',
      slugByLocale: { it: 'role-it' },
      status: 'active',
    }]);
    const queryResult = (source: string, observed: number, snapshotId: string) => ({
      rows: [{
        event: 'page_view',
        timestamp: source === 'ga4' ? '2026-09-10T00:00:00.000Z' : '2026-09-08T10:00:00.000Z',
        employerKey: 'acme',
        jobSlug: 'role-it',
        pageTemplate: 'job_detail',
        locale: 'it',
        observed,
        visitorId: `${source}-visitor`,
        emissionId: `${source}-emission`,
      }],
      coverage: {
        rowsReturned: 1,
        totalRows: 1,
        returnedRows: 1,
        returned: observed,
        sourceObserved: observed,
        pages: 1,
        truncated: false,
        identityObserved: source === 'ga4' ? observed : undefined,
        snapshotId,
        queryHash: `${source}-query`,
      },
    });
    const payload = employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window,
      generatedAt: '2026-09-12T06:00:00.000Z',
      catalog,
      ga4Result: queryResult('ga4', 2, 'ga4-fixture'),
      posthogResult: queryResult('posthog', 3, 'posthog-fixture'),
      applicationRecords: [],
    });

    const validation = validateD18Artifact(payload);
    expect(validation.ok).toBe(true);
    const firstRunValidation = validateD18Artifact(payload, { requireLiveGa4: true });
    expect(firstRunValidation.ok).toBe(false);
    expect(firstRunValidation.errors.join('\n')).toMatch(/blocked|live|replay/);
    expect(payload.sourceRegimes.ga4.status).toBe('observed');
    expect(payload.sourceRegimes.posthog.status).toBe('parziale');
    expect(payload.periodTotal).toMatchObject({
      value: null,
      unit: 'composite_two_regimes',
      status: 'non sommabile fra regimi',
    });
    expect(payload.periodTotal.value).not.toBe(5);
    expect(payload.coverageMatrix.requestedDays.length).toBe(11);
    expect(payload.provenance.limitState).toBe('parziale, mai complete');

    const pending = employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window,
      generatedAt: '2026-09-12T06:00:00.000Z',
      catalog,
      ga4Result: queryResult('ga4', 2, 'ga4-fixture'),
      posthogUnavailableReason: 'blocked: backup credentials unavailable',
    });
    expect(validateD18Artifact(pending).ok).toBe(true);
    expect(pending.sourceRegimes.posthog.status).toBe('sorgente non disponibile');
    expect(pending.coverageMatrix.status).toBe('non disponibile');
  });

  it('replays a frozen GA4/PostHog snapshot deterministically without provider access', () => {
    const window = {
      from: '2026-09-01T00:00:00+02:00',
      to: '2026-09-12T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const catalog = employerInsightsBuilder.buildIdentityCatalog([{
      id: 'job-1',
      companyKey: 'acme',
      company: 'Acme SA',
      title: 'Role',
      slug: 'role-it',
      slugByLocale: { it: 'role-it' },
      status: 'active',
    }]);
    const replayInput = {
      schemaVersion: 1,
      mode: 'replay',
      generatedAt: '2026-09-12T06:00:00.000Z',
      window,
      measurementWindow: {
        from: '2026-09-09T00:00:00+02:00',
        to: window.to,
        timezone: 'Europe/Zurich',
        inclusive: '[from,to)',
      },
      sources: {
        ga4: {
          rows: [{
            event: 'page_view',
            timestamp: '2026-09-10T00:00:00.000Z',
            employerKey: 'acme',
            jobSlug: 'role-it',
            observed: 2,
            emissionId: 'ga4-emission-1',
          }],
          coverage: {
            rowsReturned: 1,
            totalRows: 1,
            returnedRows: 1,
            returned: 2,
            sourceObserved: 2,
            identityObserved: 2,
            emissionIdDimensionRequested: true,
            emissionIdObserved: 2,
            emissionIdMissingObserved: 0,
            pages: 1,
            truncated: false,
            snapshotId: 'ga4-replay-snapshot',
            queryHash: 'ga4-replay-query',
          },
        },
        posthog: {
          rows: [{
            event: 'page_view',
            timestamp: '2026-09-08T10:00:00.000Z',
            employerKey: 'acme',
            jobSlug: 'role-it',
            observed: 3,
            emissionId: 'posthog-emission-1',
          }],
          coverage: {
            rowsReturned: 1,
            totalRows: 1,
            returnedRows: 1,
            returned: 3,
            sourceObserved: 3,
            pages: 1,
            truncated: false,
            snapshotId: 'posthog-replay-snapshot',
            queryHash: 'posthog-replay-query',
          },
        },
      },
      applicationRecords: [],
      deliveryRecords: [],
    };
    const replay = employerInsightsBuilder.parseEmployerInsightsReplay(replayInput, 'ga4');
    const build = () => employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window: replay.window,
      generatedAt: replay.generatedAt,
      catalog,
      ga4Result: replay.sources.ga4,
      posthogResult: replay.sources.posthog,
      applicationRecords: replay.applicationRecords,
      deliveryRecords: replay.deliveryRecords,
      runMode: 'replay',
      primarySource: 'ga4',
      ga4EvidenceWindow: replay.measurementWindow,
    });

    const first = build();
    const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.evidence).toMatchObject({ status: 'replay-valid', runMode: 'replay' });
    expect(first.evidence.measurementWindow).toMatchObject({
      from: replay.measurementWindow.from,
      to: replay.measurementWindow.to,
      timezone: replay.measurementWindow.timezone,
      inclusive: replay.measurementWindow.inclusive,
    });
    expect(validateD18Artifact(first).ok).toBe(true);
    expect(() => employerInsightsBuilder.parseEmployerInsightsReplay({ ...replayInput, sources: { posthog: replayInput.sources.posthog } }, 'ga4'))
      .toThrow(/missing the ga4 source result/);
  });

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
