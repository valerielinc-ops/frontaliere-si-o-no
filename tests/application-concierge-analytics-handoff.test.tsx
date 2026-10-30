import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.unmock('@/services/analytics');
vi.unmock('@/services/analyticsProxy');

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(), fetchService: vi.fn(), logEvent: vi.fn(), auth: { currentUser: null as any },
}));
vi.mock('@/services/i18n', () => ({ getLocale: () => 'it', useLocale: () => ['it'], useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/services/firebase', () => ({ getApp: async () => ({}), getAnalytics: async () => ({}), getConfigValue: async () => '' }));
vi.mock('firebase/analytics', () => ({ logEvent: mocks.logEvent, setUserProperties: vi.fn() }));
vi.mock('firebase/auth', () => ({ getAuth: () => mocks.auth }));
vi.mock('@/services/posthog', () => ({ captureEvent: vi.fn() }));
vi.mock('@/services/authService', () => ({ signInWithCustomAuthToken: vi.fn() }));
vi.mock('@/services/profileFirestore', () => ({ loadEnrichmentProfileFields: vi.fn() }));
vi.mock('@/services/assistedApplicationCheckout', () => ({ ensureAssistedApplicationAuth: vi.fn() }));
vi.mock('@/services/applicationConciergeCheckout', () => ({ createApplicationConciergeCheckout: mocks.checkout }));
vi.mock('@/services/applicationConciergeService', () => ({
  fetchApplicationConciergeService: mocks.fetchService, recoverApplicationConciergePaymentSession: vi.fn(),
  openApplicationConciergeChildReview: vi.fn(), acceptApplicationConciergeProposal: vi.fn(),
  declineApplicationConciergeProposal: vi.fn(), recordApplicationConciergeConsent: vi.fn(),
  saveApplicationConciergeProfile: vi.fn(), getCandidateVisibleApplicationConciergeProposals: (rows: unknown) => rows,
}));
vi.mock('@/components/community/SumUpPaymentWidget', () => ({ default: () => <div role="dialog" aria-label="SumUp" /> }));

// Keep both analyticsProxy and analytics real: only the final Firebase SDK is a
// local recorder, so these tests cannot emit analytics or create real payments.
import ApplicationConciergePortal from '@/components/community/ApplicationConciergePortal';
// The production ErrorBoundary chunk also statically imports analytics.
import '@/services/analytics';
const owner = { uid: 'handoff-owner', email: 'candidate@example.test', getIdToken: async () => 'test-token' };
const service = {
  serviceId: 'service-test', paymentStatus: 'pending', serviceStatus: 'awaiting_payment',
  checkoutSessionStatus: 'open', customerEmail: owner.email, applicantLocation: 'Lugano',
  proposals: [], acceptedPositionsCount: 0, remainingPositions: 10, maxPositions: 10,
};
const stripeResult = { ok: true, paymentProvider: 'stripe', url: 'https://checkout.stripe.com/test/', serviceId: 'service-test' };
const eventCalls = (name: string) => mocks.logEvent.mock.calls.filter(([, event]) => event === name);

function installRedirectRecorder() {
  const original = window;
  const assign = vi.fn();
  vi.stubGlobal('window', new Proxy(original, { get(target, key) {
    if (key === 'location') return {
      href: original.location.href, pathname: original.location.pathname,
      search: original.location.search, hash: original.location.hash, origin: original.location.origin, assign,
    };
    return Reflect.get(target, key, target);
  } }));
  return assign;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/automatizza-ricerca-lavoro-svizzera/?application_concierge_service_id=service-test&ne=candidate%40example.test&ac=private-test-code&utm_source=email&utm_medium=payment_reminder');
  mocks.auth.currentUser = owner;
  mocks.fetchService.mockResolvedValue(service);
  mocks.checkout.mockResolvedValue(stripeResult);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('real concierge analytics acknowledgement before Stripe navigation', () => {
  it.each(['automatic', 'manual'])('waits for the SDK callback through the real proxy (%s) and sends no duplicate event', async (mode) => {
    const manual = mode === 'manual';
    if (manual) {
      const entry = new URL(window.location.href);
      entry.searchParams.delete('application_concierge_service_id');
      window.history.replaceState(null, '', entry.pathname + entry.search);
    }
    const assign = installRedirectRecorder();
    const eventName = manual ? 'application_concierge_checkout_click' : 'application_concierge_checkout_resume';
    render(<ApplicationConciergePortal serviceId={manual ? null : 'service-test'} entry={manual} authUser={owner} />);
    if (manual) fireEvent.click(screen.getAllByRole('button', { name: /jobBoard.concierge.start/ })[0]);
    await waitFor(() => expect(eventCalls(eventName)).toHaveLength(1));
    expect(assign).not.toHaveBeenCalled();
    const parameters = eventCalls(eventName)[0][2];
    expect(parameters).toMatchObject({ price_eur: 39.99, price_eur_cents: 3999 });
    expect(parameters.page_path).toContain('utm_medium=payment_reminder');
    if (!manual) expect(parameters.page_path).toContain('application_concierge_service_id=service-test');
    expect(JSON.stringify(parameters)).not.toMatch(/private-test-code|candidate|[?&](?:ac|ne)=/);
    await act(async () => { parameters.event_callback(); });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(stripeResult.url));
    expect(eventCalls(eventName)).toHaveLength(1);
    expect(eventCalls(manual ? 'application_concierge_checkout_resume' : 'application_concierge_checkout_click')).toHaveLength(0);
    expect(eventCalls('application_concierge_view')).toHaveLength(1);
  });

  it('starts its bounded fallback only after the checkout API has finished', async () => {
    const assign = installRedirectRecorder();
    let finishCheckout!: (value: typeof stripeResult) => void;
    mocks.checkout.mockReturnValueOnce(new Promise((resolve) => { finishCheckout = resolve; }));
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledOnce());
    await waitFor(() => expect(eventCalls('application_concierge_checkout_resume')).toHaveLength(1));
    // The API can take longer than the handoff budget; that time must not
    // consume the later protection against a full-page navigation.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    await act(async () => { finishCheckout(stripeResult); });
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(stripeResult.url), { timeout: 1500 });
    expect(eventCalls('application_concierge_checkout_resume')).toHaveLength(1);
  });

  it.each(['unmount', 'service-change', 'owner-change', 'sdk-owner-change'])('clears the handoff timer and ignores a late callback after %s', async (change) => {
    const assign = installRedirectRecorder();
    let finishCheckout!: (value: typeof stripeResult) => void;
    mocks.checkout.mockReturnValueOnce(new Promise((resolve) => { finishCheckout = resolve; }));
    const view = render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledOnce());
    await waitFor(() => expect(eventCalls('application_concierge_checkout_resume')).toHaveLength(1));
    const schedule = vi.spyOn(window, 'setTimeout');
    const cancel = vi.spyOn(window, 'clearTimeout');
    await act(async () => { finishCheckout(stripeResult); });
    const handoffIndex = schedule.mock.calls.findIndex(([, delay]) => delay === 1000);
    expect(handoffIndex).toBeGreaterThanOrEqual(0);
    const handoffTimer = schedule.mock.results[handoffIndex].value;
    if (change === 'unmount') view.unmount();
    else if (change === 'service-change') view.rerender(<ApplicationConciergePortal serviceId="another-service" authUser={owner} authLoading />);
    else {
      const anotherOwner = { ...owner, uid: 'another-owner' };
      mocks.auth.currentUser = anotherOwner;
      if (change !== 'sdk-owner-change') view.rerender(<ApplicationConciergePortal serviceId="service-test" authUser={anotherOwner} authLoading />);
    }
    if (change !== 'sdk-owner-change') expect(cancel).toHaveBeenCalledWith(handoffTimer);
    await act(async () => { eventCalls('application_concierge_checkout_resume')[0][2].event_callback(); });
    expect(cancel).toHaveBeenCalledWith(handoffTimer);
    expect(assign).not.toHaveBeenCalled();
  });

  it('opens SumUp without waiting for the pending acknowledgement', async () => {
    const assign = installRedirectRecorder();
    mocks.checkout.mockResolvedValueOnce({ ok: true, paymentProvider: 'sumup', checkoutId: 'sumup-test', serviceId: 'service-test' });
    render(<ApplicationConciergePortal serviceId="service-test" authUser={owner} />);
    await screen.findByRole('dialog', { name: 'SumUp' });
    await waitFor(() => expect(eventCalls('application_concierge_checkout_resume')).toHaveLength(1));
    expect(assign).not.toHaveBeenCalled();
  });
});
