import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL2DemandExport,
  buildL2OutcomeQuery,
  buildUnavailableL2DemandExport,
  exportL2,
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

  it('builds a session-level query with the registered events and no identity fields', () => {
    const query = buildL2OutcomeQuery({
      paths: ['/offerte-lavoro-ticino/'],
      window: { start: '2026-09-04T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z' },
    });
    expect(query).toContain('properties.$pathname');
    expect(query).toContain('main_conversion');
    expect(query).toContain('calculate');
    expect(query).toContain('$session_id');
    expect(query).not.toMatch(/email|distinct_id|person_id/iu);
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

  it('uses read-only PostHog configuration and writes a runner-local live export', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l2-outcome-export-'));
    const inputPath = path.join(dir, 'gsc.json');
    const outputPath = path.join(dir, 'outcomes.json');
    fs.writeFileSync(inputPath, `${JSON.stringify(source())}\n`);
    const queries: string[] = [];
    const client = {
      remoteConfig: async () => ({ parameters: {
        SERVER_POSTHOG_PERSONAL_API_KEY: { defaultValue: { value: 'test-key' } },
        SERVER_POSTHOG_PROJECT_ID: { defaultValue: { value: '123' } },
        SERVER_POSTHOG_HOST: { defaultValue: { value: 'https://posthog.test' } },
      } }),
    };
    const output = await exportL2({
      inputPath,
      outputPath,
      now: NOW,
      days: 8,
      client: client as any,
      posthogRunner: async (query, config) => {
        queries.push(`${query}\n${JSON.stringify(config)}`);
        return { columns: ['eligibleLandingSessions', 'usefulActions'], results: [[1200, 210]] };
      },
    });
    expect(output.outcomes).toEqual({ eligibleLandingSessions: 1200, usefulActions: 210 });
    expect(queries[0]).toContain('https://posthog.test');
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).outcomes).toEqual(output.outcomes);
  });
});
