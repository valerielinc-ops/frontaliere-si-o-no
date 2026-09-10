import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateApplicationEvidence,
  buildIdentityCatalog,
  buildDryRunPayload,
  buildInsightsDocuments,
  collapseTechnicalDuplicates,
  queryEventRows,
} from '../scripts/build-employer-insights.mjs';
import { validateEmployerInsightsPayload } from '../scripts/ci/validate-employer-insights-payload.mjs';
import {
  appendApplyClickEmissionId,
  decideApplyClickDedup,
} from '../services/publisherAnalyticsService';

const windowToDate = new Date();
windowToDate.setMilliseconds(0);
const windowFromDate = new Date(windowToDate);
windowFromDate.setUTCDate(windowFromDate.getUTCDate() - 31);
const WINDOW = {
  from: windowFromDate.toISOString(),
  to: windowToDate.toISOString(),
  kind: 'test',
  timezone: 'UTC',
};
const IN_WINDOW_TIMESTAMP = new Date(windowFromDate.getTime() + 60 * 60 * 1000).toISOString();
const OUTSIDE_WINDOW_TIMESTAMP = new Date(windowFromDate.getTime() - 1).toISOString();
const EMPLOYER_INSIGHTS_SOURCE = readFileSync(new URL('../scripts/build-employer-insights.mjs', import.meta.url), 'utf8');
const EMPLOYER_TRAFFIC_REPORT_SOURCE = readFileSync(new URL('../scripts/employer-traffic-report.mjs', import.meta.url), 'utf8');
const PUBLISHER_ANALYTICS_SOURCE = readFileSync(new URL('../services/publisherAnalyticsService.ts', import.meta.url), 'utf8');
const ANALYTICS_SOURCE = readFileSync(new URL('../services/analytics.ts', import.meta.url), 'utf8');
const JOB_BOARD_SOURCE = readFileSync(new URL('../components/community/JobBoard.tsx', import.meta.url), 'utf8');
const PUBLISHER_APPLY_FORM_SOURCE = readFileSync(new URL('../components/community/PublisherApplyForm.tsx', import.meta.url), 'utf8');

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    companyKey: 'acme',
    company: 'Acme SA',
    title: 'Role',
    slug: 'role-it',
    slugByLocale: { it: 'role-it', en: 'role-en', de: 'rolle-de', fr: 'poste-fr' },
    previousSlugs: ['role-old'],
    previousSlugsByLocale: { en: ['old-role-en'] },
    canton: 'TI',
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    event: 'job_apply',
    timestamp: IN_WINDOW_TIMESTAMP,
    jobSlug: 'role-it',
    observed: 1,
    persons: 1,
    sessions: 1,
    ...overrides,
  };
}

function build(rows: Array<Record<string, unknown>>, jobs = [job()], applicationEvidence = undefined) {
  const catalog = buildIdentityCatalog(jobs);
  return buildInsightsDocuments({
    eventRows: rows,
    catalog,
    window: WINDOW,
    applicationEvidence,
    generatedAt: WINDOW.to,
  });
}

function gatePayload(overrides: Record<string, unknown> = {}) {
  const payload = {
    schemaVersion: 2,
    generatedAt: WINDOW.to,
    source: 'posthog',
    window: WINDOW,
    coverage: {
      source: 'posthog',
      sourceObserved: 100,
      returned: 100,
      totalRows: 1,
      returnedRows: 1,
      pages: 1,
      queryHash: 'query-hash',
      snapshotId: 'snapshot-id',
      truncated: false,
    },
    documents: Array.from({ length: 9 }, (_, index) => ({
      companyKey: `company-${index}`,
      source: 'posthog',
      window: { ...WINDOW, inclusive: '[from,to)' },
      coverage: { source: 'posthog', observed: 1 },
      limits: {
        events: { returned: 100, truncated: false },
        adsSerialized: { limit: null, truncated: false },
      },
      provenance: {
        source: 'posthog',
        truncated: false,
        snapshotId: 'snapshot-id',
      },
    })),
    ...overrides,
  };
  return payload;
}

describe('employer insights event coverage', () => {
  it('rejects a truncated dry-run payload before write', () => {
    const result = validateEmployerInsightsPayload(
      gatePayload({ coverage: { ...gatePayload().coverage, truncated: true } }),
      { currentDocumentCount: 10, expectedSource: 'posthog' },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('coverage.truncated must be false');
  });

  it('rejects coverage below the 90% floor before write', () => {
    const result = validateEmployerInsightsPayload(
      gatePayload({ coverage: { ...gatePayload().coverage, returned: 89 } }),
      { currentDocumentCount: 10, expectedSource: 'posthog' },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('coverage returned/sourceObserved is below 90%');
  });

  it('rejects a payload without a declared source before write', () => {
    const payload = gatePayload();
    delete (payload as { source?: string }).source;
    delete (payload.coverage as { source?: string }).source;

    const result = validateEmployerInsightsPayload(payload, {
      currentDocumentCount: 10,
      expectedSource: 'posthog',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('payload.source must declare the expected source');
  });

  it('accepts a complete payload at the 90% coverage floor', () => {
    const result = validateEmployerInsightsPayload(gatePayload(), {
      currentDocumentCount: 10,
      expectedSource: 'posthog',
    });

    expect(result).toMatchObject({ ok: true, coverage: { returned: 100, sourceObserved: 100 } });
  });

  it('serializes a complete machine-readable dry-run envelope', () => {
    const [doc] = build([event({ eventKey: 'dry-run-event' })]);
    const payload = buildDryRunPayload({
      documents: [doc],
      generatedAt: WINDOW.to,
      source: 'posthog',
      window: WINDOW,
      queryCoverage: {
        pageSize: 10_000,
        sourceObserved: 1,
        totalRows: 1,
        returnedRows: 1,
        returned: 1,
        pages: 1,
        truncated: false,
        queryHash: 'query-hash',
        snapshotId: 'snapshot-id',
      },
    });

    expect(payload).toMatchObject({
      source: 'posthog',
      window: WINDOW,
      coverage: {
        source: 'posthog',
        sourceObserved: 1,
        totalRows: 1,
        returnedRows: 1,
        returned: 1,
        truncated: false,
      },
    });
    expect(payload.documents).toEqual([doc]);
  });

  it('normalizes query coverage aliases before validating the dry-run envelope', () => {
    const [doc] = build([event({ eventKey: 'normalized-dry-run-event' })]);
    const payload = buildDryRunPayload({
      documents: [doc],
      generatedAt: WINDOW.to,
      source: 'posthog',
      window: WINDOW,
      queryCoverage: {
        pageSize: 10_000,
        sourceObserved: 1,
        totalBeforeCut: 1,
        groupRowsBeforeCut: 1,
        rowsReturned: 1,
        returned: 1,
        pages: 1,
        truncated: false,
        queryHash: 'query-hash',
        snapshotId: 'snapshot-id',
      },
    });

    expect(payload.coverage).toMatchObject({
      sourceObserved: 1,
      totalRows: 1,
      returnedRows: 1,
      returned: 1,
      pages: 1,
      queryHash: 'query-hash',
      snapshotId: 'snapshot-id',
    });
    expect(validateEmployerInsightsPayload(payload, {
      currentDocumentCount: 1,
      expectedSource: 'posthog',
    })).toMatchObject({ ok: true });
  });

  it('serializes a zero-observed company instead of dropping the source state', () => {
    const [doc] = build([], [job()]);

    expect(doc).toMatchObject({
      companyKey: 'acme',
      coverage: { status: 'zero_observed', observed: 0, residualTotal: 0 },
      totals: { views: 0, applyClicks: 0, adsCount: 0 },
    });
    expect(doc.ads).toEqual([]);
  });

  it('keeps a keyed event with value zero as an observed event identity', () => {
    const [doc] = build([event({ eventKey: 'zero-event', observed: 0, clicks: 0 })]);

    expect(doc.coverage.observed).toBe(0);
    expect(doc.ads).toHaveLength(1);
    expect(doc.ads[0]).toMatchObject({ eventsObserved: 0, applyClicks: 0 });
  });

  it('creates an ad from an apply event even when no pageview exists', () => {
    const [doc] = build([event({ jobSlug: 'role-en' })]);

    expect(doc.totals.adsCount).toBe(1);
    expect(doc.ads).toHaveLength(1);
    expect(doc.ads[0]).toMatchObject({ views: 0, applyClicks: 1, eventsObserved: 1 });
  });

  it('excludes an event outside the explicit documentable window', () => {
    const [doc] = build([
      event({ timestamp: OUTSIDE_WINDOW_TIMESTAMP }),
      event({ timestamp: WINDOW.from }),
    ]);

    expect(doc.totals.applyClicks).toBe(1);
    expect(doc.coverage.observed).toBe(1);
    expect(doc.window).toMatchObject({ from: WINDOW.from, to: WINDOW.to });
  });

  it('serializes more than 100 ads and declares that no ad cap applies', () => {
    const jobs = Array.from({ length: 101 }, (_, index) => job({
      id: `job-${index}`,
      slug: `role-${index}`,
      slugByLocale: { it: `role-${index}` },
    }));
    const [doc] = build(jobs.map((j) => event({ jobSlug: j.slug })), jobs);

    expect(doc.ads).toHaveLength(101);
    expect(doc.totals.adsCount).toBe(101);
    expect(doc.limits.adsSerialized).toMatchObject({ limit: null, total: 101, truncated: false });
  });

  it('resolves current, historical and localized aliases to one ad identity', () => {
    const [doc] = build([
      event({ event: '$pageview', path: '/en/find-jobs-ticino/role-en/', jobSlug: '' }),
      event({ event: '$pageview', path: '/offerte-di-lavoro-ticino/old-role-en/', jobSlug: '' }),
      event({ jobSlug: 'rolle-de' }),
      event({ jobSlug: 'old-role-en' }),
    ]);

    expect(doc.ads).toHaveLength(1);
    expect(doc.ads[0]).toMatchObject({ jobId: 'job-1', views: 2, applyClicks: 2 });
    expect(doc.coverage.attributed).toBe(4);
  });

  it('resolves the historical prefixed company hub as an explicit alias', () => {
    const [doc] = build([event({ event: '$pageview', jobSlug: '', path: '/cerca-lavoro-ticino/azienda-acme/' })]);

    expect(doc).toMatchObject({
      companyKey: 'acme',
      totals: { views: 0, profileViews: 1, profileVisitors: 1, adsCount: 0 },
    });
    expect(doc.coverage.attributed).toBe(1);
  });

  it('counts a select_content/job_apply pair once when they share an emission id', () => {
    const [doc] = build([
      event({ event: 'job_apply', eventKey: 'job-event', emissionId: 'action-1' }),
      event({ event: 'select_content', eventKey: 'select-event', emissionId: 'action-1', contentType: 'job_board_apply' }),
    ]);

    expect(doc.totals.applyClicks).toBe(1);
    expect(doc.ads[0].applyClicks).toBe(1);
    expect(doc.coverage).toMatchObject({
      rawObserved: 2,
      observed: 1,
      technicalDuplicatesRemoved: 1,
      dedupUnavailable: 0,
      deduplication: { key: 'emission_id', status: 'available', unavailableCount: 0 },
    });
  });

  it('counts two actions with different emission ids as two events', () => {
    const result = collapseTechnicalDuplicates([
      event({ event: 'job_apply', eventKey: 'same-provider-key', emissionId: 'action-1' }),
      event({ event: 'select_content', eventKey: 'same-provider-key', emissionId: 'action-2', contentType: 'job_board_apply' }),
    ]);

    expect(result).toMatchObject({ observed: 2, removed: 0, dedupUnavailable: 0 });
  });

  it('does not fuse events without an emission id and marks dedup as unavailable', () => {
    const rows = [
      event({ event: 'job_apply', eventKey: 'same-provider-key', emissionId: '' }),
      event({ event: 'select_content', eventKey: 'same-provider-key', emissionId: '', contentType: 'job_board_apply' }),
    ];
    const result = collapseTechnicalDuplicates(rows);
    const [doc] = build(rows);

    expect(result).toMatchObject({ observed: 2, removed: 0, dedupUnavailable: 2 });
    expect(doc.coverage).toMatchObject({
      technicalDuplicatesRemoved: 0,
      dedupUnavailable: 2,
      deduplication: {
        key: 'emission_id',
        status: 'dedup non disponibile',
        unavailableCount: 2,
      },
    });
  });

  it('parses grouped query rows with the emission id after views and clicks', () => {
    const groupedRow = (eventName: string, eventKey: string) => [
      eventKey,
      eventName,
      '2026-09-01',
      '/offerte-di-lavoro-ticino/role-it/',
      'role-it',
      '',
      '',
      'acme',
      '',
      eventName === 'select_content' ? 'job_board_apply' : '',
      1,
      1,
      1,
      eventName === '$pageview' ? 1 : 0,
      eventName === 'select_content' || eventName === 'job_apply' ? 1 : 0,
      'action-array-1',
      '2026-09-01 12:00:00',
    ];
    const [doc] = build([
      groupedRow('job_apply', 'job-array-event'),
      groupedRow('select_content', 'select-array-event'),
    ]);

    expect(doc.totals.applyClicks).toBe(1);
    expect(doc.coverage).toMatchObject({ rawObserved: 2, observed: 1, technicalDuplicatesRemoved: 1 });
  });

  it('does not pick a company by substring when an explicit alias is ambiguous', () => {
    const jobs = [
      job({ id: 'job-acme', companyKey: 'acme', slug: 'shared-role' }),
      job({ id: 'job-omega', companyKey: 'omega', company: 'Omega SA', slug: 'shared-role' }),
    ];
    const [acme, omega] = build([event({ jobSlug: 'shared-role' })], jobs);

    expect(acme).toBeUndefined();
    expect(omega).toBeUndefined();
    const catalog = buildIdentityCatalog(jobs);
    expect(catalog.collisions.jobAliases).toBeGreaterThan(0);
  });

  it('keeps attributed plus residual event counts equal to observed events', () => {
    const [doc] = build([
      event({ jobSlug: 'role-it' }),
      event({ jobSlug: 'unknown-role' }),
      event({ event: 'scroll_depth', jobSlug: '', path: '' }),
    ]);

    const residualTotal = Object.values(doc.coverage.residuals as Record<string, number>).reduce((sum, value) => sum + value, 0);
    expect(doc.coverage.attributed + residualTotal).toBe(doc.coverage.observed);
    expect(doc.coverage.invariant).toBe(true);
    expect(doc.coverage.residuals).toMatchObject({ unknown_job_alias: 1, unidentified_event: 1 });
  });

  it('exposes applications and forwarding evidence without inventing delivery', () => {
    const applications = aggregateApplicationEvidence([
      {
        id: 'application-1',
        jobSlug: 'role-en',
        createdAt: new Date(windowFromDate.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        forwardedAt: new Date(windowFromDate.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      },
    ], { window: WINDOW, catalog: buildIdentityCatalog([job()]) });
    const [doc] = build([event({ jobSlug: 'role-en' })], [job()], applications);

    expect(doc.ads[0]).toMatchObject({
      applications: 1,
      forwardedAt: new Date(windowFromDate.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      delivery: 'non disponibile',
    });
    expect(doc.totals).not.toHaveProperty('lost');
  });
});

describe('employer insights technical deduplication', () => {
  it('retains the ad identity regardless of the arrival order of shared-emission rows', () => {
    const [doc] = build([
      event({
        event: 'select_content',
        eventKey: 'select-event',
        emissionId: 'action-order-independent',
        jobSlug: '',
        employerKey: '',
        itemId: 'acme_role-it',
        contentType: 'job_board_apply',
      }),
      event({
        event: 'job_apply',
        eventKey: 'job-event',
        emissionId: 'action-order-independent',
        jobSlug: 'role-it',
        employerKey: 'acme',
      }),
    ]);

    expect(doc.ads).toHaveLength(1);
    expect(doc.ads[0]).toMatchObject({ jobId: 'job-1', applyClicks: 1 });
    expect(doc.coverage).toMatchObject({ rawObserved: 2, observed: 1, technicalDuplicatesRemoved: 1 });
  });

  it('does not use the provider event key as a deduplication fallback', () => {
    const result = collapseTechnicalDuplicates([
      event({ eventKey: 'event-1', emissionId: '', observed: 2 }),
      event({ eventKey: 'event-1', emissionId: '', observed: 1 }),
    ]);

    expect(result.observed).toBe(3);
    expect(result.removed).toBe(0);
    expect(result.rawObserved).toBe(3);
    expect(result.dedupUnavailable).toBe(3);
  });

  it('does not use provider identifiers as a query cursor or emission fallback', () => {
    expect(EMPLOYER_INSIGHTS_SOURCE).not.toMatch(
      /EVENT_KEY_EXPRESSION|\$insert_id|\$event_id|\b(?:uuid|eventId|insert_id)\b/,
    );
  });

  it('keeps views and clicks separate from the emission id in grouped rows', () => {
    const result = collapseTechnicalDuplicates([[
      'pageview-event',
      '$pageview',
      '2026-09-01',
      '/offerte-di-lavoro-ticino/role-it/',
      'role-it',
      '',
      '',
      'acme',
      '',
      '',
      7,
      1,
      1,
      7,
      0,
      'action-array-1',
      '2026-09-01 12:00:00',
    ]]);

    expect(result.rows[0]).toMatchObject({ views: 7, clicks: 0, emissionId: 'action-array-1' });
  });

  it('uses keyset pagination for PostHog queries', () => {
    expect(EMPLOYER_INSIGHTS_SOURCE).not.toMatch(/LIMIT\s+\$\{EVENT_QUERY_PAGE_SIZE\}\s+OFFSET/);
    const fromPostHogSource = EMPLOYER_TRAFFIC_REPORT_SOURCE.slice(
      EMPLOYER_TRAFFIC_REPORT_SOURCE.indexOf('async function fromPostHog'),
      EMPLOYER_TRAFFIC_REPORT_SOURCE.indexOf('async function postHogSourceFrom'),
    );
    expect(fromPostHogSource).not.toContain('OFFSET');
  });

  it('advances event pages with a timestamp and grouped-field cursor', async () => {
    const groupedRow = (unusedSlot: string, timestamp: string) => [
      unusedSlot,
      'scroll_depth',
      '2026-09-01',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      1,
      1,
      1,
      0,
      0,
      '',
      timestamp,
      'scroll_depth',
      '2026-09-01',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ];
    const pageRows = [
      groupedRow('slot-a', '2026-09-01 12:00:00.000000'),
      groupedRow('slot-b', '2026-09-01 12:00:01.000000'),
      groupedRow('slot-c', '2026-09-01 12:00:02.000000'),
    ];
    const queries: string[] = [];
    const runQuery = async (query: string) => {
      queries.push(query);
      if (query.startsWith('SELECT count() AS total FROM (')) return [[3]];
      if (query.includes('SELECT count() AS total') && query.includes('FROM events')) return [[3]];
      if (!query.includes(' LIMIT 3')) throw new Error(`unexpected test query: ${query}`);
      const pageNumber = queries.filter((candidate) => candidate.includes(' LIMIT 3')).length;
      return pageNumber === 1 ? pageRows.slice(0, 2) : pageRows.slice(2);
    };

    const result = await queryEventRows(WINDOW, { query: runQuery, pageSize: 3 });
    const pageQueries = queries.filter((query) => query.includes(' LIMIT 3'));

    expect(result.rows.map((row) => row[0])).toEqual(['slot-a', 'slot-b', 'slot-c']);
    expect(result.coverage).toMatchObject({ pages: 2, rowsReturned: 3, truncated: false });
    expect(pageQueries.every((query) => !query.includes('OFFSET'))).toBe(true);
    expect(pageQueries[1]).toContain('timestamp >');
    expect(pageQueries[1]).toContain("2026-09-01 12:00:01.000000");
  });
});

describe('publisher apply-click deduplication', () => {
  it('keeps two real clicks distinct and drops only a repeated emission id', () => {
    const first = decideApplyClickDedup({ eventId: 'click-1' });
    const second = decideApplyClickDedup({ eventId: 'click-2' });
    const retry = decideApplyClickDedup({
      eventId: 'click-2',
      seenEventIds: ['click-1', 'click-2'],
    });

    expect(first).toMatchObject({ record: true, removed: 0, status: 'available' });
    expect(second).toMatchObject({ record: true, removed: 0, status: 'available' });
    expect(retry).toMatchObject({ record: false, removed: 1, status: 'available', reason: 'technical_duplicate' });
  });

  it('records a missing emission id without deduplicating and marks it unavailable', () => {
    expect(decideApplyClickDedup()).toMatchObject({
      record: true,
      removed: 0,
      unavailable: 1,
      status: 'dedup non disponibile',
      reason: 'dedup_unavailable',
    });
  });

  it('bounds the publisher emission ledger and marks overflow unavailable', () => {
    const existing = Array.from({ length: 64 }, (_, index) => `click-${index + 1}`);
    const next = appendApplyClickEmissionId(existing, 'click-65');

    expect(next).toMatchObject({ unavailable: 1 });
    expect(next.emissionIds).toHaveLength(64);
    expect(next.emissionIds[0]).toBe('click-2');
    expect(next.emissionIds.at(-1)).toBe('click-65');
  });

  it('passes a stable emission id at every publisher apply callsite', () => {
    const jobBoardCalls = [...JOB_BOARD_SOURCE.matchAll(/trackPublisherApplyClick\(([\s\S]*?)\)/g)].map((match) => match[1]);

    expect(jobBoardCalls).toHaveLength(5);
    expect(jobBoardCalls.every((call) => /\{\s*eventId\s*:/.test(call))).toBe(true);
    expect(PUBLISHER_APPLY_FORM_SOURCE).toMatch(/trackPublisherApplyClick\([\s\S]*?\{\s*eventId\s*:/);
  });

  it('uses one emission id for both employer apply signals', () => {
    expect(JOB_BOARD_SOURCE).toContain('createPublisherApplyEventId');
    expect(JOB_BOARD_SOURCE.match(/emission_id: eventId/g)).toHaveLength(2);
  });

  it('instruments page views and outbound clicks with the shared emission id', () => {
    expect(ANALYTICS_SOURCE).toContain('createAnalyticsEmissionId');
    expect(ANALYTICS_SOURCE).toMatch(/trackPageView:[\s\S]*?emission_id: emissionId/);
    expect(ANALYTICS_SOURCE).toMatch(/trackExternalLink:[\s\S]*?emission_id: emissionId/);
    expect(PUBLISHER_ANALYTICS_SOURCE).toContain('createAnalyticsEmissionId');
    expect(EMPLOYER_INSIGHTS_SOURCE).not.toMatch(/const dedupKey = row\.emissionId[\s\S]*row\.eventKey/);
    expect(PUBLISHER_ANALYTICS_SOURCE).not.toContain('APPLY_CLICK_DEDUP_WINDOW_MS');
  });
});
