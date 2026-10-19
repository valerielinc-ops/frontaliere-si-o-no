import { describe, expect, it, vi } from 'vitest';
import {
  ASSISTED_APPLICATION_COPY_TRACKED_EVENT_NAMES,
  ASSISTED_APPLICATION_COPY_TRACKED_BASE_EVENTS,
  ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS,
  ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS,
  assistedApplicationCopyEventName,
  parseAssistedApplicationCopyEventName,
} from '../services/assistedApplicationCopyAnalyticsContract.mjs';
import { runCopyReadout, summarizeCopyReport } from '../scripts/analytics/assisted-application-copy-readout.mjs';

describe('assisted-application copy GA4 contract', () => {
  it('encodes each low-cardinality copy arm in a standard event name under 40 characters', () => {
    expect(new Set(ASSISTED_APPLICATION_COPY_TRACKED_BASE_EVENTS)).toEqual(new Set([
      ...Object.values(ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS),
      ...ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS,
    ]));
    expect(ASSISTED_APPLICATION_COPY_TRACKED_EVENT_NAMES).toHaveLength(36);
    expect(new Set(ASSISTED_APPLICATION_COPY_TRACKED_EVENT_NAMES).size).toBe(36);
    expect(ASSISTED_APPLICATION_COPY_TRACKED_EVENT_NAMES.every((name) => name.length <= 40)).toBe(true);
    expect(assistedApplicationCopyEventName('assisted_application_offer_viewed', 'time_saved'))
      .toBe('aa_copy_exposure_time_saved');
    expect(parseAssistedApplicationCopyEventName('aa_copy_completed_handled_for_you')).toEqual({
      eventName: 'checkout_completed',
      variant: 'handled_for_you',
    });
    expect(parseAssistedApplicationCopyEventName('refund_issued')).toBeNull();
    expect(ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS).not.toContain('refund_issued');
  });

  it('prepares the readout using only the standard eventName dimension and readonly access', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const runReport = vi.fn(async () => ({ rows: [] }));
    await runCopyReadout(['--days', '7'], {
      propertyId: '524485296',
      getToken,
      runReport,
      now: new Date('2026-11-20T12:00:00Z'),
    });
    expect(getToken).toHaveBeenCalledWith(['https://www.googleapis.com/auth/analytics.readonly']);
    const { body } = runReport.mock.calls[0][0];
    expect(body.dimensions).toEqual([{ name: 'eventName' }]);
    expect(JSON.stringify(body.dimensionFilter)).not.toContain('customUser:');
    expect(body.dimensionFilter.andGroup.expressions[0].filter.inListFilter.values)
      .toEqual(ASSISTED_APPLICATION_COPY_TRACKED_EVENT_NAMES);
  });
});

describe('assisted-application copy readout aggregation', () => {
  it('computes completed-user conversion from exposure users and ignores other experiments', () => {
    const result = summarizeCopyReport({ rows: [
      {
        dimensionValues: [
          { value: 'aa_copy_exposure_time_saved' },
        ],
        metricValues: [{ value: '100' }, { value: '80' }],
      },
      {
        dimensionValues: [
          { value: 'aa_copy_completed_time_saved' },
        ],
        metricValues: [{ value: '10' }, { value: '9' }],
      },
      {
        dimensionValues: [
          { value: 'checkout_completed' },
        ],
        metricValues: [{ value: '99' }, { value: '99' }],
      },
    ] });
    expect(result.arms.time_saved).toMatchObject({ exposures: 80, completedUsers: 9, sameWindowCheckoutExposureRatio: 9 / 80 });
    expect(Object.keys(result.arms)).toEqual(['time_saved']);
  });
});
