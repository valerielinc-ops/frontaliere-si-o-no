import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
const mocks = vi.hoisted(() => ({
  openChild: vi.fn(), childRender: vi.fn(), fetchService: vi.fn(), recoverSession: vi.fn(), signIn: vi.fn(), checkout: vi.fn(),
  widgetResponses: [] as Array<(type: string) => void>,
  view: vi.fn(), click: vi.fn(), resume: vi.fn(), ensureAuth: vi.fn(), auth: { currentUser: null as any },
}));
vi.mock('@/services/i18n', () => ({
  getLocale: () => 'it', useLocale: () => ['it'], useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/authService', () => ({ signInWithCustomAuthToken: mocks.signIn }));
vi.mock('@/services/profileFirestore', () => ({ loadEnrichmentProfileFields: vi.fn() }));
vi.mock('@/services/assistedApplicationCheckout', () => ({ ensureAssistedApplicationAuth: mocks.ensureAuth }));
vi.mock('@/services/firebase', () => ({ getApp: async () => ({}) }));
vi.mock('firebase/auth', () => ({ getAuth: () => mocks.auth }));
vi.mock('@/services/applicationConciergeCheckout', () => ({ createApplicationConciergeCheckout: mocks.checkout }));
vi.mock('@/services/analyticsProxy', () => ({ Analytics: {
  trackApplicationConciergeView: mocks.view, trackApplicationConciergeCheckoutClick: mocks.click,
  trackApplicationConciergeCheckoutResume: mocks.resume,
} }));
vi.mock('@/services/applicationConciergeService', () => ({
  openApplicationConciergeChildReview: mocks.openChild,
  fetchApplicationConciergeService: mocks.fetchService, recoverApplicationConciergePaymentSession: mocks.recoverSession,
  acceptApplicationConciergeProposal: vi.fn(), declineApplicationConciergeProposal: vi.fn(),
  recordApplicationConciergeConsent: vi.fn(), saveApplicationConciergeProfile: vi.fn(),
  getCandidateVisibleApplicationConciergeProposals: (proposals: unknown) => proposals,
}));
vi.mock('@/components/community/AssistedApplicationReview', () => ({ default: ({ token }: { token: string }) => {
  const [note, setNote] = useState('');
  mocks.childRender(token);
  return <div data-testid="child-review">{token}<input aria-label="Child review note" value={note} onChange={event => setNote(event.target.value)} /></div>;
} }));
vi.mock('@/components/community/SumUpPaymentWidget', () => ({ default: ({ amountCents, checkoutId, onClose, onResponse }: any) => {
  mocks.widgetResponses.push(onResponse);
  return <div role="dialog" aria-label="SumUp">{amountCents}<span>{checkoutId}</span><button onClick={onClose}>close</button><button onClick={() => onResponse('success')}>success</button></div>;
} }));
import ApplicationConciergePortal from '@/components/community/ApplicationConciergePortal';
const owner = { uid: 'anonymous-owner', getIdToken: async () => 'test-token' };
const service = {
  serviceId: 'service-test', paymentStatus: 'pending', serviceStatus: 'awaiting_payment',
  checkoutSessionStatus: 'open', customerEmail: 'candidate@example.test', applicantLocation: 'Lugano',
  proposals: [], acceptedPositionsCount: 0, remainingPositions: 10, maxPositions: 10,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.widgetResponses.length = 0;
  window.history.replaceState(null, '', '/');
  mocks.auth.currentUser = owner;
  mocks.fetchService.mockResolvedValue(service);
  mocks.checkout.mockResolvedValue({ ok: true, paymentProvider: 'sumup', checkoutId: 'sumup-test', serviceId: 'service-test' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('concierge child query navigation', () => {
  it('switches and reopens a child without rendering the previous token or retaining its edit state', async () => {
    mocks.fetchService.mockResolvedValue({ ...service, paymentStatus: 'paid', serviceStatus: 'active',
      proposals: [
        { proposalId: 'proposal-1', status: 'accepted', childApplicationId: 'child-1' },
        { proposalId: 'proposal-2', status: 'accepted', childApplicationId: 'child-2' },
      ] });
    let finishSecond!: (token: string) => void;
    const secondToken = new Promise<string>(resolve => { finishSecond = resolve; });
    mocks.openChild.mockResolvedValue('review-child-2').mockResolvedValueOnce('review-child-1').mockReturnValueOnce(secondToken);
    const parent = '?application_concierge_service_id=service-test';
    const childSearch = (id: string) => `${parent}&application_concierge_application_id=${id}`;
    const view = render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} locationSearch={childSearch('child-1')} />);
    expect(await screen.findByTestId('child-review')).toHaveTextContent('review-child-1');
    fireEvent.change(screen.getByLabelText('Child review note'), { target: { value: 'First child only' } });

    mocks.childRender.mockClear();
    view.rerender(<ApplicationConciergePortal serviceId="service-test" authUser={owner} locationSearch={childSearch('child-2')} />);
    expect(screen.queryByTestId('child-review')).toBeNull();
    expect(mocks.childRender).not.toHaveBeenCalledWith('review-child-1');
    await act(async () => { finishSecond('review-child-2'); await secondToken; });
    expect(await screen.findByTestId('child-review')).toHaveTextContent('review-child-2');
    expect(screen.getByLabelText('Child review note')).toHaveValue('');

    view.rerender(<ApplicationConciergePortal serviceId="service-test" authUser={owner} locationSearch={parent} />);
    expect(screen.queryByTestId('child-review')).toBeNull();
    view.rerender(<ApplicationConciergePortal serviceId="service-test" authUser={owner} locationSearch={childSearch('child-2')} />);
    expect(await screen.findByTestId('child-review')).toHaveTextContent('review-child-2');
    expect(mocks.openChild).toHaveBeenLastCalledWith(owner, 'service-test', 'proposal-2');
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
});

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

  it('automatically offers retry for a failed SumUp attempt and keeps the concierge amount', async () => {
    mocks.fetchService.mockResolvedValue({ ...service, paymentProvider: 'sumup', paymentStatus: 'failed',
      serviceStatus: 'payment_failed', checkoutSessionStatus: 'failed' });
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    expect(await screen.findByRole('dialog', { name: 'SumUp' })).toHaveTextContent('3999');
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'service-test' }), owner);
    const input = mocks.checkout.mock.calls[0][0];
    expect(new URL(input.successUrl).searchParams.get('application_concierge_payment_return')).toBe('1');
    expect(new URL(input.cancelUrl).searchParams.has('application_concierge_payment_return')).toBe(false);
  });

  it('waits for verification on a payment return instead of automatically reopening checkout', async () => {
    window.history.replaceState(null, '', '/?application_concierge_payment_return=1');
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await screen.findByRole('button', { name: /jobBoard.concierge.resumePayment/ });
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('revalidates the server checkout after closing and reopening the widget', async () => {
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await screen.findByRole('dialog', { name: 'SumUp' });
    const oldResponse = mocks.widgetResponses.at(-1)!;
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    mocks.checkout.mockResolvedValueOnce({ ok: true, paymentProvider: 'sumup', checkoutId: 'replacement-checkout', serviceId: 'service-test' });
    fireEvent.click(screen.getByRole('button', { name: /jobBoard.concierge.resumePayment/ }));
    expect(await screen.findByRole('dialog', { name: 'SumUp' })).toHaveTextContent('replacement-checkout');
    expect(mocks.checkout).toHaveBeenCalledTimes(2);
    const reads = mocks.fetchService.mock.calls.length;
    act(() => oldResponse('success'));
    expect(screen.getByRole('dialog', { name: 'SumUp' })).toHaveTextContent('replacement-checkout');
    expect(mocks.fetchService).toHaveBeenCalledTimes(reads);
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.click).toHaveBeenCalledOnce();
  });

  it.each(['unmount', 'service-change', 'sdk-owner-change'])('ignores a late Stripe redirect after %s', async (change) => {
    const actualWindow = window;
    const assign = vi.fn();
    vi.stubGlobal('window', new Proxy(actualWindow, { get(target, key) {
      if (key === 'location') return { href: actualWindow.location.href, pathname: actualWindow.location.pathname,
        search: actualWindow.location.search, assign };
      return Reflect.get(target, key, target);
    } }));
    let resolveCheckout!: (value: any) => void;
    const pending = new Promise((resolve) => { resolveCheckout = resolve; });
    mocks.checkout.mockReturnValueOnce(pending);
    const view = render(<ApplicationConciergePortal key="first" serviceId="service-test" authUser={owner} />);
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledOnce());
    if (change === 'unmount') view.unmount();
    else if (change === 'service-change') view.rerender(<ApplicationConciergePortal key="second" serviceId="another-service" authUser={owner} authLoading />);
    else mocks.auth.currentUser = { ...owner, uid: 'another-owner' };
    await act(async () => {
      resolveCheckout({ ok: true, paymentProvider: 'stripe', url: 'https://checkout.stripe.com/test/', serviceId: 'service-test' });
      await pending;
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps the typed email and in-flight SumUp request through the first anonymous sign-in', async () => {
    const anonymous = { uid: 'new-anonymous-owner', isAnonymous: true, getIdToken: async () => 'anonymous-token' };
    mocks.auth.currentUser = null;
    let notifyAuth!: (user: any) => void;
    function LandingHost() {
      const [user, setUser] = useState<any>(null);
      notifyAuth = setUser;
      return <ApplicationConciergePortal entry authUser={user} />;
    }
    render(<LandingHost />);
    mocks.ensureAuth.mockImplementationOnce(async () => {
      mocks.auth.currentUser = anonymous;
      notifyAuth(anonymous);
      return anonymous;
    });
    let resolveCheckout!: (value: any) => void;
    const pending = new Promise((resolve) => { resolveCheckout = resolve; });
    mocks.checkout.mockReturnValueOnce(pending);
    const input = screen.getByRole('textbox', { name: /jobBoard\.concierge\.email/ });
    fireEvent.change(input, { target: { value: 'typed-recipient@example.test' } });
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledOnce());
    expect(input).toHaveValue('typed-recipient@example.test');
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: 'typed-recipient@example.test' }), anonymous);
    await act(async () => {
      resolveCheckout({ ok: true, paymentProvider: 'sumup', checkoutId: 'initial-checkout', serviceId: 'initial-service' });
      await pending;
    });
    expect(await screen.findByRole('dialog', { name: 'SumUp' })).toHaveTextContent('initial-checkout');
    expect(mocks.checkout).toHaveBeenCalledOnce();
  });

  it.each(['logout', 'owner-switch'])('clears the previous landing form and widget on %s', async (change) => {
    const firstOwner = { ...owner, email: 'first-owner@example.test' };
    mocks.auth.currentUser = firstOwner;
    const view = render(<ApplicationConciergePortal entry authUser={firstOwner} />);
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await screen.findByRole('dialog', { name: 'SumUp' });
    const nextOwner = change === 'logout' ? null : { ...owner, uid: 'next-owner', email: 'next-owner@example.test' };
    mocks.auth.currentUser = nextOwner;
    view.rerender(<ApplicationConciergePortal entry authUser={nextOwner} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('textbox', { name: /jobBoard\.concierge\.email/ })).toHaveValue(nextOwner?.email || '');
    expect(mocks.checkout).toHaveBeenCalledOnce();
  });

  it('does not apply late anonymous auth over a different SDK owner', async () => {
    mocks.auth.currentUser = null;
    let notifyAuth!: (user: any) => void;
    function LandingHost() {
      const [user, setUser] = useState<any>(null);
      notifyAuth = setUser;
      return <ApplicationConciergePortal entry authUser={user} />;
    }
    render(<LandingHost />);
    let resolveAuth!: (value: any) => void;
    const pending = new Promise((resolve) => { resolveAuth = resolve; });
    mocks.ensureAuth.mockReturnValueOnce(pending);
    fireEvent.change(screen.getByRole('textbox', { name: /jobBoard\.concierge\.email/ }), { target: { value: 'typed@example.test' } });
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await waitFor(() => expect(mocks.ensureAuth).toHaveBeenCalledOnce());
    const nextOwner = { ...owner, uid: 'chosen-owner', email: 'chosen@example.test' };
    act(() => { mocks.auth.currentUser = nextOwner; notifyAuth(nextOwner); });
    await act(async () => { resolveAuth({ uid: 'late-anonymous', getIdToken: async () => 'old-token' }); await pending; });
    expect(mocks.checkout).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(mocks.checkout).toHaveBeenCalledWith(expect.anything(), nextOwner);
  });

  it('ignores a cached SumUp callback after the SDK owner changes before prop notification', async () => {
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await screen.findByRole('dialog', { name: 'SumUp' });
    const reads = mocks.fetchService.mock.calls.length;
    mocks.auth.currentUser = { ...owner, uid: 'another-owner' };
    fireEvent.click(screen.getByRole('button', { name: 'success' }));
    expect(screen.getByRole('dialog', { name: 'SumUp' })).toBeTruthy();
    expect(mocks.fetchService).toHaveBeenCalledTimes(reads);
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
    let rerender: ReturnType<typeof render>['rerender'];
    mocks.auth.currentUser = recipient;
    mocks.signIn.mockImplementationOnce(async () => {
      mocks.auth.currentUser = owner;
      rerender(<ApplicationConciergePortal key={owner.uid} serviceId="service-test" authUser={owner} />);
      return owner;
    });
    const view = render(<ApplicationConciergePortal key={recipient.uid} serviceId="service-test" authUser={recipient} />);
    rerender = view.rerender;
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(mocks.recoverSession).toHaveBeenCalledWith(recipient, 'service-test');
    expect(mocks.signIn).toHaveBeenCalledWith('owner-token');
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'service-test' }), owner);
  });
});


it('links an accepted application needing answers to its owned service detail', async () => {
  mocks.fetchService.mockResolvedValue({ ...service, paymentStatus: 'paid', serviceStatus: 'active', hasCv: true, hasConsent: true,
    proposals: [{ proposalId: 'proposal', jobId: 'job', jobTitle: 'Example role', companyName: 'Example', status: 'accepted', childApplicationId: 'owned-child', childApplicationState: 'needs_candidate_action' }] });
  render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
  const link = await screen.findByRole('link', { name: /jobBoard.concierge.answerChild/ });
  expect(link.getAttribute('href')).toContain('application_concierge_application_id=owned-child');
  expect(link.getAttribute('href')).not.toContain('assisted_application_review');
  expect(mocks.checkout).not.toHaveBeenCalled();
});

describe('concierge qualification feedback', () => {
  it.each([
    [7, 0, 'verificationPending'],
    [0, 3, 'qualificationNeedsDetails'],
  ])('does not present incomplete qualification as no jobs (%s, %s)', async (unverified, clarification, key) => {
    mocks.fetchService.mockResolvedValue({ ...service, paymentStatus: 'paid', serviceStatus: 'active',
      matchingStatus: 'complete', matchingUnverifiedCount: unverified, matchingClarificationCount: clarification });
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    expect(await screen.findByText(`jobBoard.concierge.${key}`)).toBeTruthy();
    expect(screen.queryByText('jobBoard.concierge.noProposals')).toBeNull();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it.each(['expired', 'capped'])('does not promise automatic verification for a %s service', async mode => {
    mocks.fetchService.mockResolvedValue({ ...service, paymentStatus: 'paid', serviceStatus: mode === 'expired' ? 'expired' : 'active',
      remainingPositions: mode === 'capped' ? 0 : 10, matchingStatus: 'complete', matchingUnverifiedCount: 7, matchingClarificationCount: 3 });
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await screen.findByText('jobBoard.concierge.portalTitle');
    expect(screen.queryByText('jobBoard.concierge.verificationPending')).toBeNull();
    expect(screen.queryByText('jobBoard.concierge.qualificationNeedsDetails')).toBeNull();
  });
});
