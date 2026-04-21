import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useKillSwitches, KILL_SWITCH_RC_KEYS } from '@/hooks/useKillSwitches';
import { getConfigValue } from '@/services/firebase';

const rcMock = vi.mocked(getConfigValue);

describe('useKillSwitches', () => {
  beforeEach(() => {
    rcMock.mockReset();
  });

  it('defaults every kill-switch to false before RC resolves', () => {
    // Pending promise — the hook's useEffect fires but state never updates.
    rcMock.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    const { result } = renderHook(() => useKillSwitches());

    expect(result.current).toEqual({
      fuelDaily: false,
      healthPremiums: false,
      jobMarket: false,
      weeklyEmployers: false,
      orphanLandings: false,
    });
  });

  it('falls back to false for every flag when RC rejects', async () => {
    rcMock.mockImplementation(() => Promise.reject(new Error('RC offline')));

    const { result } = renderHook(() => useKillSwitches());

    // Give the effect time to resolve its promise chain.
    await waitFor(() => {
      expect(rcMock).toHaveBeenCalled();
    });
    // State stays on the default-safe "all false" after the rejection.
    expect(result.current.fuelDaily).toBe(false);
    expect(result.current.healthPremiums).toBe(false);
    expect(result.current.jobMarket).toBe(false);
    expect(result.current.weeklyEmployers).toBe(false);
    expect(result.current.orphanLandings).toBe(false);
  });

  it('reads each RC parameter name and returns true when the flag is "true"', async () => {
    rcMock.mockImplementation(async (key: string) => {
      if (key === KILL_SWITCH_RC_KEYS.fuelDaily) return 'true';
      if (key === KILL_SWITCH_RC_KEYS.healthPremiums) return 'false';
      if (key === KILL_SWITCH_RC_KEYS.jobMarket) return 'TRUE'; // case-insensitive
      if (key === KILL_SWITCH_RC_KEYS.weeklyEmployers) return '';
      if (key === KILL_SWITCH_RC_KEYS.orphanLandings) return 'true';
      return '';
    });

    const { result } = renderHook(() => useKillSwitches());

    await waitFor(() => {
      expect(result.current.fuelDaily).toBe(true);
    });

    expect(result.current).toEqual({
      fuelDaily: true,
      healthPremiums: false,
      jobMarket: true,
      weeklyEmployers: false,
      orphanLandings: true,
    });
  });

  it('queries Remote Config with exactly the documented parameter names', async () => {
    rcMock.mockResolvedValue('false');

    renderHook(() => useKillSwitches());

    await waitFor(() => {
      expect(rcMock).toHaveBeenCalledTimes(5);
    });

    const callArgs = rcMock.mock.calls.map(([arg]) => arg);
    expect(callArgs).toContain('KILL_FUEL_DAILY_LINKS');
    expect(callArgs).toContain('KILL_HEALTH_PREMIUMS_LINKS');
    expect(callArgs).toContain('KILL_JOB_MARKET_LINKS');
    expect(callArgs).toContain('KILL_WEEKLY_EMPLOYERS_LINKS');
    expect(callArgs).toContain('KILL_ORPHAN_LANDINGS_LINKS');
  });
});
