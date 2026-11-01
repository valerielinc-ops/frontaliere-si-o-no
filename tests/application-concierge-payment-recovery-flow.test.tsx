import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
const mocks = vi.hoisted(() => ({
  openChild: vi.fn(), childRender: vi.fn(), fetchService: vi.fn(), recoverSession: vi.fn(), signIn: vi.fn(), checkout: vi.fn(),
  widgetResponses: [] as Array<(type: string) => void>,
  view: vi.fn(), click: vi.fn(), resume: vi.fn(), accessLink: vi.fn(), sendVerification: vi.fn(), auth: { currentUser: null as any },
}));
vi.mock('@/services/i18n', () => ({
  getLocale: () => 'it', useLocale: () => ['it'], useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/authService', () => ({ signInWithCustomAuthToken: mocks.signIn, getAuthEmail: (user: any) => user?.email || null }));
vi.mock('@/services/profileFirestore', () => ({ loadEnrichmentProfileFields: vi.fn() }));
vi.mock('@/components/community/SignupPromptModal', () => ({
  default: ({ intent }: { intent: string }) => <div role="dialog" aria-label="Signup prompt">{intent}</div>,
  requestConciergeAccessLink: mocks.accessLink,
}));
vi.mock('@/services/firebase', () => ({ getApp: async () => ({}) }));
vi.mock('firebase/auth', () => ({ getAuth: () => mocks.auth, sendEmailVerification: mocks.sendVerification }));
vi.mock('@/services/applicationConciergeCheckout', () => ({ createApplicationConciergeCheckout: mocks.checkout }));
vi.mock('@/services/analyticsProxy', () => ({ Analytics: {
  trackApplicationConciergeView: mocks.view, trackApplicationConciergeCheckoutClick: mocks.click,
  trackApplicationConciergeCheckoutResume: mocks.resume,
} }));
vi.mock('@/services/applicationConciergeService', async importOriginal => ({
  ...await importOriginal<typeof import('../services/applicationConciergeService')>(),
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
function makeDocumentVisible() {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  return () => {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
  };
}
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
  mocks.fetchService.mockReset().mockResolvedValue(service);
  mocks.checkout.mockResolvedValue({ ok: true, paymentProvider: 'sumup', checkoutId: 'sumup-test', serviceId: 'service-test' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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

  const verifiedOwner = { ...owner, uid: 'verified-owner', email: 'account@example.test', emailVerified: true };

  it('never asks for an email on the landing: a verified account pays with its own address', async () => {
    mocks.auth.currentUser = verifiedOwner;
    render(<ApplicationConciergePortal entry authUser={verifiedOwner} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(mocks.checkout).toHaveBeenCalledOnce();
    expect(mocks.checkout.mock.calls[0][0]).not.toHaveProperty('customerEmail');
    expect(mocks.checkout.mock.calls[0][1]).toBe(verifiedOwner);
  });

  it.each([
    ['logged out', null],
    ['a leftover anonymous session', { uid: 'anon', isAnonymous: true, getIdToken: async () => 'anon-token' }],
  ])('opens the sign-up prompt when %s, and resumes the click once the account is verified', async (_label, start) => {
    mocks.auth.currentUser = start;
    const view = render(<ApplicationConciergePortal entry authUser={start} />);
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    expect(await screen.findByRole('dialog', { name: 'Signup prompt' })).toHaveTextContent('concierge');
    expect(mocks.checkout).not.toHaveBeenCalled();
    mocks.auth.currentUser = verifiedOwner;
    view.rerender(<ApplicationConciergePortal entry authUser={verifiedOwner} />);
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(screen.queryByRole('dialog', { name: 'Signup prompt' })).toBeNull();
    expect(mocks.checkout).toHaveBeenCalledOnce();
  });

  it('resumes the click after the email link opened the page in a new tab', async () => {
    window.localStorage.setItem('application-concierge-activation-intent', String(Date.now()));
    mocks.auth.currentUser = verifiedOwner;
    render(<ApplicationConciergePortal entry authUser={verifiedOwner} />);
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(window.localStorage.getItem('application-concierge-activation-intent')).toBeNull();
  });

  it('ignores an activation click older than its time limit', async () => {
    window.localStorage.setItem('application-concierge-activation-intent', String(Date.now() - 2 * 60 * 60 * 1000));
    mocks.auth.currentUser = verifiedOwner;
    render(<ApplicationConciergePortal entry authUser={verifiedOwner} />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it('holds an unverified account at the confirmation step and sends the link to its address', async () => {
    const unverified = { ...verifiedOwner, emailVerified: false, reload: vi.fn(async () => {}), getIdToken: vi.fn(async () => 'token') };
    mocks.auth.currentUser = unverified;
    mocks.accessLink.mockResolvedValue(undefined);
    render(<ApplicationConciergePortal entry authUser={unverified} />);
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'jobBoard.concierge.confirmEmailCta' }));
    await screen.findByText('jobBoard.concierge.confirmEmailSent');
    expect(mocks.accessLink).toHaveBeenCalledWith('account@example.test', 'it');
    expect(unverified.reload).toHaveBeenCalledOnce();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it('sends a password account the Firebase verification, because the site link cannot verify it', async () => {
    const passwordUser = { ...verifiedOwner, emailVerified: false, providerData: [{ providerId: 'password' }], reload: vi.fn(async () => {}) };
    mocks.auth.currentUser = passwordUser;
    mocks.sendVerification.mockResolvedValue(undefined);
    render(<ApplicationConciergePortal entry authUser={passwordUser} />);
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'jobBoard.concierge.confirmEmailCta' }));
    await screen.findByText('jobBoard.concierge.confirmEmailSent');
    expect(mocks.sendVerification).toHaveBeenCalledWith(passwordUser, { url: window.location.href });
    expect(mocks.accessLink).not.toHaveBeenCalled();
  });

  it('lets an account verified in another tab pay after re-reading it from Firebase', async () => {
    const stale = { ...verifiedOwner, emailVerified: false };
    const live = { ...stale, reload: vi.fn(async () => { live.emailVerified = true; }), getIdToken: vi.fn(async () => 'fresh-token') };
    mocks.auth.currentUser = live;
    render(<ApplicationConciergePortal entry authUser={stale} />);
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(live.getIdToken).toHaveBeenCalledWith(true);
  });

  it.each(['logout', 'owner-switch'])('clears the previous landing state and widget on %s', async (change) => {
    const firstOwner = { ...owner, email: 'first-owner@example.test', emailVerified: true };
    mocks.auth.currentUser = firstOwner;
    const view = render(<ApplicationConciergePortal entry authUser={firstOwner} />);
    fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await screen.findByRole('dialog', { name: 'SumUp' });
    const nextOwner = change === 'logout' ? null : { ...owner, uid: 'next-owner', email: 'next-owner@example.test', emailVerified: true };
    mocks.auth.currentUser = nextOwner;
    view.rerender(<ApplicationConciergePortal entry authUser={nextOwner} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('application-concierge-account-hint')).toHaveTextContent(nextOwner ? 'jobBoard.concierge.accountEmailHint' : 'jobBoard.concierge.signInHint');
    expect(mocks.checkout).toHaveBeenCalledOnce();
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

it('shows proposals added after matching completes while the concierge page stays open', async () => {
  const restoreVisibility = makeDocumentVisible();
  vi.useFakeTimers();
  const completed = { ...service, paymentStatus: 'paid', serviceStatus: 'active', matchingStatus: 'complete', proposals: [] };
  const refreshed = {
    ...completed,
    proposals: [{
      proposalId: 'lifecycle-proposal', jobId: 'job-new', jobUrl: 'https://jobs.example.test/new-role',
      companyId: 'company-new', companyName: 'New Example AG', jobTitle: 'Lifecycle-created role', status: 'proposed',
    }],
  };
  mocks.fetchService.mockReset().mockResolvedValueOnce(completed).mockResolvedValueOnce(refreshed);
  try {
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('jobBoard.concierge.noProposals')).toBeTruthy();
    expect(mocks.fetchService).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(mocks.fetchService).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Lifecycle-created role')).toBeTruthy();
  } finally {
    restoreVisibility();
  }
});

it('refreshes an accepted application response while the Concierge page stays open', async () => {
  const restoreVisibility = makeDocumentVisible();
  vi.useFakeTimers();
  const base = { ...service, paymentStatus: 'paid', serviceStatus: 'active', matchingStatus: 'complete' };
  const proposal = {
    proposalId: 'response-proposal', jobId: 'job-response', jobTitle: 'Example role', companyName: 'Example',
    status: 'accepted', childApplicationId: 'response-child', childApplicationState: 'submitted',
    childCandidateStatus: 'submitted', childSendState: 'sent',
  };
  const before = { ...base, proposals: [proposal] };
  const after = { ...before, proposals: [{ ...proposal, childEmployerResponse: { category: 'interview_invite', receivedAt: 1700000000000, needsReply: true } }] };
  mocks.fetchService.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  try {
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    expect(await screen.findByText('Example role')).toBeTruthy();
    expect(screen.queryByText('jobBoard.assisted.employerResponse.interview_invite')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(await screen.findByText('jobBoard.assisted.employerResponse.interview_invite')).toBeTruthy();
    expect(screen.getByText('jobBoard.assisted.employerResponse.needsReply')).toBeTruthy();
  } finally {
    restoreVisibility();
  }
});

it('refreshes completed proposals immediately when the user returns to the concierge page', async () => {
  const restoreVisibility = makeDocumentVisible();
  const completed = { ...service, paymentStatus: 'paid', serviceStatus: 'active', matchingStatus: 'complete', proposals: [] };
  const refreshed = {
    ...completed,
    proposals: [{
      proposalId: 'foreground-proposal', jobId: 'job-foreground', jobUrl: 'https://jobs.example.test/foreground-role',
      companyId: 'company-foreground', companyName: 'Foreground Example AG', jobTitle: 'New proposal after focus', status: 'proposed',
    }],
  };
  mocks.fetchService.mockReset().mockResolvedValueOnce(completed).mockResolvedValueOnce(refreshed);
  try {
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);

    expect(await screen.findByText('jobBoard.concierge.noProposals')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.focus(window);

    expect(await screen.findByText('New proposal after focus')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(mocks.fetchService).toHaveBeenCalledTimes(2);
  } finally {
    restoreVisibility();
  }
});

it('ignores a late settled refresh after switching to another concierge service', async () => {
  const restoreVisibility = makeDocumentVisible();
  const focusListener = vi.spyOn(window, 'addEventListener');
  const oldService = { ...service, paymentStatus: 'paid', serviceStatus: 'active', matchingStatus: 'complete', proposals: [] };
  const currentService = {
    ...oldService, serviceId: 'service-current',
    proposals: [{
      proposalId: 'current-proposal', jobId: 'job-current', jobUrl: 'https://jobs.example.test/current-role',
      companyId: 'company-current', companyName: 'Current Example AG', jobTitle: 'Current service proposal', status: 'proposed',
    }],
  };
  const staleService = {
    ...oldService,
    proposals: [{
      proposalId: 'stale-proposal', jobId: 'job-stale', jobUrl: 'https://jobs.example.test/stale-role',
      companyId: 'company-stale', companyName: 'Stale Example AG', jobTitle: 'Stale service proposal', status: 'proposed',
    }],
  };
  let resolveStale!: (value: typeof staleService) => void;
  const pendingStaleRefresh = new Promise<typeof staleService>(resolve => { resolveStale = resolve; });
  mocks.fetchService.mockReset()
    .mockResolvedValueOnce(oldService)
    .mockReturnValueOnce(pendingStaleRefresh)
    .mockResolvedValueOnce(currentService);

  try {
    const view = render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    expect(await screen.findByText('jobBoard.concierge.noProposals')).toBeTruthy();
    await waitFor(() => expect(focusListener).toHaveBeenCalledWith('focus', expect.any(Function)));
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.fetchService).toHaveBeenCalledTimes(2));

    view.rerender(<ApplicationConciergePortal serviceId="service-current" authUser={owner} />);
    expect(await screen.findByText('Current service proposal')).toBeTruthy();

    await act(async () => {
      resolveStale(staleService);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Current service proposal')).toBeTruthy();
    expect(screen.queryByText('Stale service proposal')).toBeNull();
  } finally {
    focusListener.mockRestore();
    restoreVisibility();
  }
});

it('ignores a late settled refresh after switching candidate accounts', async () => {
  const restoreVisibility = makeDocumentVisible();
  const focusListener = vi.spyOn(window, 'addEventListener');
  const oldService = { ...service, paymentStatus: 'paid', serviceStatus: 'active', matchingStatus: 'complete', proposals: [] };
  const nextService = {
    ...oldService,
    serviceId: 'service-next-owner',
    proposals: [{
      proposalId: 'next-account-proposal', jobId: 'job-next-account', jobUrl: 'https://jobs.example.test/next-account-role',
      companyId: 'company-next-account', companyName: 'Next Account AG', jobTitle: 'Next account proposal', status: 'proposed',
    }],
  };
  const staleService = {
    ...oldService,
    proposals: [{
      proposalId: 'old-account-proposal', jobId: 'job-old-account', jobUrl: 'https://jobs.example.test/old-account-role',
      companyId: 'company-old-account', companyName: 'Old Account AG', jobTitle: 'Old account proposal', status: 'proposed',
    }],
  };
  const nextOwner = { uid: 'next-owner', getIdToken: async () => 'next-owner-token' };
  let resolveStale!: (value: typeof staleService) => void;
  const pendingStaleRefresh = new Promise<typeof staleService>(resolve => { resolveStale = resolve; });
  mocks.fetchService.mockReset()
    .mockResolvedValue(nextService)
    .mockResolvedValueOnce(oldService)
    .mockReturnValueOnce(pendingStaleRefresh);

  try {
    const view = render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    expect(await screen.findByText('jobBoard.concierge.noProposals')).toBeTruthy();
    await waitFor(() => expect(focusListener).toHaveBeenCalledWith('focus', expect.any(Function)));
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.fetchService).toHaveBeenCalledTimes(2));

    view.rerender(<ApplicationConciergePortal serviceId="service-next-owner" authUser={nextOwner} />);
    expect(await screen.findByText('Next account proposal')).toBeTruthy();

    await act(async () => {
      resolveStale(staleService);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Next account proposal')).toBeTruthy();
    expect(screen.queryByText('Old account proposal')).toBeNull();
  } finally {
    focusListener.mockRestore();
    restoreVisibility();
  }
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
