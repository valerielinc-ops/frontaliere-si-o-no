import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL2DemandExport,
  buildL2LandingSessionReportBody,
  buildL2OutcomeCounts,
  buildUnavailableL2DemandExport,
  exportL2,
  L2_USEFUL_ACTION_EVENT,
  landingPathsFromGsc,
} from '../scripts/ci/export-l2-demand-outcomes.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function source(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-09-12T11:00:00.000Z',
    clusters: [
      { canonicalSlug: 'offerte-lavoro-ticino', canonicalQuery: 'offerte lavoro ticino', locale: 'it', totalImpressions: 1200, totalClicks: 80 },
      { canonicalSlug: '/en/jobs-ticino/', canonicalQuery: 'jobs ticino', locale: 'en', totalImpressions: 900, totalClicks: 60 },
    ],
    ...overrides,
  };
}

describe('L2 read-only demand outcome export', () => {
  it('normalizes every GSC landing path and rejects an empty cohort', () => {
    expect(landingPathsFromGsc(source())).toEqual(['/en/jobs-ticino/', '/offerte-lavoro-ticino/']);
    expect(() => landingPathsFromGsc(source({ clusters: [] }))).toThrow('no landing paths');
  });

  it('builds bounded GA4 session reports and keeps useful actions once per session', () => {
    const landingReport = buildL2LandingSessionReportBody({
      startDate: '2026-09-04',
      endDate: '2026-09-12',
    });
    const usefulReport = buildL2LandingSessionReportBody({
      startDate: '2026-09-04',
      endDate: '2026-09-12',
      eventName: L2_USEFUL_ACTION_EVENT,
    });
    expect(landingReport).toMatchObject({
      dimensions: [{ name: 'landingPagePlusQueryString' }],
      metrics: [{ name: 'sessions' }],
    });
    expect(usefulReport.dimensionFilter.filter).toMatchObject({
      fieldName: 'eventName',
      stringFilter: { value: L2_USEFUL_ACTION_EVENT, matchType: 'EXACT' },
    });
    expect(JSON.stringify(landingReport)).not.toMatch(/email|distinct_id|person_id/iu);
  });

  it('joins only GSC paths and rejects incomplete GA4 aggregation', () => {
    expect(buildL2OutcomeCounts({
      landingPaths: ['/offerte-lavoro-ticino/', '/en/jobs-ticino/'],
      landingSessionReport: {
        rows: [
          { dimensionValues: [{ value: '/offerte-lavoro-ticino/?utm_source=gsc' }], metricValues: [{ value: '1200' }] },
          { dimensionValues: [{ value: '/en/jobs-ticino/' }], metricValues: [{ value: '900' }] },
          { dimensionValues: [{ value: '/outside-gsc/' }], metricValues: [{ value: '9999' }] },
        ],
      },
      usefulActionReport: {
        rows: [
          { dimensionValues: [{ value: '/offerte-lavoro-ticino/' }], metricValues: [{ value: '180' }] },
          { dimensionValues: [{ value: '/outside-gsc/' }], metricValues: [{ value: '9999' }] },
        ],
      },
    })).toEqual({ eligibleLandingSessions: 2100, usefulActions: 180 });
    expect(() => buildL2OutcomeCounts({
      landingPaths: ['/offerte-lavoro-ticino/'],
      landingSessionReport: { rowCount: 2, rows: [{ dimensionValues: [{ value: '/offerte-lavoro-ticino/' }], metricValues: [{ value: '1' }] }] },
      usefulActionReport: { rows: [] },
    })).toThrow('truncated');
  });

  it('adds only reconciled non-negative counts to the GSC snapshot', () => {
    const output = buildL2DemandExport(source(), {
      eligibleLandingSessions: 1200,
      usefulActions: 180,
      generatedAt: NOW.toISOString(),
      telemetryWindow: { start: '2026-09-04T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z' },
    });
    expect(output).toMatchObject({
      outcomes: { eligibleLandingSessions: 1200, usefulActions: 180 },
      _meta: { independent: true, piiExcluded: true, identityExcluded: true },
    });
    expect(() => buildL2DemandExport(source(), {
      eligibleLandingSessions: 10,
      usefulActions: 11,
      generatedAt: NOW.toISOString(),
      telemetryWindow: {},
    })).toThrow('exceeds');
  });

  it('removes stale measurements in the unavailable fallback', () => {
    const output = buildUnavailableL2DemandExport(source({ outcomes: { eligibleLandingSessions: 1, usefulActions: 1 } }), {
      now: NOW,
      reason: 'credentials unavailable',
    });
    expect(output).not.toHaveProperty('outcomes');
    expect(output._meta).toMatchObject({ independent: false, unavailableReason: 'credentials unavailable' });
  });

  it('uses read-only GA4 reports and writes a runner-local live export', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l2-outcome-export-'));
    const inputPath = path.join(dir, 'gsc.json');
    const outputPath = path.join(dir, 'outcomes.json');
    fs.writeFileSync(inputPath, `${JSON.stringify(source())}\n`);
    const queries: unknown[] = [];
    const client = {
      accessToken: async () => 'test-token',
    };
    const output = await exportL2({
      inputPath,
      outputPath,
      now: NOW,
      days: 8,
      client: client as any,
      ga4Runner: async ({ body }) => {
        queries.push(body);
        return body.dimensionFilter
          ? { rows: [{ dimensionValues: [{ value: '/offerte-lavoro-ticino/' }], metricValues: [{ value: '210' }] }] }
          : { rows: [
            { dimensionValues: [{ value: '/offerte-lavoro-ticino/' }], metricValues: [{ value: '1200' }] },
            { dimensionValues: [{ value: '/en/jobs-ticino/' }], metricValues: [{ value: '900' }] },
          ] };
      },
    });
    expect(output.outcomes).toEqual({ eligibleLandingSessions: 2100, usefulActions: 210 });
    expect(queries).toHaveLength(2);
    expect(queries.some((body: any) => body.dimensionFilter?.filter?.stringFilter?.value === L2_USEFUL_ACTION_EVENT)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).outcomes).toEqual(output.outcomes);
  });
});
