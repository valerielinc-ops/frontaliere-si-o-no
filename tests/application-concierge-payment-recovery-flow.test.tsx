import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({
  fetchService: vi.fn(), recoverSession: vi.fn(), signIn: vi.fn(), checkout: vi.fn(),
  view: vi.fn(), click: vi.fn(), resume: vi.fn(),
}));
vi.mock('@/services/i18n', () => ({
  getLocale: () => 'it', useLocale: () => ['it'], useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/authService', () => ({ signInWithCustomAuthToken: mocks.signIn }));
vi.mock('@/services/profileFirestore', () => ({ loadEnrichmentProfileFields: vi.fn() }));
vi.mock('@/services/assistedApplicationCheckout', () => ({ ensureAssistedApplicationAuth: vi.fn() }));
vi.mock('@/services/applicationConciergeCheckout', () => ({ createApplicationConciergeCheckout: mocks.checkout }));
vi.mock('@/services/analyticsProxy', () => ({ Analytics: {
  trackApplicationConciergeView: mocks.view, trackApplicationConciergeCheckoutClick: mocks.click,
  trackApplicationConciergeCheckoutResume: mocks.resume,
} }));
vi.mock('@/services/applicationConciergeService', () => ({
  fetchApplicationConciergeService: mocks.fetchService, recoverApplicationConciergePaymentSession: mocks.recoverSession,
  acceptApplicationConciergeProposal: vi.fn(), declineApplicationConciergeProposal: vi.fn(),
  recordApplicationConciergeConsent: vi.fn(), saveApplicationConciergeProfile: vi.fn(),
  getCandidateVisibleApplicationConciergeProposals: (proposals: unknown) => proposals,
}));
vi.mock('@/components/community/SumUpPaymentWidget', () => ({ default: ({ amountCents, onClose, onResponse }: any) => (
  <div role="dialog" aria-label="SumUp">{amountCents}<button onClick={onClose}>close</button><button onClick={() => onResponse('success')}>success</button></div>
) }));
import ApplicationConciergePortal from '@/components/community/ApplicationConciergePortal';
const owner = { uid: 'anonymous-owner', getIdToken: async () => 'test-token' };
const service = {
  serviceId: 'service-test', paymentStatus: 'pending', serviceStatus: 'awaiting_payment',
  checkoutSessionStatus: 'open', customerEmail: 'candidate@example.test', applicantLocation: 'Lugano',
  proposals: [], acceptedPositionsCount: 0, remainingPositions: 10, maxPositions: 10,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchService.mockResolvedValue(service);
  mocks.checkout.mockResolvedValue({ ok: true, paymentProvider: 'sumup', checkoutId: 'sumup-test', serviceId: 'service-test' });
});
afterEach(cleanup);

describe('concierge reminder payment flow', () => {
  it('waits for autologin, auto-opens embedded checkout once and tracks recovery instead of click', async () => {
    const { rerender } = render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} authLoading />);
    expect(mocks.fetchService).not.toHaveBeenCalled();
    rerender(<ApplicationConciergePortal serviceId="service-test" authUser={owner} authLoading={false} />);
    expect(await screen.findByRole('dialog', { name: 'SumUp' })).toHaveTextContent('3999');
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'service-test' }), owner);
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.click).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledOnce());
  });

  it('does not reopen the checkout while awaiting the verified webhook after success', async () => {
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await screen.findByRole('dialog', { name: 'SumUp' });
    fireEvent.click(screen.getByRole('button', { name: 'success' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.checkout).toHaveBeenCalledOnce();
    expect(mocks.resume).toHaveBeenCalledOnce();
  });

  it('offers login on an unsigned historic link without fetching or creating an anonymous checkout', async () => {
    const login = vi.fn();
    render(<ApplicationConciergePortal serviceId="service-test" onRequireAuth={login} />);
    fireEvent.click(await screen.findByRole('button', { name: 'jobBoard.authRequiredCta' }));
    expect(login).toHaveBeenCalledOnce();
    expect(mocks.fetchService).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it('recovers the original owner after verified recipient login on a historic link', async () => {
    const recipient = { uid: 'verified-user', emailVerified: true, getIdToken: async () => 'verified-token' };
    mocks.fetchService.mockRejectedValueOnce(new Error('service_not_found')).mockResolvedValue(service);
    mocks.recoverSession.mockResolvedValue('owner-token');
    mocks.signIn.mockResolvedValue(owner);
    render(<ApplicationConciergePortal serviceId="service-test" authUser={recipient} />);
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(mocks.recoverSession).toHaveBeenCalledWith(recipient, 'service-test');
    expect(mocks.signIn).toHaveBeenCalledWith('owner-token');
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'service-test' }), owner);
  });
});
