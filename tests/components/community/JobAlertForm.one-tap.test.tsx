import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JobAlertForm from '@/components/community/JobAlertForm';

const { createAlertMock, getJobAlertEligibilityMock, ctaClickMock } = vi.hoisted(() => ({
  ctaClickMock: vi.fn(),
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
    trackJobAlertCtaClick: ctaClickMock,
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
    ctaClickMock.mockClear();
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

  // Issue 9577 — the one-tap create is an inline_card attempt like the form
  // submit, so it reports the same accept→success/error chain.
  it('reports accept→success on the inline_card surface', async () => {
    render(<JobAlertForm authUser={{ uid: 'user-1', email: 'foo@example.com' }} initialKeyword="infermiere" />);
    fireEvent.click(await screen.findByTestId('job-alert-one-tap'));
    await waitFor(() => expect(createAlertMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await waitFor(() =>
      expect(ctaClickMock.mock.calls).toEqual([
        ['inline_card', 'accept', 'infermiere'],
        ['inline_card', 'success', 'infermiere'],
      ]),
    );
  });

  it('reports accept→error when the one-tap create fails', async () => {
    createAlertMock.mockRejectedValueOnce(new Error('quota'));
    render(<JobAlertForm authUser={{ uid: 'user-1', email: 'foo@example.com' }} initialKeyword="infermiere" />);
    fireEvent.click(await screen.findByTestId('job-alert-one-tap'));
    await waitFor(() =>
      expect(ctaClickMock.mock.calls).toEqual([
        ['inline_card', 'accept', 'infermiere'],
        ['inline_card', 'error', 'infermiere'],
      ]),
    { timeout: 3000 });
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
