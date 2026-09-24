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

const ARMS_4 = '{"control":25,"similar_alerts":25,"social_first":25,"email_first":25}';

describe('useJobGateExperiment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobGateAssignmentForTests();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts pending (renders control) and stays out of the experiment with the shipped defaults', async () => {
    remoteConfig({ JOBGATE_EXPERIMENT_ENABLED: 'false', JOBGATE_EXPERIMENT_ARMS: '{"control":100}' });
    const { result } = renderHook(() => useJobGateExperiment());
    expect(result.current).toEqual({ ready: false, enrolled: false, arm: 'control' });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ ready: true, enrolled: false, arm: 'control' });
    expect(getJobGateTelemetryParams()).toBeNull();
  });

  it('assigns a sticky arm from the visitor id when enabled', async () => {
    remoteConfig({ JOBGATE_EXPERIMENT_ENABLED: 'true', JOBGATE_EXPERIMENT_ARMS: ARMS_4 });
    const first = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    expect(first.result.current.enrolled).toBe(true);
    const arm = first.result.current.arm;

    // A later page view (fresh module memo, same browser id) gets the same arm.
    resetJobGateAssignmentForTests();
    const second = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(second.result.current.arm).toBe(arm);
    expect(getJobGateTelemetryParams()).toEqual({ experiment_id: 'jobgate-v3', variant: arm });
  });

  it('honours JOBGATE_EXPERIMENT_FORCE', async () => {
    remoteConfig({ JOBGATE_EXPERIMENT_ENABLED: 'true', JOBGATE_EXPERIMENT_ARMS: ARMS_4, JOBGATE_EXPERIMENT_FORCE: 'social_first' });
    const { result } = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ ready: true, enrolled: true, arm: 'social_first' });
  });

  it('keeps crawlers/bots out without reading Remote Config', async () => {
    remoteConfig({ JOBGATE_EXPERIMENT_ENABLED: 'true', JOBGATE_EXPERIMENT_FORCE: 'email_first' });
    const { result } = renderHook(() => useJobGateExperiment(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.enrolled).toBe(false);
    expect(getConfigValueMock).not.toHaveBeenCalled();
    // …and their subscriber write is not tagged either.
    await expect(currentJobGateAssignment()).resolves.toEqual({ ready: true, enrolled: false, arm: 'control' });
  });

  it('falls back to not-enrolled when Remote Config throws', async () => {
    getConfigValueMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useJobGateExperiment());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ ready: true, enrolled: false, arm: 'control' });
  });

  it('falls back to not-enrolled when Remote Config is slower than the timeout', async () => {
    vi.useFakeTimers();
    getConfigValueMock.mockImplementation(() => new Promise<string>(() => {}));
    const pending = loadJobGateAssignment();
    await act(async () => {
      vi.advanceTimersByTime(JOBGATE_LOAD_TIMEOUT_MS + 1);
    });
    await expect(pending).resolves.toEqual({ ready: true, enrolled: false, arm: 'control' });
  });
});

describe('recordJobGateExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobGateAssignmentForTests();
    window.localStorage.clear();
  });

  it('emits experiment_assigned once per visitor with the contract params', () => {
    recordJobGateExposure({ ready: true, enrolled: true, arm: 'email_first' });
    recordJobGateExposure({ ready: true, enrolled: true, arm: 'email_first' });
    expect(trackExperimentEvent).toHaveBeenCalledTimes(1);
    expect(trackExperimentEvent).toHaveBeenCalledWith('experiment_assigned', {
      experiment_id: 'jobgate-v3',
      variant: 'email_first',
    });
    expect(window.localStorage.getItem(JOBGATE_ASSIGNED_STORAGE_KEY)).toBe('email_first');

    // Next session (module memo reset) — already recorded for this browser.
    resetJobGateAssignmentForTests();
    recordJobGateExposure({ ready: true, enrolled: true, arm: 'email_first' });
    expect(trackExperimentEvent).toHaveBeenCalledTimes(1);
  });

  it('emits nothing for a visitor who is not enrolled', () => {
    recordJobGateExposure({ ready: true, enrolled: false, arm: 'control' });
    expect(trackExperimentEvent).not.toHaveBeenCalled();
  });
});
