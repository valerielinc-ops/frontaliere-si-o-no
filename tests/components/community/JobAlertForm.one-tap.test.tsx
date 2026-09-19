import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JobAlertForm from '@/components/community/JobAlertForm';

const { createAlertMock, getJobAlertEligibilityMock } = vi.hoisted(() => ({
  createAlertMock: vi.fn(async () => ({ id: 'one-tap-alert' })),
  getJobAlertEligibilityMock: vi.fn(async () => ({ eligible: true, reason: null })),
}));

vi.mock('@/services/jobAlertService', () => ({
  createAlert: createAlertMock,
  getUserAlerts: vi.fn(async () => []),
  deleteAlert: vi.fn(async () => undefined),
  updateAlert: vi.fn(async () => undefined),
}));

vi.mock('@/services/jobAlertEligibility', () => ({
  getJobAlertEligibility: getJobAlertEligibilityMock,
}));

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackJobAlertCtaClick: vi.fn(),
    trackJobAlertCtaShown: vi.fn(),
    trackJobAlertCreated: vi.fn(),
    trackJobAlertDeleted: vi.fn(),
  },
}));

vi.mock('@/services/profileFirestore', () => ({
  loadEnrichmentProfileFields: vi.fn(async () => ({})),
}));

describe('JobAlertForm — contextual one-tap creation', () => {
  beforeEach(() => {
    createAlertMock.mockClear();
    getJobAlertEligibilityMock.mockClear();
    getJobAlertEligibilityMock.mockResolvedValue({ eligible: true, reason: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('creates the prefilled alert directly for an authenticated eligible user', async () => {
    render(
      <JobAlertForm
        authUser={{ uid: 'user-1', email: 'foo@example.com' }}
        initialKeyword="infermiere"
        initialCantonCode="TI"
      />,
    );

    const oneTap = await screen.findByTestId('job-alert-one-tap');
    fireEvent.click(oneTap);

    await waitFor(() => expect(createAlertMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(createAlertMock).toHaveBeenCalledWith(
      'user-1',
      'foo@example.com',
      expect.objectContaining({
        keywords: ['infermiere'],
        cantonFilter: ['TI'],
        frequency: 'weekly',
      }),
    );
  });

  it('does not render the shortcut when the existing eligibility gate rejects it', async () => {
    getJobAlertEligibilityMock.mockResolvedValue({ eligible: false, reason: 'already_subscribed' });
    render(
      <JobAlertForm
        authUser={{ uid: 'user-1', email: 'foo@example.com' }}
        initialKeyword="infermiere"
      />,
    );

    await waitFor(() => expect(getJobAlertEligibilityMock).toHaveBeenCalledWith('user-1', 'infermiere'));
    expect(screen.queryByTestId('job-alert-one-tap')).toBeNull();
  });
});
