import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import itCore from '@/services/locales/it-core';
import AssistedApplicationUpload from '@/components/community/AssistedApplicationUpload';

const mocks = vi.hoisted(() => ({
  getApp: vi.fn(),
  getAuth: vi.fn(),
  getFirestore: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
  updateDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  getStorage: vi.fn(),
  ref: vi.fn(),
  uploadBytes: vi.fn(),
  trackEvent: vi.fn(),
  fetch: vi.fn(),
  openWindow: vi.fn(),
}));

vi.mock('@/components/community/SumUpPaymentWidget', () => ({
  default: ({ checkoutId, onClose }: { checkoutId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="SumUp"><span>{checkoutId}</span><button onClick={onClose}>Chiudi SumUp</button></div>
  ),
}));

vi.mock('@/services/firebase', () => ({ getApp: mocks.getApp }));
vi.mock('firebase/auth', () => ({ getAuth: mocks.getAuth }));
vi.mock('firebase/firestore', () => ({
  getFirestore: mocks.getFirestore,
  doc: mocks.doc,
  getDoc: mocks.getDoc,
  updateDoc: mocks.updateDoc,
  serverTimestamp: mocks.serverTimestamp,
}));
vi.mock('firebase/storage', () => ({
  getStorage: mocks.getStorage,
  ref: mocks.ref,
  uploadBytes: mocks.uploadBytes,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  ASSISTED_APPLICATION_CONSENT_VERSION: 'assisted-application-v2',
  ASSISTED_APPLICATION_PRICE_EUR_CENTS: 199,
  normalizeAssistedApplicationCopyVariant: () => 'control',
  normalizeAssistedApplicationLayoutVariant: (value: unknown) => (
    ['control', 'variant_7', 'proposal_5', 'proposal_b'].includes(String(value))
      ? String(value)
      : null
  ),
  trackAssistedApplicationEvent: mocks.trackEvent,
  shouldSuppressAssistedApplicationEvent: () => false,
}));
vi.mock('@/services/i18n', async () => {
  const { default: strings } = await import('@/services/locales/it-core');
  const translate = (key: string, values?: Record<string, string>) => Object.entries(values || {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    strings[key] ?? key,
  );

  return {
    getLocale: () => 'it',
    useLocale: () => ['it', vi.fn()],
    useTranslation: () => ({ locale: 'it', t: translate }),
  };
});

const ORDER_ID = 'order_test_123';
const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  orderId: ORDER_ID,
  userId: 'candidate-test-user',
  paymentStatus: 'paid',
  submissionStatus: 'awaiting_upload',
  jobTitle: 'Ruolo di prova',
  companyName: 'Azienda di prova',
  consentVersion: null,
  consentedAt: null,
  applicantName: 'Nome di prova',
  applicantEmail: 'candidato@example.test',
  cvStorageKey: null,
  cvFileName: null,
  ...overrides,
});

let orderData = paidOrder();

describe('assisted application consent and CV upload flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockImplementation(mocks.openWindow as unknown as typeof window.open);
    mocks.openWindow.mockReturnValue(null);
    vi.stubGlobal('fetch', mocks.fetch);
    orderData = paidOrder();
    mocks.getApp.mockResolvedValue({});
    mocks.getAuth.mockReturnValue({
      authStateReady: async () => {},
      currentUser: { uid: 'candidate-test-user', getIdToken: async () => 'candidate-token' },
    });
    mocks.getFirestore.mockReturnValue({});
    mocks.doc.mockReturnValue({ id: ORDER_ID });
    mocks.getDoc.mockImplementation(async () => ({ exists: () => true, data: () => orderData }));
    mocks.updateDoc.mockResolvedValue(undefined);
    mocks.serverTimestamp.mockReturnValue({ serverTimestamp: true });
    mocks.getStorage.mockReturnValue({});
    mocks.ref.mockImplementation((_storage, path) => ({ path }));
    mocks.uploadBytes.mockResolvedValue({ metadata: { fullPath: `assisted-application-uploads/${ORDER_ID}/cv.pdf` } });
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('records the mandate once, then reveals an enabled CV picker and uploads the selected file', async () => {
    const user = userEvent.setup();
    const { container } = render(<AssistedApplicationUpload orderId={ORDER_ID} />);

    await screen.findByRole('button', { name: itCore['jobBoard.assisted.confirmConsent'] });
    const privacyDisclosure = screen.getByText(itCore['jobBoard.assisted.privacyNoticeSummary']).closest('details');
    expect(privacyDisclosure).not.toBeNull();
    expect((privacyDisclosure as HTMLDetailsElement).open).toBe(false);
    expect(privacyDisclosure?.textContent).toContain(itCore['jobBoard.assisted.privacyNotice']);
    await user.click(screen.getByText(itCore['jobBoard.assisted.privacyNoticeSummary']));
    expect((privacyDisclosure as HTMLDetailsElement).open).toBe(true);
    expect(screen.queryByLabelText(itCore['jobBoard.assisted.name'])).toBeNull();
    expect(screen.queryByRole('button', { name: itCore['jobBoard.assisted.fileCta'] })).toBeNull();

    await user.click(screen.getByRole('checkbox'));
    expect(mocks.updateDoc).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(itCore['jobBoard.assisted.name'])).toBeNull();

    await user.click(screen.getByRole('button', { name: itCore['jobBoard.assisted.confirmConsent'] }));
    await waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: itCore['jobBoard.assisted.confirmConsent'] })).toBeNull();
    expect(screen.getByText(itCore['jobBoard.assisted.uploadStepTitle'])).toBeTruthy();
    expect(screen.getByLabelText(itCore['jobBoard.assisted.name'])).toBeTruthy();

    const uploadButton = screen.getByRole('button', { name: itCore['jobBoard.assisted.fileCta'] });
    expect(uploadButton).toBeEnabled();
    const fileInput = container.querySelector<HTMLInputElement>('#assisted-application-cv-input');
    expect(fileInput).not.toBeNull();
    expect(fileInput).toBeEnabled();
    const openPicker = vi.spyOn(fileInput as HTMLInputElement, 'click').mockImplementation(() => {});
    await user.click(uploadButton);
    expect(openPicker).toHaveBeenCalledOnce();
    openPicker.mockRestore();

    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(['pdf data'], 'cv.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(mocks.uploadBytes).toHaveBeenCalledOnce());
    expect(mocks.updateDoc).toHaveBeenCalledTimes(2);
    expect(screen.getByText('cv.pdf').closest('[role="status"]')).not.toBeNull();
    expect(fileInput).toBeDisabled();
  });

  it('does not count reopening the same paid order as another checkout completion', async () => {
    const completionCount = () => mocks.trackEvent.mock.calls.filter(([event]) => event === 'checkout_completed').length;
    const firstVisit = render(<AssistedApplicationUpload orderId="order-completion-reopen" />);
    await screen.findByRole('button', { name: itCore['jobBoard.assisted.confirmConsent'] });
    expect(completionCount()).toBe(1);
    firstVisit.unmount();

    render(<AssistedApplicationUpload orderId="order-completion-reopen" />);
    await screen.findByRole('button', { name: itCore['jobBoard.assisted.confirmConsent'] });
    expect(completionCount()).toBe(1);
  });

  it('does not ask again when the order already contains a valid mandate', async () => {
    orderData = paidOrder({ consentVersion: 'assisted-application-v1', consentedAt: { seconds: 1 } });
    render(<AssistedApplicationUpload orderId={ORDER_ID} />);

    const uploadButton = await screen.findByRole('button', { name: itCore['jobBoard.assisted.fileCta'] });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: itCore['jobBoard.assisted.confirmConsent'] })).toBeNull();
    expect(uploadButton).toBeEnabled();
  });

  it('keeps the CV and details hidden when the mandate cannot be recorded', async () => {
    mocks.updateDoc.mockRejectedValueOnce(new Error('permission-denied'));
    const user = userEvent.setup();
    render(<AssistedApplicationUpload orderId={ORDER_ID} />);

    const confirmButton = await screen.findByRole('button', { name: itCore['jobBoard.assisted.confirmConsent'] });
    await user.click(screen.getByRole('checkbox'));
    await user.click(confirmButton);
    await screen.findByRole('alert');

    expect(screen.queryByLabelText(itCore['jobBoard.assisted.name'])).toBeNull();
    expect(screen.queryByRole('button', { name: itCore['jobBoard.assisted.fileCta'] })).toBeNull();
  });

  it('keeps a provider-confirmable failed SumUp checkout recoverable', async () => {
    orderData = paidOrder({ paymentProvider: 'sumup', sumupCheckoutId: 'retryable', paymentStatus: 'failed', paymentFailureReason: 'payment_not_confirmed', submissionStatus: 'awaiting_payment' });
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, status: 'paid', orderId: ORDER_ID }) });
    render(<AssistedApplicationUpload orderId={ORDER_ID} />);
    await screen.findByRole('button', { name: itCore['jobBoard.assisted.pendingCta'] });
    expect(screen.queryByText(itCore['jobBoard.assisted.paymentFailed'])).toBeNull();
  });

  it('offers a server-verified payment resume action while the order is pending', async () => {
    orderData = paidOrder({
      paymentStatus: 'pending',
      submissionStatus: 'awaiting_payment',
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: 'cs_pending',
    });
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 'paid', orderId: ORDER_ID }),
    });
    const user = userEvent.setup();
    render(<AssistedApplicationUpload orderId={ORDER_ID} />);

    const resumeButton = await screen.findByRole('button', { name: itCore['jobBoard.assisted.pendingCta'] });
    await user.click(resumeButton);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/resumeAssistedApplicationPayment'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ orderId: ORDER_ID }) }),
    ));
    expect(screen.getByText(itCore['jobBoard.assisted.pending'])).toBeTruthy();
  });

  it('automatically embeds SumUp once and keeps it closed after dismissal', async () => {
    orderData = paidOrder({ paymentStatus: 'pending', submissionStatus: 'awaiting_payment', paymentProvider: 'sumup' });
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      ok: true, status: 'open', paymentProvider: 'sumup', checkoutId: 'sumup-pending', orderId: ORDER_ID,
    }) });
    const user = userEvent.setup();
    render(<AssistedApplicationUpload orderId={ORDER_ID} />);
    expect(await screen.findByRole('dialog', { name: 'SumUp' })).toHaveTextContent('sumup-pending');
    expect(mocks.openWindow).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Chiudi SumUp' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(mocks.getDoc.mock.calls.length).toBeGreaterThan(1), { timeout: 4000 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.trackEvent.mock.calls.filter(([event]) => event === 'checkout_resumed')).toHaveLength(1);
    expect(mocks.trackEvent.mock.calls.some(([event]) => event === 'checkout_completed')).toBe(false);
    await user.click(screen.getByRole('button', { name: itCore['jobBoard.assisted.pendingCta'] }));
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.openWindow).not.toHaveBeenCalled();
  });

  it('allows a manual retry after automatic SumUp recovery fails', async () => {
    orderData = paidOrder({ paymentStatus: 'pending', submissionStatus: 'awaiting_payment', sumupCheckoutId: 'legacy-checkout' });
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: 'provider_unavailable' }) });
    const user = userEvent.setup();
    render(<AssistedApplicationUpload orderId={ORDER_ID} />);
    await screen.findByText(itCore['jobBoard.assisted.paymentResumeError']);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      ok: true, status: 'open', paymentProvider: 'sumup', checkoutId: 'sumup-renewed', orderId: ORDER_ID,
    }) });
    await user.click(screen.getByRole('button', { name: itCore['jobBoard.assisted.pendingCta'] }));
    await screen.findByRole('dialog', { name: 'SumUp' });
    expect(mocks.openWindow).not.toHaveBeenCalled();
  });

  it.each(['unmount', 'order-change', 'sdk-owner-change'])('does not transfer a delayed Stripe popup after %s', async (change) => {
    orderData = paidOrder({ paymentStatus: 'pending', submissionStatus: 'awaiting_payment', paymentProvider: 'stripe' });
    const popup = { closed: false, opener: null, location: { replace: vi.fn() }, close: vi.fn() };
    mocks.openWindow.mockReturnValue(popup);
    let resolveFetch!: (value: any) => void;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    mocks.fetch.mockReturnValueOnce(pending);
    const view = render(<AssistedApplicationUpload key="first" orderId={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: itCore['jobBoard.assisted.pendingCta'] }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    if (change === 'unmount') view.unmount();
    else if (change === 'order-change') view.rerender(<AssistedApplicationUpload key="second" orderId="another-order" />);
    else {
      const auth = mocks.getAuth.mock.results.at(-1)?.value;
      auth.currentUser = { uid: 'another-user', getIdToken: async () => 'another-token' };
    }
    await act(async () => {
      resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true, status: 'open', paymentProvider: 'stripe',
        url: 'https://checkout.stripe.com/test/', orderId: ORDER_ID }) });
      await pending;
    });
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
  });

  it('opens Stripe Checkout in a user-initiated popup and keeps the page as fallback', async () => {
    orderData = paidOrder({
      paymentStatus: 'pending',
      submissionStatus: 'awaiting_payment',
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: 'cs_pending',
    });
    const replace = vi.fn();
    const popup = { closed: false, opener: null, location: { replace }, close: vi.fn() };
    mocks.openWindow.mockReturnValue(popup);
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 'open', paymentProvider: 'stripe', url: 'https://checkout.stripe.com/cs_pending', orderId: ORDER_ID }),
    });
    const user = userEvent.setup();
    render(<AssistedApplicationUpload orderId={ORDER_ID} />);

    await user.click(await screen.findByRole('button', { name: itCore['jobBoard.assisted.pendingCta'] }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://checkout.stripe.com/cs_pending'));
    expect(mocks.openWindow).toHaveBeenCalledOnce();
    expect(mocks.openWindow.mock.calls[0][0]).toBe('about:blank');
    expect(mocks.openWindow.mock.calls[0][2]).toContain('popup');
  });
});
