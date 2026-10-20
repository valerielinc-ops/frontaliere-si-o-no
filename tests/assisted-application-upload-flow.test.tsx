import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  trackAssistedApplicationEvent: mocks.trackEvent,
}));
vi.mock('@/services/i18n', async () => {
  const { default: strings } = await import('@/services/locales/it-core');
  const translate = (key: string, values?: Record<string, string>) => Object.entries(values || {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    strings[key] ?? key,
  );

  return {
    getLocale: () => 'it',
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
    orderData = paidOrder();
    mocks.getApp.mockResolvedValue({});
    mocks.getAuth.mockReturnValue({ authStateReady: async () => {}, currentUser: { uid: 'candidate-test-user' } });
    mocks.getFirestore.mockReturnValue({});
    mocks.doc.mockReturnValue({ id: ORDER_ID });
    mocks.getDoc.mockImplementation(async () => ({ exists: () => true, data: () => orderData }));
    mocks.updateDoc.mockResolvedValue(undefined);
    mocks.serverTimestamp.mockReturnValue({ serverTimestamp: true });
    mocks.getStorage.mockReturnValue({});
    mocks.ref.mockImplementation((_storage, path) => ({ path }));
    mocks.uploadBytes.mockResolvedValue({ metadata: { fullPath: `assisted-application-uploads/${ORDER_ID}/cv.pdf` } });
  });

  afterEach(cleanup);

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
});
