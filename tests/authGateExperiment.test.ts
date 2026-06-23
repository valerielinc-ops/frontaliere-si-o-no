import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useAuthGateHeadlineVariant, useAuthGateModelVariant } from '@/services/authGateExperiment';
import { getFeatureFlag, onFeatureFlags, registerSuperProperty } from '@/services/posthog';

const getFeatureFlagMock = vi.mocked(getFeatureFlag);
const onFeatureFlagsMock = vi.mocked(onFeatureFlags);
const registerSuperPropertyMock = vi.mocked(registerSuperProperty);

// Round-1 winner ("frictionless") is now the i18n default, so it is the value
// the caller passes in as the control headline for round 2.
const CONTROL_HEADLINE = "Continua per vedere l'annuncio completo";

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
      useAuthGateHeadlineVariant('it', CONTROL_HEADLINE),
    );

    await waitFor(() => expect(onFeatureFlagsMock).toHaveBeenCalled());

    expect(result.current).toEqual({
      variant: 'control',
      headline: CONTROL_HEADLINE,
    });
    expect(registerSuperPropertyMock).not.toHaveBeenCalled();
  });

  it('registers the control variant when PostHog explicitly assigns control', async () => {
    getFeatureFlagMock.mockReturnValue('control');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('it', CONTROL_HEADLINE),
    );

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('headline_variant', 'control'),
    );

    expect(result.current).toEqual({
      variant: 'control',
      headline: CONTROL_HEADLINE,
    });
  });

  it('resolves the free_unlock challenger headline per locale and tags the event', async () => {
    getFeatureFlagMock.mockReturnValue('free_unlock');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('en', CONTROL_HEADLINE),
    );

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('headline_variant', 'free_unlock'),
    );

    expect(result.current).toEqual({
      variant: 'free_unlock',
      headline: 'Unlock the full listing for free',
    });
  });

  it('resolves the apply_now challenger headline per locale and tags the event', async () => {
    getFeatureFlagMock.mockReturnValue('apply_now');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('de', CONTROL_HEADLINE),
    );

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('headline_variant', 'apply_now'),
    );

    expect(result.current).toEqual({
      variant: 'apply_now',
      headline: 'So bewirbst du dich für diese Stelle',
    });
  });

  it('falls back to the Italian challenger copy for an unknown locale', async () => {
    getFeatureFlagMock.mockReturnValue('free_unlock');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('pt', CONTROL_HEADLINE),
    );

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('headline_variant', 'free_unlock'),
    );

    expect(result.current).toEqual({
      variant: 'free_unlock',
      headline: "Sblocca gratis l'annuncio completo",
    });
  });
});

describe('useAuthGateModelVariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onFeatureFlagsMock.mockImplementation((callback) => {
      callback();
      return vi.fn();
    });
  });

  it('falls back to control without tagging gate_model when PostHog has no assignment', async () => {
    getFeatureFlagMock.mockReturnValue(null);

    const { result } = renderHook(() => useAuthGateModelVariant());

    await waitFor(() => expect(onFeatureFlagsMock).toHaveBeenCalled());

    expect(result.current).toBe('control');
    expect(registerSuperPropertyMock).not.toHaveBeenCalled();
  });

  it('tags gate_model when PostHog explicitly assigns control', async () => {
    getFeatureFlagMock.mockReturnValue('control');

    const { result } = renderHook(() => useAuthGateModelVariant());

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('gate_model', 'control'),
    );

    expect(result.current).toBe('control');
  });

  it('resolves and tags the value_first arm', async () => {
    getFeatureFlagMock.mockReturnValue('value_first');

    const { result } = renderHook(() => useAuthGateModelVariant());

    await waitFor(() =>
      expect(registerSuperPropertyMock).toHaveBeenCalledWith('gate_model', 'value_first'),
    );

    expect(result.current).toBe('value_first');
  });

  it('ignores an unknown arm and stays on control', async () => {
    getFeatureFlagMock.mockReturnValue('mystery_arm');

    const { result } = renderHook(() => useAuthGateModelVariant());

    await waitFor(() => expect(onFeatureFlagsMock).toHaveBeenCalled());

    expect(result.current).toBe('control');
    expect(registerSuperPropertyMock).not.toHaveBeenCalled();
  });
});
