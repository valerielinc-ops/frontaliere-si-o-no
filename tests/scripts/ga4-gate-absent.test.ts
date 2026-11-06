import { describe, expect, it, vi } from 'vitest';

import {
  GATE_ABSENT_EVENT,
  GATE_LATE_EVENT,
  buildReport,
  buildReportBody,
  main,
  normalizeGa4Rows,
  resolveWindow,
} from '../../scripts/ci/ga4-gate-absent.mjs';

const row = (
  eventName: string,
  reason: string,
  gateStatus: string,
  consentState: string,
  eventCount = '1',
  totalUsers = eventCount,
) => ({
  dimensionValues: [
    { value: eventName },
    { value: reason },
    { value: gateStatus },
    { value: consentState },
  ],
  metricValues: [{ value: eventCount }, { value: totalUsers }],
});

const response = (rows: unknown[], metadata: Record<string, unknown> = {}) => ({
  rowCount: rows.length,
  rows,
  metadata,
});

describe('ga4-gate-absent', () => {
  it('builds one explicit, filtered GA4 query for both diagnostic events', () => {
    const body = buildReportBody({ startDate: '2026-10-01', endDate: '2026-10-07' });

    expect(body.dateRanges).toEqual([{ startDate: '2026-10-01', endDate: '2026-10-07' }]);
    expect(body.dimensions.map(({ name }) => name)).toEqual([
      'eventName',
      'customEvent:reason',
      'customEvent:gate_status',
      'customEvent:consent_state',
    ]);
    expect(body.metrics.map(({ name }) => name)).toEqual(['eventCount', 'totalUsers']);
    expect(body.dimensionFilter).toEqual({
      filter: {
        fieldName: 'eventName',
        inListFilter: {
          values: [GATE_ABSENT_EVENT, GATE_LATE_EVENT],
          caseSensitive: true,
        },
      },
    });
  });

  it('uses the settled GA4 window by default and supports an explicit replay window', () => {
    expect(resolveWindow({}, new Date('2026-10-16T12:00:00Z'))).toEqual({
      startDate: '2026-10-08',
      endDate: '2026-10-14',
      days: 7,
      lagDays: 2,
    });
    expect(resolveWindow({ since: '2026-10-04', until: '2026-10-06' })).toEqual({
      startDate: '2026-10-04',
      endDate: '2026-10-06',
      days: 3,
      lagDays: null,
    });
  });

  it('separates consent cohorts and strips qualifiers only for stage aggregation', () => {
    const report = buildReport({
      response: response([
        row(GATE_ABSENT_EVENT, 'cmf_not_called+spa', 'absent', 'granted', '2', '2'),
        row(GATE_ABSENT_EVENT, 'fc_not_loaded', 'absent', 'granted', '1', '1'),
        row(GATE_ABSENT_EVENT, 'fc_not_loaded', 'absent', 'denied', '4', '3'),
        row(GATE_LATE_EVENT, 'held', 'held', 'granted', '2', '2'),
      ], { timeZone: 'Europe/Zurich' }),
      window: { startDate: '2026-10-01', endDate: '2026-10-07', days: 7, lagDays: null },
      propertyId: '524485296',
      query: { limit: 1000 },
    });

    expect(report.cohorts.consent_granted).toMatchObject({ eventCount: 5, totalUsers: 5 });
    expect(report.cohorts.consent_not_granted).toMatchObject({ eventCount: 4, totalUsers: 3 });
    expect(report.cohorts.consent_granted.byEvent[0].byReason).toEqual([
      { reason: 'cmf_not_called+spa', eventCount: 2, totalUsers: 2 },
      { reason: 'fc_not_loaded', eventCount: 1, totalUsers: 1 },
    ]);
    expect(report.cohorts.consent_granted.byEvent[0].byStage).toEqual([
      { stage: 'cmf_not_called', eventCount: 2, totalUsers: 2 },
      { stage: 'fc_not_loaded', eventCount: 1, totalUsers: 1 },
    ]);
    expect(report.cohorts.consent_granted.byEvent[1].byGateStatus).toEqual([
      { gate_status: 'held', eventCount: 2, totalUsers: 2 },
    ]);
    expect(report.dominantStage).toMatchObject({ status: 'unique', stage: 'cmf_not_called' });
    expect(report.coverage).toMatchObject({ rowsReturned: 4, rowCount: 4, complete: true, timeZone: 'Europe/Zurich' });
  });

  it('does not invent a dominant stage when granted observations tie', () => {
    const report = buildReport({
      response: response([
        row(GATE_ABSENT_EVENT, 'cmf_not_called', 'absent', 'granted'),
        row(GATE_ABSENT_EVENT, 'fc_not_loaded', 'absent', 'granted'),
      ]),
      window: { startDate: '2026-10-01', endDate: '2026-10-02', days: 2, lagDays: null },
      propertyId: 'properties/524485296',
      query: {},
    });

    expect(report.dominantStage).toMatchObject({ status: 'tie', stage: null });
    expect(report.dominantStage.candidates.map(({ stage }) => stage)).toEqual(['cmf_not_called', 'fc_not_loaded']);
  });

  it.each([
    ['missing rows', { rowCount: 0 }, 'unreadable rows'],
    ['truncated rows', { ...response([row(GATE_ABSENT_EVENT, 'fc_not_loaded', 'absent', 'granted')]), rowCount: 2 }, 'truncated'],
    ['ambiguous consent', response([row(GATE_ABSENT_EVENT, 'fc_not_loaded', 'absent', '(not set)')]), 'unreadable consent_state'],
    ['other bucket', response([row(GATE_ABSENT_EVENT, '(other)', 'absent', 'granted')]), 'unreadable reason'],
    ['sampled response', response([], { samplingMetadatas: [{}] }), 'sampled'],
  ])('fails closed on %s', (_label, input, message) => {
    expect(() => normalizeGa4Rows(input)).toThrow(message);
  });

  it('fails closed before a query when credentials are missing', async () => {
    const originalCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const originalJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const logger = { log: vi.fn(), error: vi.fn() };
    try {
      await expect(main({ argv: ['--days', '1'], logger, now: new Date('2026-10-16T12:00:00Z') }))
        .rejects.toThrow('credentials missing');
      expect(logger.log).not.toHaveBeenCalled();
    } finally {
      if (originalCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentials;
      if (originalJson === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = originalJson;
    }
  });

  it('produces the report through injected read-only dependencies', async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const runReportImpl = vi.fn(async () => response([
      row(GATE_ABSENT_EVENT, 'fc_not_loaded', 'absent', 'granted', '3', '3'),
    ]));
    const report = await main({
      argv: ['--since', '2026-10-01', '--until', '2026-10-03'],
      logger,
      getTokenImpl: vi.fn(async () => 'read-only-token'),
      runReportImpl,
      now: new Date('2026-10-16T12:00:00Z'),
    });

    expect(runReportImpl).toHaveBeenCalledWith(expect.objectContaining({ token: 'read-only-token' }));
    expect(report?.dominantStage).toMatchObject({ status: 'unique', stage: 'fc_not_loaded' });
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
