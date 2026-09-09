import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateApplicationEvidence,
  buildIdentityCatalog,
  buildInsightsDocuments,
  collapseTechnicalDuplicates,
  queryEventRows,
} from '../scripts/build-employer-insights.mjs';
import {
  APPLY_CLICK_DEDUP_WINDOW_MS,
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

describe('employer insights event coverage', () => {
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
    expect(doc.coverage).toMatchObject({ rawObserved: 2, observed: 1, technicalDuplicatesRemoved: 1 });
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

  it('removes only repeated rows with the same explicit event key', () => {
    const result = collapseTechnicalDuplicates([
      event({ eventKey: 'event-1', observed: 2 }),
      event({ eventKey: 'event-2', observed: 1 }),
      event({ eventKey: '', observed: 2 }),
    ]);

    expect(result.observed).toBe(4);
    expect(result.removed).toBe(1);
    expect(result.rawObserved).toBe(5);
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

  it('advances event pages with a timestamp and event-key cursor', async () => {
    const groupedRow = (eventKey: string, timestamp: string) => [
      eventKey,
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
    ];
    const pageRows = [
      groupedRow('event-a', '2026-09-01 12:00:00.000000'),
      groupedRow('event-b', '2026-09-01 12:00:01.000000'),
      groupedRow('event-c', '2026-09-01 12:00:02.000000'),
    ];
    const queries: string[] = [];
    const runQuery = async (query: string) => {
      queries.push(query);
      if (query.startsWith('SELECT count() AS total FROM (')) return [[3]];
      if (query.includes('SELECT count() AS total') && query.includes('FROM events')) return [[3]];
      if (!query.includes(' LIMIT 2')) throw new Error(`unexpected test query: ${query}`);
      const pageNumber = queries.filter((candidate) => candidate.includes(' LIMIT 2')).length;
      return pageNumber === 1 ? pageRows.slice(0, 2) : pageRows.slice(2);
    };

    const result = await queryEventRows(WINDOW, { query: runQuery, pageSize: 2 });
    const pageQueries = queries.filter((query) => query.includes(' LIMIT 2'));

    expect(result.rows.map((row) => row[0])).toEqual(['event-a', 'event-b', 'event-c']);
    expect(result.coverage).toMatchObject({ pages: 2, rowsReturned: 3, truncated: false });
    expect(pageQueries.every((query) => !query.includes('OFFSET'))).toBe(true);
    expect(pageQueries[1]).toContain('timestamp >');
    expect(pageQueries[1]).toContain("event-b");
  });
});

describe('publisher apply-click deduplication', () => {
  it('keeps two real clicks distinct and drops only a keyed technical retry', () => {
    const first = decideApplyClickDedup({ eventId: 'click-1', nowMs: 1000 });
    const second = decideApplyClickDedup({ eventId: 'click-2', nowMs: 1200 });
    const retry = decideApplyClickDedup({
      eventId: 'click-2',
      previousEventId: 'click-2',
      previousEventAtMs: 1200,
      nowMs: 1200 + APPLY_CLICK_DEDUP_WINDOW_MS,
    });

    expect(first.record).toBe(true);
    expect(second.record).toBe(true);
    expect(retry).toMatchObject({ record: false, removed: 1, reason: 'technical_duplicate' });
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
});
