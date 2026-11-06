import { describe, expect, it } from 'vitest';

import {
  buildD18RunEvidence,
  validateD18FirstRunEvidence,
} from '../scripts/lib/employer-insights-cumulative-contract.mjs';

const WINDOW = {
  from: '2026-09-09T00:00:00+02:00',
  to: '2026-09-13T00:00:00+02:00',
  timezone: 'Europe/Zurich',
  inclusive: '[from,to)',
};

function ga4Row(overrides: Record<string, unknown> = {}) {
  return {
    event: 'page_view',
    timestamp: '2026-09-10T10:00:00.000Z',
    employerKey: 'acme',
    jobSlug: 'role-it',
    observed: 3,
    emissionId: 'emission-1',
    ...overrides,
  };
}

function ga4Source(overrides: Record<string, unknown> = {}) {
  return {
    sourceSnapshot: 'ga4-forward-only-fixture',
    queryHash: 'ga4-forward-only-query',
    sourceCoverage: {
      coverageStart: WINDOW.from,
      coverageEnd: WINDOW.to,
      completeThrough: WINDOW.to,
      queried: true,
      status: 'complete',
      sourceObserved: 3,
      rowsReturned: 1,
      identityObserved: 3,
      truncated: false,
      emissionIdDimensionRequested: true,
      emissionIdObserved: 3,
      emissionIdMissingObserved: 0,
      ...overrides,
    },
  };
}

const POSTHOG_BACKUP = {
  sourceSnapshot: 'posthog-historical-backup-fixture',
  sourceCoverage: {
    coverageStart: WINDOW.from,
    coverageEnd: WINDOW.to,
    completeThrough: WINDOW.to,
    queried: true,
    status: 'complete',
    sourceObserved: 99,
    rowsReturned: 1,
    truncated: false,
  },
};

describe('Employer Insights D18 — GA4 emission_id forward-only evidence', () => {
  it.each([
    {
      label: 'an observed row without emission_id',
      source: ga4Source({ emissionIdObserved: 0, emissionIdMissingObserved: 3 }),
      rows: [ga4Row({ emissionId: '' })],
      blocker: /emission_id/,
    },
    {
      label: 'truncated GA4 coverage',
      source: ga4Source({ truncated: true }),
      rows: [ga4Row()],
      blocker: /copertura GA4 è parziale/,
    },
  ])('blocks $label even when PostHog has rows', ({ source, rows, blocker }) => {
    const evidence = buildD18RunEvidence({
      requestedWindow: WINDOW,
      runMode: 'live',
      primarySource: 'ga4',
      ga4Source: source,
      ga4Rows: rows,
      posthogSource: POSTHOG_BACKUP,
      posthogRows: [{ observed: 99, emissionId: 'posthog-only-id' }],
    });

    expect(evidence.status).toBe('blocked');
    expect(evidence.primarySource).toBe('ga4');
    expect(evidence.blockers.join('\n')).toMatch(blocker);
    expect(evidence.posthog.role).toBe('historical-backup');
    expect(validateD18FirstRunEvidence({ requestedWindow: WINDOW, evidence }).ok).toBe(false);
  });

  it('accepts only complete live GA4 evidence and keeps PostHog as historical backup', () => {
    const evidence = buildD18RunEvidence({
      requestedWindow: WINDOW,
      runMode: 'live',
      primarySource: 'ga4',
      ga4Source: ga4Source({ sourceObserved: 5, rowsReturned: 2, identityObserved: 5, emissionIdObserved: 5 }),
      ga4Rows: [
        ga4Row({ observed: 3, emissionId: 'emission-1' }),
        ga4Row({ observed: 2, emissionId: 'emission-2' }),
      ],
      posthogSource: POSTHOG_BACKUP,
      posthogRows: [{ observed: 99, emissionId: 'posthog-only-id' }],
    });

    expect(evidence).toMatchObject({
      status: 'live-first-run-ready',
      primarySource: 'ga4',
      ga4: {
        queried: true,
        truncated: false,
        identityObserved: 5,
        emissionId: {
          dimension: 'emission_id',
          requested: true,
          status: 'complete',
          observed: 5,
          withValue: 5,
          withoutValue: 0,
        },
        role: 'primary',
      },
      posthog: { role: 'historical-backup' },
    });
    expect(validateD18FirstRunEvidence({ requestedWindow: WINDOW, evidence })).toEqual({ ok: true, errors: [] });
  });

  it('rejects PostHog as a substitute primary source', () => {
    const evidence = buildD18RunEvidence({
      requestedWindow: WINDOW,
      runMode: 'live',
      primarySource: 'posthog',
      ga4Source: ga4Source(),
      ga4Rows: [ga4Row()],
      posthogSource: POSTHOG_BACKUP,
      posthogRows: [{ observed: 99, emissionId: 'posthog-only-id' }],
    });

    expect(evidence.status).toBe('blocked');
    expect(evidence.blockers).toContain('blocked: la sorgente primaria D18 deve essere GA4');
    expect(validateD18FirstRunEvidence({ requestedWindow: WINDOW, evidence }).ok).toBe(false);
  });
});
