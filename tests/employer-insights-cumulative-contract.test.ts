import { describe, expect, it } from 'vitest';

import * as builder from '../scripts/build-employer-insights.mjs';
import * as contract from '../scripts/lib/employer-insights-cumulative-contract.mjs';

const WINDOW = {
  from: '2026-06-11T00:00:00+02:00',
  to: '2026-09-10T00:00:00+02:00',
  timezone: 'Europe/Zurich',
  inclusive: '[from,to)',
};
const GENERATED_AT = '2026-09-10T06:00:00.000Z';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    companyKey: 'acme',
    company: 'Acme SA',
    title: 'Role',
    slug: 'role-it',
    slugByLocale: { it: 'role-it', en: 'role-en' },
    previousSlugs: ['role-old'],
    status: 'expired',
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    event: 'page_view',
    timestamp: '2026-09-09T10:00:00.000Z',
    employerKey: 'acme',
    jobSlug: 'role-it',
    pageTemplate: 'job_detail',
    locale: 'it',
    observed: 1,
    visitorId: 'visitor-1',
    ...overrides,
  };
}

function sourceMeta(overrides: Record<string, unknown> = {}) {
  return {
    sourceCoverage: {
      coverageStart: '2026-06-11T00:00:00+02:00',
      coverageEnd: WINDOW.to,
      completeThrough: WINDOW.to,
      gaps: [],
      status: 'complete',
      queried: true,
      ...((overrides.sourceCoverage as Record<string, unknown>) || {}),
    },
    identityCoverage: {
      eligibleFrom: '2026-09-09T00:00:00+02:00',
      firstCompleteIdentityAt: '2026-09-09T00:00:00+02:00',
      completeThrough: WINDOW.to,
      gaps: [],
      status: 'complete',
      ...((overrides.identityCoverage as Record<string, unknown>) || {}),
    },
    denominator: {
      value: 100,
      unit: 'events',
      source: 'fixture',
      status: 'provato',
      ...((overrides.denominator as Record<string, unknown>) || {}),
    },
    sourceSnapshot: 'fixture-source-snapshot',
    queryHash: 'fixture-query-hash',
    ...overrides,
  };
}

async function buildD18(options: Record<string, unknown> = {}) {
  const applicationsSource = Array.isArray(options.applicationRecords)
    ? sourceMeta({ sourceSnapshot: 'applications-fixture-snapshot' })
    : sourceMeta({ sourceCoverage: { queried: false, status: 'sorgente non disponibile' }, status: 'sorgente non disponibile', sourceSnapshot: 'applications-unavailable-fixture' });
  return builder.buildCumulativeInsightsPayload({
    requestedWindow: WINDOW,
    generatedAt: GENERATED_AT,
    catalog: builder.buildIdentityCatalog([job()]),
    ga4Source: sourceMeta({ sourceSnapshot: 'ga4-fixture-snapshot' }),
    posthogSource: sourceMeta({ denominator: { value: null, status: 'non provato' }, sourceSnapshot: 'posthog-fixture-snapshot' }),
    applicationsSource,
    deliverySource: sourceMeta({ sourceSnapshot: 'delivery-fixture-snapshot' }),
    sourceSnapshot: {
      ga4: 'ga4-fixture-snapshot',
      posthog: 'posthog-fixture-snapshot',
      applications: applicationsSource.sourceSnapshot,
      delivery: 'delivery-fixture-snapshot',
    },
    ...options,
  });
}

async function contractCall(name: string, ...args: unknown[]) {
  const fn = (contract as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`missing contract export: ${name}`);
  return fn(...args);
}

describe('D18 cumulativo — identità, ledger e contratto', () => {
  it('D18-T16 risolve alias/previousSlug, conserva collisioni e non usa substring', async () => {
    const jobs = [
      job({ id: 'job-old', slug: 'canonical-role', previousSlugs: ['previous-role'] }),
      job({ id: 'job-collision', companyKey: 'omega', company: 'Omega SA', slug: 'previous-role' }),
      job({ id: 'job-history-only', companyKey: 'history', company: 'History SA', slug: 'history-role', status: 'archived' }),
    ];
    const result = await buildD18({
      catalog: builder.buildIdentityCatalog(jobs),
      ga4Rows: [
        row({ jobSlug: 'previous-role', jobId: 'job-old', observed: 2 }),
        row({ jobSlug: 'previous-role', jobId: '', employerKey: '', observed: 3 }),
        row({ jobSlug: 'history-role', employerKey: 'history', observed: 4 }),
      ],
    });

    const old = result.companies.find((entry: any) => entry.companyKey === 'acme');
    const history = result.companies.find((entry: any) => entry.companyKey === 'history');
    expect(old.byAd[0].canonicalSlug).toBe('canonical-role');
    expect(history.byAd[0].canonicalSlug).toBe('history-role');
    expect(result.globalResiduals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(/ambiguous|unknown/) }),
    ]));
  });

  it('D18-T17 conserva traffico scaduto/rimosso e separa statusAtEvent da currentStatus', async () => {
    const result = await buildD18({
      ga4Rows: [row({ statusAtEvent: 'active', observed: 6 })],
      catalog: builder.buildIdentityCatalog([
        job({ status: 'removed', currentStatus: 'removed' }),
      ]),
    });
    const ad = result.companies[0].byAd[0];

    expect(ad.metrics.adViews.parts.currentPrimary.value).toBe(6);
    expect(ad.statusAtEvent).toBe('active');
    expect(ad.currentStatus).toBe('removed');
  });

  it('D18-T18 non certifica LIMIT/cap, (other) o paginazione incompleta come complete', async () => {
    const result = await buildD18({
      ga4Source: sourceMeta({
        sourceCoverage: { totalRows: 1001, rowsReturned: 1000, pages: 1, truncated: true, dataLossFromOtherRow: true },
      }),
      ga4Rows: Array.from({ length: 101 }, (_, index) => row({
        jobSlug: 'role-it',
        emissionId: `emission-${index}`,
      })),
      validate: false,
    });

    expect(result.provenance.limitState).toBe('parziale, mai complete');
    expect(result.sourceRegimes.ga4.sourceCoverage.truncated).toBe(true);
    expect(result.sourceRegimes.ga4.sourceCoverage.totalRows).toBe(1001);
    expect(result.provenance.limitState).not.toBe('complete');
  });

  it('D18-T19 deduplica solo emission_id e mantiene due click reali', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ event: 'job_apply', emissionId: 'same-emission', observed: 1 }),
        row({ event: 'select_content', contentType: 'job_board_apply', emissionId: 'same-emission', observed: 1 }),
        row({ event: 'job_apply', emissionId: 'real-click-2', observed: 1 }),
        row({ event: 'job_apply', emissionId: '', observed: 1 }),
        row({ event: 'job_apply', emissionId: '', observed: 1 }),
      ],
    });
    const metric = result.companies[0].metrics.candidateButtonClicks;

    expect(metric.value).toBeNull();
    expect(metric.parts.currentPrimary.value).toBe(4);
    expect(result.globalResiduals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'technical_duplicate', count: expect.objectContaining({ value: 1 }) }),
    ]));
    expect(metric.dedupe.removed).toBe(1);
  });

  it('D18-T20 chiude attributed + residui sullo stesso snapshot', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ observed: 2 }),
        row({ jobSlug: 'unknown-role', employerKey: '', observed: 3 }),
        row({ event: 'window.open', employerKey: '', jobSlug: '', observed: 4 }),
        row({ event: 'page_view', emissionId: 'same', observed: 1 }),
        row({ event: 'page_view', emissionId: 'same', observed: 1 }),
      ],
      validate: false,
    });
    const ledger = result.reconciliation.ga4;

    expect(ledger.attributed.value + ledger.residualTotal.value).toBe(ledger.observed.value);
    expect(ledger.technicalDuplicatesRemoved.value).toBe(1);
    expect(result.globalResiduals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'unknown_job_alias', count: expect.objectContaining({ value: 3 }) }),
      expect.objectContaining({ reason: 'unidentified_event', count: expect.objectContaining({ value: 4 }) }),
    ]));
  });

  it('D18-T21 mantiene free, sponsored e unknown separati', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ isSponsored: false, observed: 2 }),
        row({ isSponsored: true, observed: 3 }),
        row({ isSponsored: undefined, sponsored: undefined, observed: 4 }),
      ],
    });
    const classes = result.companies[0].bySponsored.map((entry: any) => entry.class);

    expect(classes).toEqual(expect.arrayContaining(['free', 'sponsored', 'unknown']));
    expect(result.companies[0].bySponsored.find((entry: any) => entry.class === 'unknown').metrics.adViews.parts.currentPrimary.value).toBe(4);
    expect(result.companies[0].bySponsored.find((entry: any) => entry.class === 'free').metrics.adViews.parts.currentPrimary.value).toBe(2);
  });

  it('D18-T22 non somma totalUsers HLL++ e usa solo la union di identità mock', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ totalUsers: 7, visitorId: 'u-1' }),
        row({ totalUsers: 8, visitorId: 'u-1' }),
        row({ totalUsers: 9, visitorId: 'u-2' }),
      ],
    });
    const metric = result.companies[0].metrics.identifiableUniqueVisitors;

    expect(metric.parts.currentPrimary.value).toBe(2);
    expect(metric.parts.currentPrimary.value).not.toBe(24);
    expect(metric.parts.currentPrimary.identity.method).toContain('union');
    expect(metric.parts.currentPrimary.identity.precision).not.toBe('HLL++ report-level exact');
  });

  it('D18-T23 propaga snapshot, finestra, sorgente e stato in ogni strato del payload owned', async () => {
    const result = await buildD18({ ga4Rows: [row()] });
    const contract = await contractCall('validateD18Payload', result);

    expect(contract.ok).toBe(true);
    expect(result.provenance.snapshotId).toBe(result.snapshotId);
    expect(result.requestedWindow).toMatchObject(WINDOW);
    expect(result.periodTotal.metrics.adViews).toMatchObject({
      value: null,
      unit: 'composite_two_regimes',
      source: 'composite',
      status: 'non sommabile fra regimi',
    });
    expect(JSON.stringify(result)).not.toContain('84');
  });

  it('D18-T24 resume da checkpoint non duplica e preserva snapshot verificato su risposta vuota', async () => {
    const pages = [
      { rows: [{ id: 'a' }], nextCursor: 'a', hasNext: true },
      { rows: [{ id: 'b' }], nextCursor: 'b', hasNext: true },
      { rows: [], nextCursor: null, hasNext: false },
    ];
    let calls = 0;
    const first = await contractCall('collectD18Pages', {
      fetchPage: async () => {
        const page = pages[calls];
        calls += 1;
        if (calls === 2) throw new Error('interrupted after page');
        return page;
      },
      lastVerified: { snapshotId: 'verified', rows: [{ id: 'a' }] },
    });
    const resumed = await contractCall('collectD18Pages', {
      fetchPage: async ({ cursor }: { cursor: string | null }) => cursor === 'a' ? pages[1] : pages[2],
      checkpoint: first.checkpoint,
      lastVerified: { snapshotId: 'verified', rows: [{ id: 'a' }] },
    });

    expect(first.status).toBe('parziale');
    expect(resumed.rows.map((entry: any) => entry.id)).toEqual(['a', 'b']);
    expect(new Set(resumed.rows.map((entry: any) => entry.id)).size).toBe(2);
    expect(resumed.lastVerified.snapshotId).toBe('verified');
  });

  it('D18-T25 rifiuta credentiale assente/cross-company e non serializza t', async () => {
    const safe = await contractCall('authorizeD18Request', {
      credential: null,
      credentialCompanyKey: 'other-company',
      requestedCompanyKey: 'acme',
      redactedToken: '<TOKEN_REDATTO>',
    });
    const sanitized = await contractCall('sanitizeD18Secrets', {
      url: 'https://example.invalid/insights?t=<TOKEN_REDATTO>',
      companyKey: 'other-company',
    });

    expect(safe.ok).toBe(false);
    expect(safe.reason).toMatch(/credential|company/i);
    expect(JSON.stringify(sanitized)).not.toContain('<TOKEN_REDATTO>');
    expect(JSON.stringify(sanitized)).not.toContain('?t=');
  });

  it('D18-T26 il validatore attraversa breakdown e rifiuta contatori nudi o missing serializzato 0', async () => {
    const result = await buildD18({ ga4Rows: [row()] });
    const valid = await contractCall('validateD18Payload', result);
    const naked = structuredClone(result);
    naked.companies[0].byLocale[0].metrics.adViews = 0;
    const invalid = await contractCall('validateD18Payload', naked);

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toMatch(/MetricValue|unit|status|denominator|zero/i);
  });
});
