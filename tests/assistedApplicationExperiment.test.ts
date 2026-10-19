// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackExperimentEvent: vi.fn(),
}));

vi.mock('../services/analytics', () => ({
  Analytics: {
    trackExperimentEvent: mocks.trackExperimentEvent,
  },
}));

import { getConfigValue } from '@/services/firebase';

import {
  ASSISTED_APPLICATION_EVENT_NAMES,
  ASSISTED_APPLICATION_COPY_EXPERIMENT_ID,
  ASSISTED_APPLICATION_COPY_VARIANT_RC_KEY,
  ASSISTED_APPLICATION_EXPERIMENT_ID,
  ASSISTED_APPLICATION_EXPERIMENT_RC_KEY,
  ASSISTED_APPLICATION_OFFERWALL_FALLBACK_RC_KEY,
  isOfferwallLoadFailure,
  parseOfferwallFallbackFlag,
  shouldOfferPaidFallback,
  useOfferwallPaidFallback,
  normalizeAssistedApplicationVariant,
  normalizeAssistedApplicationCopyVariant,
  resolveAssistedApplicationCopyVariant,
  resolveAssistedApplicationVariant,
  shouldSuppressAssistedApplicationEvent,
  trackAssistedApplicationEvent,
  useAssistedApplicationCopyVariant,
  useAssistedApplicationVariant,
} from '../services/assistedApplicationExperiment';

const getConfigValueMock = vi.mocked(getConfigValue);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getConfigValueMock.mockResolvedValue('auto');
});

describe('assisted application experiment assignment', () => {
  it('keeps the same distinct id in the same two-arm assignment', () => {
    const ids = ['visitor-1', 'visitor-2', 'anon-sticky-id', 'visitor-3'];

    for (const id of ids) {
      expect(resolveAssistedApplicationVariant(id)).toBe(resolveAssistedApplicationVariant(id));
    }
    expect(resolveAssistedApplicationVariant('visitor-1')).toBe('assisted_application');
    expect(resolveAssistedApplicationVariant('visitor-2')).toBe('control');
  });

  it('assigns approximately 50/50% to original and subscription arms', () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => `experiment-user-${index}`);
    const counts = ids.reduce<Record<string, number>>((acc, id) => {
      const variant = resolveAssistedApplicationVariant(id);
      acc[variant] = (acc[variant] || 0) + 1;
      return acc;
    }, {});

    expect(counts.control).toBeGreaterThanOrEqual(4_500);
    expect(counts.control).toBeLessThanOrEqual(5_500);
    expect(counts.assisted_application).toBeGreaterThanOrEqual(4_500);
    expect(counts.assisted_application).toBeLessThanOrEqual(5_500);
    expect(counts.rewarded_ad).toBeUndefined();
  });

  it('fails closed to control for missing or unknown assignments', () => {
    expect(resolveAssistedApplicationVariant('')).toBe('control');
    expect(normalizeAssistedApplicationVariant('control')).toBe('control');
    expect(normalizeAssistedApplicationVariant('assisted_application')).toBe('assisted_application');
    expect(normalizeAssistedApplicationVariant('rewarded_ad')).toBe('rewarded_ad');
    expect(normalizeAssistedApplicationVariant('treatment')).toBeNull();
    expect(normalizeAssistedApplicationVariant(true)).toBeNull();
  });

  it('assigns the copy test to four sticky arms with an approximately even split', () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => `copy-test-user-${index}`);
    const counts = ids.reduce<Record<string, number>>((acc, id) => {
      const variant = resolveAssistedApplicationCopyVariant(id);
      acc[variant] = (acc[variant] || 0) + 1;
      return acc;
    }, {});

    for (const variant of ['control', 'time_saved', 'portal_relief', 'handled_for_you']) {
      expect(counts[variant]).toBeGreaterThanOrEqual(4_500);
      expect(counts[variant]).toBeLessThanOrEqual(5_500);
    }
    expect(resolveAssistedApplicationCopyVariant('copy-test-user-42')).toBe(
      resolveAssistedApplicationCopyVariant('copy-test-user-42'),
    );
    expect(resolveAssistedApplicationCopyVariant('')).toBe('control');
    expect(normalizeAssistedApplicationCopyVariant('portal_relief')).toBe('portal_relief');
    expect(normalizeAssistedApplicationCopyVariant('unknown')).toBeNull();
  });
});

describe('assisted application Remote Config assignment', () => {
  it('skips assignment entirely for the route-only rewarded treatment', () => {
    const { result } = renderHook(() => useAssistedApplicationVariant(false));

    expect(result.current).toMatchObject({ variant: 'rewarded_ad', ready: true });
    expect(getConfigValueMock).not.toHaveBeenCalled();
  });

  it('does not leak the route-only rewarded arm into other surfaces', async () => {
    getConfigValueMock.mockResolvedValue('rewarded_ad');

    const { result } = renderHook(() => useAssistedApplicationVariant());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(['control', 'assisted_application']).toContain(result.current.variant);
    expect(getConfigValueMock).toHaveBeenCalledWith(ASSISTED_APPLICATION_EXPERIMENT_RC_KEY);
  });

  it('resets a route-only rewarded arm before assigning a newly enabled surface', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAssistedApplicationVariant(enabled),
      { initialProps: { enabled: false } },
    );

    expect(result.current).toMatchObject({ variant: 'rewarded_ad', ready: true });
    rerender({ enabled: true });

    expect(result.current).toMatchObject({ variant: 'control', ready: false });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.variant).not.toBe('rewarded_ad');
  });

  it('uses Remote Config auto for the four-arm copy split and supports a forced QA arm', async () => {
    getConfigValueMock.mockResolvedValue('auto');
    const { result } = renderHook(() => useAssistedApplicationCopyVariant());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(['control', 'time_saved', 'portal_relief', 'handled_for_you']).toContain(result.current.variant);
    expect(getConfigValueMock).toHaveBeenCalledWith(ASSISTED_APPLICATION_COPY_VARIANT_RC_KEY);

    getConfigValueMock.mockResolvedValue('portal_relief');
    const forced = renderHook(() => useAssistedApplicationCopyVariant());
    await waitFor(() => expect(forced.result.current.ready).toBe(true));
    expect(forced.result.current.variant).toBe('portal_relief');
  });
});

describe('assisted application funnel events', () => {
  it('keeps the post-auth checkout resume as a first-class funnel event', () => {
    expect(ASSISTED_APPLICATION_EVENT_NAMES).toContain('checkout_resumed');
  });

  it('suppresses events for crawler visitors even when the caller bypasses JobBoard', () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Googlebot/2.1 (+http://www.google.com/bot.html)',
    });

    try {
      expect(shouldSuppressAssistedApplicationEvent()).toBe(true);
      trackAssistedApplicationEvent('checkout_started', {
        variant: 'assisted_application',
        jobId: 'job-42',
        companyId: 'company-acme',
      });
      expect(mocks.trackExperimentEvent).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      });
    }
  });

  it('adds the shared experiment and job identity to every event', () => {
    trackAssistedApplicationEvent('checkout_started', {
      variant: 'assisted_application',
      jobId: 'job-42',
      companyId: 'company-acme',
      price_eur_cents: 199,
    });

    expect(mocks.trackExperimentEvent).toHaveBeenCalledWith('checkout_started', expect.objectContaining({
      experiment_id: ASSISTED_APPLICATION_EXPERIMENT_ID,
      variant: 'assisted_application',
      job_id: 'job-42',
      company_id: 'company-acme',
      price_eur_cents: 199,
    }));
  });

  it('joins copy-test events to the copy experiment without replacing the funnel arm', () => {
    trackAssistedApplicationEvent('checkout_started', {
      variant: 'assisted_application',
      copy_variant: 'time_saved',
      jobId: 'job-42',
      companyId: 'company-acme',
    });

    expect(mocks.trackExperimentEvent).toHaveBeenCalledWith('checkout_started', expect.objectContaining({
      experiment_id: ASSISTED_APPLICATION_EXPERIMENT_ID,
      copy_experiment_id: ASSISTED_APPLICATION_COPY_EXPERIMENT_ID,
      copy_variant: 'time_saved',
    }));
    expect(mocks.trackExperimentEvent).toHaveBeenCalledWith('aa_copy_started_time_saved', {
      experiment_id: ASSISTED_APPLICATION_COPY_EXPERIMENT_ID,
      variant: 'time_saved',
    });
    expect(mocks.trackExperimentEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps administrator-only events outside the copy experiment', () => {
    trackAssistedApplicationEvent('refund_issued', {
      variant: 'assisted_application',
      jobId: 'job-42',
      companyId: 'company-acme',
    });

    expect(mocks.trackExperimentEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackExperimentEvent).toHaveBeenCalledWith('refund_issued', expect.not.objectContaining({ copy_variant: expect.anything() }));
  });
});

describe('Offerwall paid fallback', () => {
  it('treats only load failures as a reason to offer the paid path', () => {
    for (const reason of ['offerwall_not_shown', 'no_fill', 'ready_timeout', 'gpt_ready_timeout', 'gpt_unavailable', 'slot_init_error', 'display_error', 'slot_not_ready']) {
      expect(isOfferwallLoadFailure(reason)).toBe(true);
    }
    for (const reason of ['offerwall_closed_without_reward', 'ad_consent_missing', 'consent_denied', 'not_production', 'not_eligible', '', undefined]) {
      expect(isOfferwallLoadFailure(reason)).toBe(false);
    }
  });

  it('offers the paid path on load failures and on a refused ad, never to ineligible runs', () => {
    // Owner decision 2026-09-29: visitors who refuse the ad get the offer too.
    for (const reason of [
      'offerwall_not_shown', 'no_fill', 'ready_timeout', 'gpt_ready_timeout', 'gpt_unavailable', 'slot_init_error', 'display_error', 'slot_not_ready',
      'consent_denied', 'ad_consent_missing', 'offerwall_closed_without_reward',
    ]) {
      expect(shouldOfferPaidFallback(reason)).toBe(true);
    }
    for (const reason of ['not_production', 'not_eligible', 'unavailable', 'video_closed_before_reward', '', undefined, null]) {
      expect(shouldOfferPaidFallback(reason)).toBe(false);
    }
  });

  it('is off unless Remote Config says exactly true', async () => {
    expect(parseOfferwallFallbackFlag(' TRUE ')).toBe(true);
    expect(parseOfferwallFallbackFlag('1')).toBe(false);
    expect(parseOfferwallFallbackFlag(undefined)).toBe(false);

    getConfigValueMock.mockResolvedValue('true');
    const enabled = renderHook(() => useOfferwallPaidFallback(true));
    await waitFor(() => expect(enabled.result.current).toBe(true));
    expect(getConfigValueMock).toHaveBeenCalledWith(ASSISTED_APPLICATION_OFFERWALL_FALLBACK_RC_KEY);

    getConfigValueMock.mockClear();
    const bypassed = renderHook(() => useOfferwallPaidFallback(false));
    expect(bypassed.result.current).toBe(false);
    expect(getConfigValueMock).not.toHaveBeenCalled();

    getConfigValueMock.mockRejectedValue(new Error('offline'));
    const failing = renderHook(() => useOfferwallPaidFallback(true));
    await waitFor(() => expect(getConfigValueMock).toHaveBeenCalled());
    expect(failing.result.current).toBe(false);
  });
});
