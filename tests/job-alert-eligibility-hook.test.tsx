import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Analytics } from '@/services/analytics';
import {
  getJobAlertEligibility,
  type JobAlertEligibility,
} from '@/services/jobAlertEligibility';
import {
  useJobAlertEligibility,
  type JobAlertEligibilitySurface,
} from '@/hooks/useJobAlertEligibility';

vi.mock('@/services/jobAlertEligibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/jobAlertEligibility')>();
  return { ...actual, getJobAlertEligibility: vi.fn() };
});

const getEligibilityMock = vi.mocked(getJobAlertEligibility);
const surfaces: JobAlertEligibilitySurface[] = ['sticky_banner', 'end_card', 'job_detail_button'];

describe('useJobAlertEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(surfaces)('emits one skip event for the ineligible %s surface', async (surface) => {
    const decision: JobAlertEligibility = { eligible: false, reason: 'already_subscribed' };
    getEligibilityMock.mockResolvedValue(decision);

    const { result } = renderHook(() => useJobAlertEligibility({
      enabled: true,
      authResolved: true,
      userId: 'user-1',
      keyword: 'Tecnologia',
      surface,
    }));

    await waitFor(() => expect(result.current).toBe(false));

    expect(getEligibilityMock).toHaveBeenCalledWith('user-1', 'Tecnologia');
    expect(Analytics.trackJobAlertCtaSkipped).toHaveBeenCalledWith(surface, 'already_subscribed');
    expect(Analytics.trackJobAlertCtaSkipped).toHaveBeenCalledTimes(1);
  });

  it('fails closed and reports a read failure without rendering the CTA', async () => {
    getEligibilityMock.mockRejectedValue(new Error('Firestore unavailable'));

    const { result } = renderHook(() => useJobAlertEligibility({
      enabled: true,
      authResolved: true,
      userId: 'user-1',
      keyword: 'Tecnologia',
      surface: 'end_card',
    }));

    await waitFor(() => expect(result.current).toBe(false));

    expect(Analytics.trackJobAlertCtaSkipped).toHaveBeenCalledWith('end_card', 'get_alerts_failed');
  });
});
