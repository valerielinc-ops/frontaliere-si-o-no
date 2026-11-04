import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JobAlertForm from '@/components/community/JobAlertForm';

const {
  createAlertMock,
  getJobAlertEligibilityMock,
  ctaClickMock,
  createdMock,
} = vi.hoisted(() => ({
  ctaClickMock: vi.fn(),
  createAlertMock: vi.fn(async () => ({ id: 'one-tap-alert' })),
  getJobAlertEligibilityMock: vi.fn(async () => ({ eligible: true, reason: null })),
  createdMock: vi.fn(),
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
    trackJobAlertCtaSkipped: vi.fn(),
    trackJobAlertPassiveView: vi.fn(),
    trackJobAlertCreated: createdMock,
    trackJobAlertDeleted: vi.fn(),
  },
}));

vi.mock('@/services/profileFirestore', () => ({
  loadEnrichmentProfileFields: vi.fn(async () => ({})),
}));

describe('JobAlertForm — contextual one-tap creation', () => {
  beforeEach(() => {
    localStorage.clear();
    createAlertMock.mockClear();
    ctaClickMock.mockClear();
    createdMock.mockClear();
    getJobAlertEligibilityMock.mockClear();
    getJobAlertEligibilityMock.mockResolvedValue({ eligible: true, reason: null });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('submits the explicit card directly for a guest and replays its keyword and canton after auth', async () => {
    const onRequireAuth = vi.fn();
    const { rerender } = render(
      <JobAlertForm
        authUser={null}
        onRequireAuth={onRequireAuth}
        initialKeyword="infermiere"
        initialCantonCode="TI"
      />,
    );

    fireEvent.click(screen.getAllByRole('button')[0]);

    await waitFor(() => expect(onRequireAuth).toHaveBeenCalledTimes(1));
    expect(JSON.parse(localStorage.getItem('pending_job_alert') || 'null')).toMatchObject({
      config: expect.objectContaining({
        keywords: ['infermiere'],
        cantonFilter: ['TI'],
      }),
      origin: 'inline_card',
    });
    expect(ctaClickMock).toHaveBeenCalledWith('inline_card', 'accept', 'infermiere');

    rerender(
      <JobAlertForm
        authUser={{ uid: 'user-1', email: 'foo@example.com' }}
        initialKeyword="infermiere"
        initialCantonCode="TI"
      />,
    );

    await waitFor(() => expect(createAlertMock).toHaveBeenCalledWith(
      'user-1',
      'foo@example.com',
      expect.objectContaining({ keywords: ['infermiere'], cantonFilter: ['TI'] }),
    ));
    expect(createdMock).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'inline_card',
      authPath: 'post_auth_replay',
    }));
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

  it('uses the explicit trigger card as the authenticated one-tap action', async () => {
    render(
      <JobAlertForm
        authUser={{ uid: 'user-1', email: 'foo@example.com' }}
        initialKeyword="infermiere"
        initialCantonCode="TI"
      />,
    );

    await screen.findByTestId('job-alert-one-tap');
    const triggerCard = document.querySelector<HTMLButtonElement>('button[aria-controls="job-alert-form"]');
    expect(triggerCard).not.toBeNull();
    fireEvent.click(triggerCard!);

    await waitFor(() => expect(createAlertMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(ctaClickMock.mock.calls).toEqual([
      ['inline_card', 'accept', 'infermiere'],
      ['inline_card', 'success', 'infermiere'],
    ]);
    expect(document.getElementById('job-alert-form')).toBeNull();
  });

  it.each([
    { city: 'Lugano', canton: 'TI', canonical: 'lugano' },
    { city: 'Basel', canton: 'BS', canonical: 'basel' },
  ])('stores the canonical location for the $city one-tap alert payload', async ({ city, canton, canonical }) => {
    render(
      <JobAlertForm
        authUser={{ uid: 'user-1', email: 'foo@example.com' }}
        initialKeyword="nurse"
        initialCantonCode={canton}
        initialLocations={[city]}
      />,
    );

    fireEvent.click(await screen.findByTestId('job-alert-one-tap'));

    await waitFor(() => expect(createAlertMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(createAlertMock).toHaveBeenCalledWith(
      'user-1',
      'foo@example.com',
      expect.objectContaining({
        keywords: ['nurse'],
        locations: [canonical],
        cantonFilter: [canton],
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
