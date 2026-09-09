import { describe, expect, it } from 'vitest';
import {
  aggregateApplicationEvidence,
  buildIdentityCatalog,
  buildInsightsDocuments,
  collapseTechnicalDuplicates,
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

    expect(doc).toMatchObject({ companyKey: 'acme', totals: { views: 1, adsCount: 0 } });
    expect(doc.coverage.attributed).toBe(1);
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
});
