import { describe, expect, it } from 'vitest';

import {
  buildSocialSiteOutcomeRequest,
  collectSocialSiteOutcomeSnapshots,
} from '../scripts/lib/social-site-outcomes.mjs';

describe('social GA4 site outcomes', () => {
  it('does not request session key-event rates for event-count-only actions', () => {
    const request = buildSocialSiteOutcomeRequest({
      startDate: '2026-10-01',
      endDate: '2026-10-30',
      eventNames: ['job_qualified_session', 'job_apply_handoff'],
    });

    expect(request?.metrics).toEqual([
      { name: 'sessions' },
      { name: 'sessionKeyEventRate:job_apply_handoff' },
    ]);
  });

  it('keeps event-count-only key events out of site-outcome collection and baselines', async () => {
    const now = new Date('2026-11-02T12:00:00.000Z');
    let reportCalls = 0;
    const onlyQualifiedEvent = await collectSocialSiteOutcomeSnapshots({
      now,
      propertyId: '123456',
      getTokenImpl: async () => 'opaque-token',
      listKeyEventMetricsImpl: async () => new Set([
        'sessionKeyEventRate:job_qualified_session',
      ]),
      runReportImpl: async () => {
        reportCalls += 1;
        return { complete: true, rows: [], metadata: { timeZone: 'Europe/Rome' } };
      },
    });

    expect(onlyQualifiedEvent).toMatchObject({
      status: 'no-rate-eligible-key-events',
      registeredEventNames: [],
      rows: [],
    });
    expect(reportCalls).toBe(0);

    let requestedMetrics: string[] = [];
    const mixedRegisteredEvents = await collectSocialSiteOutcomeSnapshots({
      now,
      propertyId: '123456',
      getTokenImpl: async () => 'opaque-token',
      listKeyEventMetricsImpl: async () => new Set([
        'sessionKeyEventRate:job_qualified_session',
        'sessionKeyEventRate:job_apply_handoff',
      ]),
      runReportImpl: async ({ body }) => {
        requestedMetrics = body.metrics.map(({ name }: { name: string }) => name);
        return { complete: true, rows: [], metadata: { timeZone: 'Europe/Rome' } };
      },
    });

    expect(requestedMetrics).toEqual(['sessions', 'sessionKeyEventRate:job_apply_handoff']);
    expect(mixedRegisteredEvents.registeredEventNames).toEqual(['job_apply_handoff']);
    expect(mixedRegisteredEvents.rows.every(({ eventName }: { eventName: string }) => eventName === 'job_apply_handoff'))
      .toBe(true);
  });
});
