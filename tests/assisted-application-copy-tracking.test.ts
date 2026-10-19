import { describe, expect, it, vi } from 'vitest';
import {
  ASSISTED_APPLICATION_COPY_EXPERIMENT_ID,
  ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS,
  ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS,
  ASSISTED_APPLICATION_COPY_USER_PROPERTIES,
} from '../services/assistedApplicationCopyAnalyticsContract.mjs';
import {
  GA4_STANDARD_USER_DIMENSION_LIMIT,
  planUserDimensionRegistration,
  runRegistration,
} from '../scripts/experiments/assisted-application-copy-ga4.mjs';
import { summarizeCopyReport } from '../scripts/analytics/assisted-application-copy-readout.mjs';

describe('assisted-application copy GA4 contract', () => {
  it('uses only short, low-cardinality USER dimensions and existing event names', () => {
    expect(ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS).toHaveLength(2);
    for (const dimension of ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS) {
      expect(dimension.scope).toBe('USER');
      expect(dimension.parameterName.length).toBeLessThanOrEqual(24);
    }
    expect(ASSISTED_APPLICATION_COPY_USER_PROPERTIES).toEqual({
      experiment: 'aa_copy_experiment',
      variant: 'aa_copy_variant',
    });
    expect(ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS).not.toContain('refund_issued');
  });

  it('preflights existing dimensions and refuses cap or contract mismatches', () => {
    const existing = ['is_registered', 'is_newsletter_subscriber', 'is_job_alert_subscriber']
      .map((parameterName) => ({ parameterName, scope: 'USER', displayName: parameterName, description: 'existing' }));
    const plan = planUserDimensionRegistration(existing);
    expect(plan.propertyCount).toBe(3);
    expect(plan.missing.map((dimension) => dimension.parameterName)).toEqual(['aa_copy_experiment', 'aa_copy_variant']);
    expect(plan.failures).toEqual([]);

    const full = Array.from({ length: GA4_STANDARD_USER_DIMENSION_LIMIT - 1 }, (_, index) => ({
      parameterName: `user_${index}`,
      scope: 'USER',
    }));
    expect(planUserDimensionRegistration(full).failures[0]).toMatch(/25 USER-dimension limit/);

    const mismatched = [{ ...ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS[0], scope: 'EVENT' }];
    expect(planUserDimensionRegistration(mismatched).failures[0]).toMatch(/incompatible scope/);
  });

  it('keeps GA4 registration dry-run read-only unless --apply is explicit', async () => {
    const fetchImpl = vi.fn(async (url: string, options?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ customDimensions: [
        { parameterName: 'is_registered', scope: 'USER', displayName: 'Is Registered User', description: 'Whether the user has a registered account (true/false), for revenue-per-user segmentation' },
        { parameterName: 'is_newsletter_subscriber', scope: 'USER', displayName: 'Is Newsletter Subscriber', description: 'Whether the user is subscribed to the newsletter (true/false), for revenue-per-user segmentation' },
        { parameterName: 'is_job_alert_subscriber', scope: 'USER', displayName: 'Is Job Alert Subscriber', description: 'Whether the user is subscribed to job alerts (true/false), for revenue-per-user segmentation' },
      ] }),
      text: async () => '',
      url,
      options,
    }));
    const result = await runRegistration([], {
      propertyId: '524485296',
      getToken: async () => 'test-token',
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.method).toBeUndefined();
  });
});

describe('assisted-application copy readout aggregation', () => {
  it('computes completed-user conversion from exposure users and ignores other experiments', () => {
    const result = summarizeCopyReport({ rows: [
      {
        dimensionValues: [
          { value: 'assisted_application_offer_viewed' },
          { value: ASSISTED_APPLICATION_COPY_EXPERIMENT_ID },
          { value: 'time_saved' },
        ],
        metricValues: [{ value: '100' }, { value: '80' }],
      },
      {
        dimensionValues: [
          { value: 'checkout_completed' },
          { value: ASSISTED_APPLICATION_COPY_EXPERIMENT_ID },
          { value: 'time_saved' },
        ],
        metricValues: [{ value: '10' }, { value: '9' }],
      },
      {
        dimensionValues: [
          { value: 'checkout_completed' },
          { value: 'other-copy-test' },
          { value: 'control' },
        ],
        metricValues: [{ value: '99' }, { value: '99' }],
      },
    ] });
    expect(result.arms.time_saved).toMatchObject({ exposures: 80, completedUsers: 9, sameWindowCheckoutExposureRatio: 9 / 80 });
    expect(Object.keys(result.arms)).toEqual(['time_saved']);
  });
});
