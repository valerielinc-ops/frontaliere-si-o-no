// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackExperimentEvent: vi.fn(),
}));

vi.mock('../services/analytics', () => ({
  Analytics: { trackExperimentEvent: mocks.trackExperimentEvent },
}));

import { getConfigValue } from '@/services/firebase';

import {
  ASSISTED_APPLICATION_EXPERIMENT_ID,
  ASSISTED_APPLICATION_EXPERIMENT_RC_KEY,
  normalizeAssistedApplicationVariant,
  resolveAssistedApplicationVariant,
  trackAssistedApplicationEvent,
  useAssistedApplicationVariant,
} from '../services/assistedApplicationExperiment';

const getConfigValueMock = vi.mocked(getConfigValue);

beforeEach(() => {
  vi.clearAllMocks();
  getConfigValueMock.mockResolvedValue('auto');
});

describe('assisted application experiment assignment', () => {
  it('keeps the same distinct id in the same three-arm assignment', () => {
    const ids = ['visitor-1', 'visitor-2', 'anon-sticky-id', 'visitor-3'];

    for (const id of ids) {
      expect(resolveAssistedApplicationVariant(id)).toBe(resolveAssistedApplicationVariant(id));
    }
    expect(resolveAssistedApplicationVariant('visitor-1')).toBe('rewarded_ad');
    expect(resolveAssistedApplicationVariant('visitor-2')).toBe('control');
  });

  it('assigns approximately 20/40/40% to control, paid, and rewarded arms', () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => `experiment-user-${index}`);
    const counts = ids.reduce<Record<string, number>>((acc, id) => {
      const variant = resolveAssistedApplicationVariant(id);
      acc[variant] = (acc[variant] || 0) + 1;
      return acc;
    }, {});

    expect(counts.control).toBeGreaterThanOrEqual(1_500);
    expect(counts.control).toBeLessThanOrEqual(2_500);
    expect(counts.assisted_application).toBeGreaterThanOrEqual(3_500);
    expect(counts.assisted_application).toBeLessThanOrEqual(4_500);
    expect(counts.rewarded_ad).toBeGreaterThanOrEqual(3_500);
    expect(counts.rewarded_ad).toBeLessThanOrEqual(4_500);
  });

  it('fails closed to control for missing or unknown assignments', () => {
    expect(resolveAssistedApplicationVariant('')).toBe('control');
    expect(normalizeAssistedApplicationVariant('control')).toBe('control');
    expect(normalizeAssistedApplicationVariant('assisted_application')).toBe('assisted_application');
    expect(normalizeAssistedApplicationVariant('rewarded_ad')).toBe('rewarded_ad');
    expect(normalizeAssistedApplicationVariant('treatment')).toBeNull();
    expect(normalizeAssistedApplicationVariant(true)).toBeNull();
  });
});

describe('assisted application Remote Config assignment', () => {
  it('uses the globally configured arm when Remote Config supplies one', async () => {
    getConfigValueMock.mockResolvedValue('rewarded_ad');

    const { result } = renderHook(() => useAssistedApplicationVariant());

    await waitFor(() => expect(result.current).toMatchObject({
      variant: 'rewarded_ad',
      ready: true,
    }));
    expect(getConfigValueMock).toHaveBeenCalledWith(ASSISTED_APPLICATION_EXPERIMENT_RC_KEY);
  });
});

describe('assisted application funnel events', () => {
  it('adds the shared experiment and job identity to every event', () => {
    trackAssistedApplicationEvent('checkout_started', {
      variant: 'assisted_application',
      jobId: 'job-42',
      companyId: 'company-acme',
      price_eur_cents: 99,
    });

    expect(mocks.trackExperimentEvent).toHaveBeenCalledWith('checkout_started', expect.objectContaining({
      experiment_id: ASSISTED_APPLICATION_EXPERIMENT_ID,
      variant: 'assisted_application',
      job_id: 'job-42',
      company_id: 'company-acme',
      price_eur_cents: 99,
    }));
  });
});
