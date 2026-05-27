import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useAuthGateHeadlineVariant } from '@/services/authGateExperiment';
import { getFeatureFlag, onFeatureFlags, registerSuperProperty } from '@/services/posthog';

const getFeatureFlagMock = vi.mocked(getFeatureFlag);
const onFeatureFlagsMock = vi.mocked(onFeatureFlags);
const registerSuperPropertyMock = vi.mocked(registerSuperProperty);

describe('useAuthGateHeadlineVariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onFeatureFlagsMock.mockImplementation((callback) => {
      callback();
      return vi.fn();
    });
  });

  it('uses the control headline without registering a variant while PostHog has no assignment', async () => {
    getFeatureFlagMock.mockReturnValue(null);

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('it', 'Leggi requisiti e come candidarti'),
    );

    await waitFor(() => expect(onFeatureFlagsMock).toHaveBeenCalled());

    expect(result.current).toEqual({
      variant: 'control',
      headline: 'Leggi requisiti e come candidarti',
    });
    expect(registerSuperPropertyMock).not.toHaveBeenCalled();
  });

  it('registers headline_variant only for explicit PostHog assignments', async () => {
    getFeatureFlagMock.mockReturnValue('frictionless');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('it', 'Leggi requisiti e come candidarti'),
    );

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('headline_variant', 'frictionless'),
    );

    expect(result.current).toEqual({
      variant: 'frictionless',
      headline: "Continua per vedere l'annuncio completo",
    });
  });

  it('registers the control variant when PostHog explicitly assigns control', async () => {
    getFeatureFlagMock.mockReturnValue('control');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('it', 'Leggi requisiti e come candidarti'),
    );

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('headline_variant', 'control'),
    );

    expect(result.current).toEqual({
      variant: 'control',
      headline: 'Leggi requisiti e come candidarti',
    });
  });
});
