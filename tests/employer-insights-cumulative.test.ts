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
const J0 = '2026-09-09T00:00:00+02:00';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    companyKey: 'acme',
    company: 'Acme SA',
    title: 'Role',
    slug: 'role-it',
    slugByLocale: { it: 'role-it', en: 'role-en' },
    previousSlugs: ['role-old'],
    status: 'active',
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
      eligibleFrom: J0,
      firstCompleteIdentityAt: J0,
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

function company(payload: any, key = 'acme') {
  return payload?.companies?.find((entry: any) => entry.companyKey === key);
}

function currentMetric(payload: any, metric: string, key = 'acme') {
  return company(payload, key)?.metrics?.[metric]?.parts?.currentPrimary;
}

function adMetric(payload: any, metric: string, key = 'acme') {
  return company(payload, key)?.byAd?.[0]?.metrics?.[metric];
}

describe('D18 cumulativo — finestre e due regimi', () => {
  it('D18-T01 usa [from,to), conserva il cutoff e rispetta DST Europe/Zurich', async () => {
    const window = {
      from: '2026-10-24T00:00:00+02:00',
      to: '2026-10-26T00:00:00+01:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const result = await buildD18({
      requestedWindow: window,
      ga4Rows: [
        row({ timestamp: window.from, observed: 2 }),
        row({ timestamp: '2026-10-25T12:00:00+01:00', observed: 3 }),
        row({ timestamp: window.to, observed: 7 }),
      ],
    });

    expect(result.requestedWindow).toMatchObject(window);
    expect(result.cutoff).toBe(window.to);
    expect(currentMetric(result, 'adViews')).toMatchObject({ value: 5 });
    expect(result.windows?.trend?.to).toBe(window.to);
  });

  it('D18-T02 usa lo stesso cutoff per cumulativo, 30d, 90d e trend', async () => {
    const result = await buildD18();
    const windows = result.windows;

    expect(windows).toMatchObject({
      cumulative: { to: WINDOW.to },
      '30d': { to: WINDOW.to },
      '90d': { to: WINDOW.to },
      trend: { to: WINDOW.to, kind: 'trend' },
    });
    expect(windows?.trend).not.toHaveProperty('days');
    expect(result.snapshotId).toBeTruthy();
  });

  it('D18-T03 non attribuisce GA4 prima di J0 o prima di Jmetric', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ timestamp: '2026-09-08T21:00:00.000Z', observed: 11 }),
        row({ timestamp: '2026-09-08T23:30:00.000Z', observed: 13, employerKey: 'acme', jobSlug: 'role-it' }),
        row({ timestamp: '2026-09-09T03:00:00.000Z', observed: 17, employerKey: 'acme', jobSlug: 'role-it' }),
      ],
      ga4Source: sourceMeta({
        identityCoverage: {
          eligibleFrom: J0,
          completeThrough: WINDOW.to,
          firstCompleteIdentityAt: '2026-09-09T02:00:00+02:00',
          status: 'complete',
        },
      }),
    });

    expect(currentMetric(result, 'adViews')).toMatchObject({ value: 17 });
    expect(result.globalResiduals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'historical_route_unresolved', count: expect.objectContaining({ value: 24 }) }),
    ]));
    expect(result.companies).toHaveLength(1);

    const noJmetric = await buildD18({
      ga4Rows: [row()],
      ga4Source: sourceMeta({ identityCoverage: { firstCompleteIdentityAt: null } }),
    });
    expect(currentMetric(noJmetric, 'adViews')).toMatchObject({ value: null, status: 'non disponibile' });
  });

  it('D18-T04 distingue both, GA4-only, PostHog-only, gap e frontiere parziali', async () => {
    const result = await contractCall('buildCoverageMatrix', {
      requestedWindow: WINDOW,
      daily: [
        { day: '2026-06-11', ga4: { queried: true, available: true }, posthog: { queried: true, available: true } },
        { day: '2026-06-12', ga4: { queried: true, available: true, partial: true }, posthog: { queried: true, available: false } },
        { day: '2026-06-13', ga4: { queried: true, available: false }, posthog: { queried: true, available: true } },
        { day: '2026-06-14', ga4: { queried: true, available: false }, posthog: { queried: true, available: false } },
        { day: '2026-06-15', ga4: { queried: false }, posthog: { queried: false } },
      ],
    });

    expect(result.both).toEqual(['2026-06-11']);
    expect(result.ga4Only).toEqual(['2026-06-12']);
    expect(result.posthogOnly).toEqual(['2026-06-13']);
    expect(result.neither).toBeNull();
    expect(result.status).toBe('non disponibile');
    expect(result.partial.ga4).toContain('2026-06-12');
  });

  it('D18-T05 affianca 612764 e 170273 senza sommarli', async () => {
    const result = await contractCall('buildCompositeMetric', {
      window: WINDOW,
      unit: 'events',
      historicalBackup: {
        value: 170273,
        unit: 'events',
        source: 'posthog',
        window: WINDOW,
        status: 'parziale',
      },
      currentPrimary: {
        value: 612764,
        unit: 'events',
        source: 'ga4',
        window: WINDOW,
        status: 'observed',
      },
    });

    expect(result).toMatchObject({
      value: null,
      unit: 'composite_two_regimes',
      source: 'composite',
      status: 'non sommabile fra regimi',
      parts: {
        historicalBackup: { value: 170273 },
        currentPrimary: { value: 612764 },
      },
    });
    expect(result.value).not.toBe(783037);
  });

  it('D18-T06 chiude PostHog in partial con OFFSET 400 e keyset interrotto', async () => {
    const offsetResult = await contractCall('buildPosthogRegime', {
      window: WINDOW,
      observed: 170273,
      response: { offsetStatus: 400, rowsReturned: 100, totalRows: 100, pages: 2, cursorAdvanced: true },
    });

    expect(offsetResult.status).toBe('parziale');
    expect(offsetResult.denominator).toMatchObject({ value: null, status: 'non provato' });
    expect(offsetResult.value).toBe(170273);
    expect(offsetResult.coverage.truncated).toBe(true);

    const cursorResult = await contractCall('buildPosthogRegime', {
      window: WINDOW,
      observed: 170273,
      response: { offsetStatus: 200, rowsReturned: 60, totalRows: 100, pages: 2, cursorAdvanced: false },
    });
    expect(cursorResult.status).toBe('parziale');
    expect(cursorResult.coverage.truncated).toBe(true);
  });

  it('D18-T07 non applica SAMPLE/default o fattori di espansione a PostHog', async () => {
    const result = await contractCall('buildPosthogMetric', {
      window: WINDOW,
      observed: 170273,
      sample: 'SAMPLE 0.1',
      budgetInsufficient: true,
    });

    expect(result).toMatchObject({ value: 170273, status: 'parziale' });
    expect(result.denominator.status).toBe('non provato');
    expect(result).not.toHaveProperty('expansionFactor');
    expect(result.value).not.toBe(1702730);
  });

  it('D18-T08 separa assente, zero osservato, query fallita e query troncata', async () => {
    const make = (input: Record<string, unknown>) => contractCall('metricFromObservation', {
      unit: 'events',
      source: 'ga4',
      window: WINDOW,
      ...input,
    });
    const [missing, zero, failed, partial] = await Promise.all([
      make({ fieldPresent: false, querySucceeded: true, value: null }),
      make({ fieldPresent: true, querySucceeded: true, value: 0, complete: true }),
      make({ fieldPresent: true, querySucceeded: false, value: 9 }),
      make({ fieldPresent: true, querySucceeded: true, value: 9, truncated: true }),
    ]);

    expect(missing).toMatchObject({ value: null, status: 'non disponibile' });
    expect(zero).toMatchObject({ value: 0, status: 'zero osservato' });
    expect(failed).toMatchObject({ value: null, status: 'sorgente non disponibile' });
    expect(partial).toMatchObject({ value: 9, status: 'parziale' });
    expect(new Set([missing.status, zero.status, failed.status, partial.status]).size).toBe(4);
  });

  it('D18-T09 separa page_view di dettaglio da ad_impression di lista', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ event: 'page_view', pageTemplate: 'job_detail', observed: 2 }),
        row({ event: 'ad_impression', pageTemplate: 'jobs_index', observed: 3 }),
      ],
    });

    expect(adMetric(result, 'adViews')).toMatchObject({ parts: { currentPrimary: { value: 2 } } });
    expect(adMetric(result, 'listExposures')).toMatchObject({ parts: { currentPrimary: { value: 3 } } });
    expect(adMetric(result, 'adViews').parts.currentPrimary.value).not.toBe(5);
  });

  it('D18-T10 tiene profileVisits distinto da adViews', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ event: 'page_view', pageTemplate: 'job_detail', observed: 2 }),
        row({ event: 'page_view', pageTemplate: 'jobs_company', jobSlug: '', page: '/azienda/acme/', observed: 4 }),
      ],
    });

    expect(currentMetric(result, 'adViews')).toMatchObject({ value: 2 });
    expect(currentMetric(result, 'profileVisits')).toMatchObject({ value: 4 });
    expect(result.companies[0].byAd[0].metrics.profileVisits.parts.currentPrimary.value).not.toBe(4);
  });

  it('D18-T11 separa outbound, CTA apply, select generico e window.open', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ event: 'outbound_click', observed: 5 }),
        row({ event: 'job_apply', observed: 3 }),
        row({ event: 'select_content', contentType: 'generic', observed: 7 }),
        row({ event: 'window.open', observed: 11 }),
      ],
    });

    expect(currentMetric(result, 'outboundClicks')).toMatchObject({ value: 5 });
    expect(currentMetric(result, 'candidateButtonClicks')).toMatchObject({ value: 3 });
    expect(result.companies[0].applications.submitted.value).toBeNull();
    expect(result.globalResiduals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'unsupported_event', count: expect.objectContaining({ value: 18 }) }),
    ]));
  });

  it('D18-T12 emette un annuncio click-only senza trasformare le view mancanti in zero', async () => {
    const result = await buildD18({
      ga4Rows: [row({ event: 'job_apply', observed: 2, pageTemplate: '', visitorId: '' })],
    });

    expect(result.companies).toHaveLength(1);
    expect(result.companies[0].byAd).toHaveLength(1);
    expect(adMetric(result, 'candidateButtonClicks')).toMatchObject({ parts: { currentPrimary: { value: 2 } } });
    expect(adMetric(result, 'adViews').parts.currentPrimary).toMatchObject({ value: null, status: 'non disponibile' });
  });

  it('D18-T13 fa la union degli identificatori tra annunci e locali', async () => {
    const result = await buildD18({
      ga4Rows: [
        row({ jobSlug: 'role-it', locale: 'it', visitorId: 'same-visitor' }),
        row({ jobSlug: 'role-en', locale: 'en', visitorId: 'same-visitor' }),
        row({ jobSlug: 'role-it', locale: 'it', visitorId: 'second-visitor' }),
      ],
      catalog: builder.buildIdentityCatalog([
        job({ slugByLocale: { it: 'role-it', en: 'role-en' } }),
      ]),
    });

    expect(currentMetric(result, 'identifiableUniqueVisitors')).toMatchObject({ value: 2 });
    expect(currentMetric(result, 'identifiableUniqueVisitors').unit).toBe('identifiers');
    expect(currentMetric(result, 'identifiableUniqueVisitors').identity.precision).not.toBe('human_exact');
  });

  it('D18-T14 conta solo application document con ID e deduplica l ID', async () => {
    const result = await buildD18({
      ga4Rows: [row({ event: 'job_apply', observed: 4 })],
      applicationRecords: [
        { applicationId: 'app-1', jobId: 'job-1', createdAt: '2026-09-09T01:00:00.000Z' },
        { applicationId: 'app-1', jobId: 'job-1', createdAt: '2026-09-09T01:00:00.000Z' },
        { jobId: 'job-1', createdAt: '2026-09-09T01:00:00.000Z' },
      ],
    });

    expect(result.companies[0].applications.submitted).toMatchObject({ value: 1, unit: 'applications' });
    expect(result.companies[0].applications.submitted.value).not.toBe(5);
    expect(result.companies[0].applications.submitted.value).not.toBe(2);
  });

  it('D18-T15 separa forwarded, delivered e failed e non inventa delivery senza receipt', async () => {
    const result = await buildD18({
      applicationRecords: [
        { applicationId: 'app-forwarded', jobId: 'job-1', createdAt: '2026-09-09T00:30:00.000Z', forwardedAt: '2026-09-09T01:00:00.000Z' },
        { applicationId: 'app-delivered', jobId: 'job-1', createdAt: '2026-09-09T00:30:00.000Z', forwardedAt: '2026-09-09T01:00:00.000Z', deliveryReceipt: { applicationId: 'app-delivered' } },
        { applicationId: 'app-failed', jobId: 'job-1', createdAt: '2026-09-09T00:30:00.000Z', failedAt: '2026-09-09T01:00:00.000Z', failureReceipt: { applicationId: 'app-failed' } },
      ],
    });
    const applications = result.companies[0].applications;

    expect(applications.forwarded).toMatchObject({ value: 2 });
    expect(applications.delivered).toMatchObject({ value: 1 });
    expect(applications.failed).toMatchObject({ value: 1 });
    expect(applications.delivered.value).not.toBe(2);
  });
});
