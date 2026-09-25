import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  AUTHGATE_HEADLINE_RC_KEY,
  useAuthGateHeadlineVariant,
} from '@/services/authGateExperiment';
import { getConfigValue } from '@/services/firebase';

const getConfigValueMock = vi.mocked(getConfigValue);

// Round-1 winner ("frictionless") is now the i18n default, so it is the value
// the caller passes in as the control headline for round 2.
const CONTROL_HEADLINE = "Continua per vedere l'annuncio completo";

describe('useAuthGateHeadlineVariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigValueMock.mockResolvedValue('control');
  });

  it('uses the control headline when Remote Config has no assignment', async () => {
    getConfigValueMock.mockResolvedValue('');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('it', CONTROL_HEADLINE),
    );

    await waitFor(() => expect(getConfigValueMock).toHaveBeenCalledWith(AUTHGATE_HEADLINE_RC_KEY));

    expect(result.current).toEqual({
      variant: 'control',
      headline: CONTROL_HEADLINE,
    });
  });

  it('uses the control variant when Remote Config explicitly assigns control', async () => {
    getConfigValueMock.mockResolvedValue('control');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('it', CONTROL_HEADLINE),
    );

    await waitFor(() => expect(getConfigValueMock).toHaveBeenCalledWith(AUTHGATE_HEADLINE_RC_KEY));

    expect(result.current).toEqual({
      variant: 'control',
      headline: CONTROL_HEADLINE,
    });
  });

  it('resolves the free_unlock challenger headline per locale and tags the event', async () => {
    getConfigValueMock.mockResolvedValue('free_unlock');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('en', CONTROL_HEADLINE),
    );

    await waitFor(() => expect(result.current.variant).toBe('free_unlock'));

    expect(result.current).toEqual({
      variant: 'free_unlock',
      headline: 'Unlock the full listing for free',
    });
  });

  it('resolves the apply_now challenger headline per locale and tags the event', async () => {
    getConfigValueMock.mockResolvedValue('apply_now');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('de', CONTROL_HEADLINE),
    );

    await waitFor(() => expect(result.current.variant).toBe('apply_now'));

    expect(result.current).toEqual({
      variant: 'apply_now',
      headline: 'So bewirbst du dich für diese Stelle',
    });
  });

  it('falls back to the Italian challenger copy for an unknown locale', async () => {
    getConfigValueMock.mockResolvedValue('free_unlock');

    const { result } = renderHook(() =>
      useAuthGateHeadlineVariant('pt', CONTROL_HEADLINE),
    );

    await waitFor(() => expect(result.current.variant).toBe('free_unlock'));

    expect(result.current).toEqual({
      variant: 'free_unlock',
      headline: "Sblocca gratis l'annuncio completo",
    });
  });
});
