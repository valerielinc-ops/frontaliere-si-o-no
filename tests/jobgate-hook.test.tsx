import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JOBGATE_ASSIGNED_STORAGE_KEY,
  JOBGATE_LOAD_TIMEOUT_MS,
  currentJobGateAssignment,
  loadJobGateAssignment,
  recordJobGateExposure,
  resetJobGateAssignmentForTests,
  useJobGateExperiment,
} from '@/hooks/useJobGateExperiment';
import { Analytics } from '@/services/analytics';
import { getConfigValue } from '@/services/firebase';
import { getJobGateTelemetryParams } from '@/services/jobGateExperiment';

const getConfigValueMock = vi.mocked(getConfigValue);
const trackExperimentEvent = vi.mocked(Analytics.trackExperimentEvent);

function remoteConfig(values: Record<string, string>) {
  getConfigValueMock.mockImplementation(async (key: string) => values[key] ?? '');
}

const ARMS_4 = '{"spotlight":25,"spotlight_quiet":25,"spotlight_tinted":25,"spotlight_outline":25}';

describe('useJobGateExperiment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobGateAssignmentForTests();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on promoted Spotlight and stays out of v5 with the shipped defaults', async () => {
    remoteConfig({ JOBGATE_V5_EXPERIMENT_ENABLED: 'false', JOBGATE_V5_EXPERIMENT_ARMS: '{"spotlight":100}' });
    const { result } = renderHook(() => useJobGateExperiment());
    expect(result.current).toEqual({ ready: false, enrolled: false, arm: 'spotlight' });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ ready: true, enrolled: false, arm: 'spotlight' });
    expect(getJobGateTelemetryParams()).toBeNull();
  });

  it('assigns a sticky arm from the visitor id when enabled', async () => {
    remoteConfig({ JOBGATE_V5_EXPERIMENT_ENABLED: 'true', JOBGATE_V5_EXPERIMENT_ARMS: ARMS_4 });
    const first = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    expect(first.result.current.enrolled).toBe(true);
    const arm = first.result.current.arm;

    // A later page view (fresh module memo, same browser id) gets the same arm.
    resetJobGateAssignmentForTests();
    const second = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(second.result.current.arm).toBe(arm);
    expect(getJobGateTelemetryParams()).toEqual({ experiment_id: 'jobgate-v5', variant: arm });
  });

  it('honours JOBGATE_V5_EXPERIMENT_FORCE', async () => {
    remoteConfig({ JOBGATE_V5_EXPERIMENT_ENABLED: 'true', JOBGATE_V5_EXPERIMENT_ARMS: ARMS_4, JOBGATE_V5_EXPERIMENT_FORCE: 'spotlight' });
    const { result } = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ ready: true, enrolled: true, arm: 'spotlight' });
  });

  it('renders the final arm on the first paint when the assignment already settled (no flip)', async () => {
    remoteConfig({ JOBGATE_V5_EXPERIMENT_ENABLED: 'true', JOBGATE_V5_EXPERIMENT_ARMS: ARMS_4, JOBGATE_V5_EXPERIMENT_FORCE: 'spotlight_outline' });
    await loadJobGateAssignment();
    const { result } = renderHook(() => useJobGateExperiment());
    expect(result.current).toEqual({ ready: true, enrolled: true, arm: 'spotlight_outline' });
  });

  it('a gate rendered while Remote Config is pending still enrols the visitor and reports the arm', async () => {
    remoteConfig({ JOBGATE_V5_EXPERIMENT_ENABLED: 'true', JOBGATE_V5_EXPERIMENT_ARMS: ARMS_4, JOBGATE_V5_EXPERIMENT_FORCE: 'spotlight' });
    const { result } = renderHook(() => useJobGateExperiment());
    // First render: pending, already drawn as the promoted Spotlight default.
    expect(result.current).toEqual({ ready: false, enrolled: false, arm: 'spotlight' });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ ready: true, enrolled: true, arm: 'spotlight' });
    expect(getJobGateTelemetryParams()).toEqual({ experiment_id: 'jobgate-v5', variant: 'spotlight' });
    recordJobGateExposure(result.current);
    expect(trackExperimentEvent).toHaveBeenCalledWith('experiment_assigned', { experiment_id: 'jobgate-v5', variant: 'spotlight' });
  });

  it('keeps crawlers/bots out without reading Remote Config', async () => {
    remoteConfig({ JOBGATE_V5_EXPERIMENT_ENABLED: 'true', JOBGATE_V5_EXPERIMENT_FORCE: 'spotlight_outline' });
    const { result } = renderHook(() => useJobGateExperiment(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.enrolled).toBe(false);
    expect(getConfigValueMock).not.toHaveBeenCalled();
    // …and their subscriber write is not tagged either.
    await expect(currentJobGateAssignment()).resolves.toEqual({ ready: true, enrolled: false, arm: 'spotlight' });
  });

  it('falls back to not-enrolled when Remote Config throws', async () => {
    getConfigValueMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ ready: true, enrolled: false, arm: 'spotlight' });
  });

  it('falls back to not-enrolled when Remote Config is slower than the timeout', async () => {
    vi.useFakeTimers();
    getConfigValueMock.mockImplementation(() => new Promise<string>(() => {}));
    const pending = loadJobGateAssignment();
    await act(async () => {
      vi.advanceTimersByTime(JOBGATE_LOAD_TIMEOUT_MS + 1);
    });
    await expect(pending).resolves.toEqual({ ready: true, enrolled: false, arm: 'spotlight' });
  });
});

describe('recordJobGateExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobGateAssignmentForTests();
    window.localStorage.clear();
  });

  it('emits experiment_assigned once per visitor with the contract params', () => {
    recordJobGateExposure({ ready: true, enrolled: true, arm: 'spotlight_outline' });
    recordJobGateExposure({ ready: true, enrolled: true, arm: 'spotlight_outline' });
    expect(trackExperimentEvent).toHaveBeenCalledTimes(1);
    expect(trackExperimentEvent).toHaveBeenCalledWith('experiment_assigned', {
      experiment_id: 'jobgate-v5',
      variant: 'spotlight_outline',
    });
    expect(window.localStorage.getItem(JOBGATE_ASSIGNED_STORAGE_KEY)).toBe('spotlight_outline');

    // Next session (module memo reset) — already recorded for this browser.
    resetJobGateAssignmentForTests();
    recordJobGateExposure({ ready: true, enrolled: true, arm: 'spotlight_outline' });
    expect(trackExperimentEvent).toHaveBeenCalledTimes(1);
  });

  it('emits nothing for a visitor who is not enrolled', () => {
    recordJobGateExposure({ ready: true, enrolled: false, arm: 'spotlight' });
    expect(trackExperimentEvent).not.toHaveBeenCalled();
  });
});
