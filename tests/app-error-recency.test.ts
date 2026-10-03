/**
 * Recency + production-host contract shared by the writer of
 * `errorHealth.appErrors` (scripts/analytics-report.mjs) and its reader
 * (scripts/app-error-issue-sync.mjs), plus the client predicate that stops
 * non-production hosts from emitting GA4 error events at all (the behaviour
 * of the emitter itself is in tests/app-error-client-host.test.ts).
 *
 * Failure title: «Feeder app-error: issue riconfermata senza eventi negli
 * ultimi 7 giorni».
 */
import { describe, expect, it } from 'vitest';

import {
  APP_ERROR_ENTRY_DIMENSIONS,
  PRODUCTION_HOST_REGEXP,
  buildAppErrorRecencyRequest,
  fetchAppErrorsWithRecency,
  groupChunkLoadFamily,
  isChunkLoadFamily,
  isProductionHost,
  mergeAppErrorRecency,
  productionAppErrorFilter,
  recentCutoff,
} from '../scripts/lib/app-error-recency.mjs';
import { fetchGa4ErrorEntries } from '../scripts/lib/ga4-service-account.mjs';
import { GA4_ERROR_EVENTS, isNonProductionTelemetryHost } from '../services/nonProductionHost';

const TODAY = '2026-01-31';
const compact = (d: string) => d.replace(/-/g, '');
const row = (type: string, message: string, page: string, host: string, date: string, n: number) => ({
  dimensionValues: [type, message, page, host, compact(date)].map((value) => ({ value })),
  metricValues: [{ value: String(n) }],
});
const entry = (message: string, extra: Record<string, unknown> = {}) => ({
  errorType: 'TypeError', errorMessage: message, pagePath: '/it/', hostName: 'frontaliereticino.ch', count: 129, users: 40, ...extra,
});

describe('production host', () => {
  it.each(['frontaliereticino.ch', 'cdn.frontaliereticino.ch', 'FrontaliereTicino.ch', 'frontaliereticino.ch:443'])(
    'accepts %s', (host) => expect(isProductionHost(host)).toBe(true),
  );

  it.each(['127.0.0.1', '127.0.0.1:3000', 'localhost', 'frontaliere-ticino.firebaseapp.com', 'evilfrontaliereticino.ch', 'frontaliereticino.ch.evil.io', ''])(
    'rejects %s', (host) => expect(isProductionHost(host)).toBe(false),
  );

  it('the GA4 filter asks for the event AND the production host, as a full regexp', () => {
    const { andGroup } = productionAppErrorFilter('app_error');
    expect(andGroup.expressions).toEqual([
      { filter: { fieldName: 'eventName', stringFilter: { value: 'app_error', matchType: 'EXACT' } } },
      { filter: { fieldName: 'hostName', stringFilter: { value: PRODUCTION_HOST_REGEXP, matchType: 'FULL_REGEXP' } } },
    ]);
  });
});

describe('fetchAppErrorsWithRecency — the three GA4 requests behind errorHealth.appErrors', () => {
  const baseRequest = { dateRanges: [{ startDate: '2026-01-01', endDate: TODAY }] };
  const mainRow = (type: string, message: string, n: number) => ({
    dimensionValues: [type, message, '/it/', 'frontaliereticino.ch'].map((value) => ({ value })),
    metricValues: [{ value: String(n) }, { value: '7' }],
  });
  /** Answers each request in order; records the bodies GA4 would receive. */
  const fakeGa4 = (answers: Array<{ ok?: boolean; rows?: unknown[]; rowCount?: number } | Error>) => {
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const answer = answers[bodies.length];
      bodies.push(JSON.parse(init.body));
      if (answer instanceof Error) throw answer;
      return { ok: answer.ok ?? true, json: async () => ({ rows: answer.rows ?? [], rowCount: answer.rowCount ?? (answer.rows ?? []).length }) };
    };
    return { bodies, fetchImpl };
  };
  const run = (fetchImpl: unknown) => fetchAppErrorsWithRecency({ fetchImpl, url: 'https://ga4.test/runReport', headers: {}, baseRequest });

  it('asks for app_error on the production host, then dates exactly those entries', async () => {
    const { bodies, fetchImpl } = fakeGa4([
      { rows: [mainRow('TypeError', 'live', 40)] },
      { rows: [row('TypeError', 'live', '/it/', 'frontaliereticino.ch', '2026-01-30', 6), row('TypeError', 'live', '/it/', 'frontaliereticino.ch', '2026-01-05', 34)] },
    ]);
    const out = await run(fetchImpl);
    expect(bodies.map((b) => b.dimensionFilter)).toEqual([
      productionAppErrorFilter('app_error'),
      productionAppErrorFilter('app_error', { messages: ['live'] }),
    ]);
    expect(bodies[0].dimensions).toEqual(APP_ERROR_ENTRY_DIMENSIONS);
    expect(out.appErrors).toEqual([
      { errorType: 'TypeError', errorMessage: 'live', pagePath: '/it/', hostName: 'frontaliereticino.ch', count: 40, users: 7, last7d: 6, lastSeen: '2026-01-30' },
    ]);
    expect(out.recency).toEqual({ status: 'ok', days: 7, since: '2026-01-24' });
  });

  it('falls back to `exception` on the same host filter; an empty error_type still finds its recency rows', async () => {
    const { bodies, fetchImpl } = fakeGa4([
      { rows: [] },
      { rows: [mainRow('', 'boom', 40)] },
      { rows: [row('', 'boom', '/it/', 'frontaliereticino.ch', '2026-01-30', 40)] },
    ]);
    const out = await run(fetchImpl);
    expect(bodies.map((b) => b.dimensionFilter)).toEqual([
      productionAppErrorFilter('app_error'),
      productionAppErrorFilter('exception'),
      productionAppErrorFilter('exception', { messages: ['boom'] }),
    ]);
    expect(out.appErrors[0]).toMatchObject({ errorType: 'exception', count: 40, last7d: 40, lastSeen: '2026-01-30' });
  });

  it.each([
    ['throws', new Error('network')],
    ['answers non-ok', { ok: false }],
  ])('a recency query that %s leaves the entries unmeasured (fail-open), never zero', async (_label, answer) => {
    const { fetchImpl } = fakeGa4([{ rows: [mainRow('TypeError', 'live', 40)] }, answer]);
    const out = await run(fetchImpl);
    expect(out.recency?.status).toBe('unavailable');
    expect(out.appErrors[0]).toMatchObject({ count: 40 });
    expect(out.appErrors[0]).not.toHaveProperty('last7d');
  });

  it('no entries at all: no recency request, no recency block', async () => {
    const { bodies, fetchImpl } = fakeGa4([{ rows: [] }, { rows: [] }]);
    const out = await run(fetchImpl);
    expect(out).toEqual({ appErrors: [], recency: null });
    expect(bodies).toHaveLength(['app_error', 'exception'].length);
  });
});

describe('PostHog monitor GA4 fallback (fetchGa4ErrorEntries) — same host rule', () => {
  it('asks GA4 for the production host on both app_error and its exception fallback', async () => {
    const bodies: Array<{ dimensionFilter: unknown }> = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ rows: [] }) };
    };
    await fetchGa4ErrorEntries({ token: 't', startDate: '2026-01-24', endDate: TODAY, fetchImpl });
    expect(bodies.map((b) => b.dimensionFilter)).toEqual([
      productionAppErrorFilter('app_error'),
      productionAppErrorFilter('exception'),
    ]);
  });
});

describe('recency request', () => {
  it('dates the entries already in appErrors: same dimensions + date, newest first, their messages only', () => {
    const dateRanges = [{ startDate: '2026-01-01', endDate: TODAY }];
    const req = buildAppErrorRecencyRequest({
      eventName: 'app_error',
      entries: [entry('a'), entry('a', { pagePath: '/it/x/' }), entry('b')],
      dateRanges,
    });
    expect(req.dateRanges).toBe(dateRanges);
    expect(req.dimensions).toEqual([...APP_ERROR_ENTRY_DIMENSIONS, { name: 'date' }]);
    expect(req.orderBys).toEqual([{ dimension: { dimensionName: 'date' }, desc: true }]);
    const messageFilter = req.dimensionFilter.andGroup.expressions.at(-1);
    expect(messageFilter.filter.fieldName).toBe('customEvent:error_message');
    expect(messageFilter.filter.inListFilter.values).toEqual(['a', 'b']);
  });
});

describe('mergeAppErrorRecency', () => {
  it('cutoff is 7 days before the report day', () => {
    expect(recentCutoff(TODAY)).toBe('20260124');
    expect(recentCutoff('2026-03-03')).toBe('20260224');
  });

  it('an old spike gets last7d 0 and the day it was last seen', () => {
    const rows = [row('TypeError', 'spike', '/it/', 'frontaliereticino.ch', '2026-01-09', 129)];
    const out = mergeAppErrorRecency([entry('spike')], { rows, rowCount: rows.length }, { today: TODAY });
    expect(out.status).toBe('ok');
    expect(out.entries[0]).toMatchObject({ count: 129, last7d: 0, lastSeen: '2026-01-09' });
  });

  it('sums only the days from the cutoff on, per entry (type + message + page + host)', () => {
    const rows = [
      row('TypeError', 'live', '/it/', 'frontaliereticino.ch', '2026-01-31', 4),
      row('TypeError', 'live', '/it/', 'frontaliereticino.ch', '2026-01-24', 5),
      row('TypeError', 'live', '/it/', 'frontaliereticino.ch', '2026-01-23', 100),
      row('TypeError', 'live', '/it/other/', 'frontaliereticino.ch', '2026-01-30', 50),
    ];
    const out = mergeAppErrorRecency([entry('live')], { rows, rowCount: rows.length }, { today: TODAY });
    expect(out.entries[0]).toMatchObject({ last7d: 9, lastSeen: '2026-01-31' });
  });

  it('status ok but NO row at all for an entry: not measured, never a silent zero', () => {
    // Same window, same filter, count > 0: a missing key is a key mismatch,
    // and `last7d: 0` would drop a live entry as a stale spike.
    const rows = [row('TypeError', 'other', '/it/', 'frontaliereticino.ch', '2026-01-30', 9)];
    const out = mergeAppErrorRecency([entry('other'), entry('unmatched')], { rows, rowCount: rows.length }, { today: TODAY });
    expect(out.status).toBe('ok');
    expect(out.entries[0]).toMatchObject({ last7d: 9 });
    expect(out.entries[1]).not.toHaveProperty('last7d');
    expect(out.entries[1]).not.toHaveProperty('lastSeen');
  });

  it('defaultType rewrites the recency key like the entry: an empty error_type matches', () => {
    const rows = [row('', 'boom', '/it/', 'frontaliereticino.ch', '2026-01-30', 40)];
    const out = mergeAppErrorRecency(
      [entry('boom', { errorType: 'exception', count: 40 })],
      { rows, rowCount: rows.length },
      { today: TODAY, defaultType: 'exception' },
    );
    expect(out.entries[0]).toMatchObject({ last7d: 40, lastSeen: '2026-01-30' });
  });

  it('a failed query leaves the entries WITHOUT the fields (not measured is not zero)', () => {
    const out = mergeAppErrorRecency([entry('x')], null, { today: TODAY });
    expect(out.status).toBe('unavailable');
    expect(out.entries[0]).not.toHaveProperty('last7d');
    expect(out.entries[0]).not.toHaveProperty('lastSeen');
  });

  it('truncation INSIDE the last 7 days is unavailable, never a partial count', () => {
    const rows = [row('TypeError', 'x', '/it/', 'frontaliereticino.ch', '2026-01-28', 9)];
    const out = mergeAppErrorRecency([entry('x')], { rows, rowCount: 90000 }, { today: TODAY });
    expect(out.status).toBe('unavailable');
    expect(out.entries[0]).not.toHaveProperty('last7d');
  });

  it('truncation that only lost days older than the cutoff keeps last7d; an unseen entry has lastSeen null', () => {
    const rows = [
      row('TypeError', 'x', '/it/', 'frontaliereticino.ch', '2026-01-28', 9),
      row('TypeError', 'x', '/it/', 'frontaliereticino.ch', '2026-01-20', 2),
    ];
    const out = mergeAppErrorRecency([entry('x'), entry('older')], { rows, rowCount: 90000 }, { today: TODAY });
    expect(out.status).toBe('truncated');
    expect(out.entries[0]).toMatchObject({ last7d: 9, lastSeen: '2026-01-28' });
    expect(out.entries[1]).toMatchObject({ last7d: 0, lastSeen: null });
  });
});

describe('chunk-load family', () => {
  const CHROME = 'TypeError: Failed to fetch dynamically imported module: https://cdn.frontaliereticino.ch/assets/News';
  const FIREFOX = 'TypeError: error loading dynamically imported module: https://cdn.frontaliereticino.ch/assets/seoSe';

  it('recognises the Chrome and Firefox wording, and nothing else', () => {
    expect(isChunkLoadFamily(CHROME)).toBe(true);
    expect(isChunkLoadFamily(FIREFOX)).toBe(true);
    expect(isChunkLoadFamily('TypeError: Failed to fetch')).toBe(false);
    expect(isChunkLoadFamily('x is not a function')).toBe(false);
  });

  it('merges the members into one entry and leaves the rest alone', () => {
    const other = entry('x is not a function', { count: 12, last7d: 12, lastSeen: '2026-01-30' });
    const members = [
      entry(CHROME, { errorType: 'error_boundary', count: 21, users: 11, last7d: 4, lastSeen: '2026-01-29' }),
      entry(FIREFOX, { errorType: 'api_error', count: 20, users: 9, last7d: 3, lastSeen: '2026-01-30' }),
    ];
    const out = groupChunkLoadFamily([members[0], other, members[1]]);
    expect(out).toEqual([
      other,
      expect.objectContaining({ family: 'chunk-load', count: 41, users: 20, last7d: 7, lastSeen: '2026-01-30' }),
    ]);
    expect(out[0]).toBe(other);
    expect(out[1].members).toHaveLength(members.length);
  });

  it('a family with one unmeasured member carries no last7d (a partial sum would look like a measure)', () => {
    const out = groupChunkLoadFamily([entry(CHROME, { last7d: 4 }), entry(FIREFOX)]);
    expect(out[0]).not.toHaveProperty('last7d');
  });

  it('no member, no family entry', () => {
    const only = entry('x is not a function');
    expect(groupChunkLoadFamily([only])).toEqual([only]);
  });
});

describe('client: non-production hosts do not emit GA4 error events', () => {
  it.each(['127.0.0.1', 'localhost', 'frontaliere-ticino.firebaseapp.com', 'frontaliere-ticino.web.app'])(
    '%s is non-production', (host) => expect(isNonProductionTelemetryHost(host)).toBe(true),
  );

  it.each(['frontaliereticino.ch', 'cdn.frontaliereticino.ch', 'some-new-host.example', ''])(
    '%s keeps reporting (deny-list: an unknown host never goes silent)', (host) => expect(isNonProductionTelemetryHost(host)).toBe(false),
  );

  it('covers app_error and its `exception` fallback, and nothing else', () => {
    expect([...GA4_ERROR_EVENTS].sort()).toEqual(['app_error', 'exception']);
  });
});
