import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(), getAdminDb: vi.fn(), getStorage: vi.fn(), getStripe: vi.fn(),
  retrieveSumUpCheckout: vi.fn(), refundSumUpTransaction: vi.fn(),
  files: new Map<string, Buffer>(), saves: [] as string[],
}));

vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mocks.verifyIdToken }) }));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ file: (key: string) => ({
    async save(buffer: Buffer) { mocks.files.set(key, Buffer.from(buffer)); mocks.saves.push(key); },
    async delete() { mocks.files.delete(key); },
  }) }) }),
}));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ getAdminDb: () => mocks.getAdminDb() }));
vi.mock('../functions/src/publisherApplicationsCore.js', () => ({ resolveCvLink: vi.fn() }));
vi.mock('../functions/src/stripePublisherCore.js', () => ({ getStripe: () => mocks.getStripe() }));
vi.mock('../functions/src/sumupAssistedApplicationCore.js', () => ({
  retrieveSumUpCheckout: (...args: unknown[]) => mocks.retrieveSumUpCheckout(...args),
  refundSumUpTransaction: (...args: unknown[]) => mocks.refundSumUpTransaction(...args),
  SumUpApiError: class SumUpApiError extends Error {},
}));

const { handleAssistedApplicationAdmin } = await import('../functions/src/assistedApplicationAdminCore.js');

const ORDER = 'order_ABC123';
const OLD_CV = `assisted-application-uploads/${ORDER}/old.pdf`;
const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);
const CV = Buffer.from('%PDF-1.7\nupdated CV\n', 'utf8');
const CV_BASE64 = CV.toString('base64');

function request(body: Record<string, unknown>) {
  return { method: 'POST', body, get: (header: string) => (header === 'Authorization' ? 'Bearer valid-token' : undefined) };
}

function withdrawnOrder(extra: Record<string, unknown> = {}) {
  return {
    paymentStatus: 'paid', submissionStatus: 'withdrawn', withdrawnAt: T0,
    withdrawalReason: 'Cambio del CV', cvStorageKey: OLD_CV,
    cvFileCheck: { key: OLD_CV, verdict: 'ok', detectedType: 'pdf' }, ...extra,
  };
}

function database(order: Record<string, unknown>, extra: Record<string, Record<string, unknown>> = {}) {
  return createMemoryFirestore({
    [`assisted_applications/${ORDER}`]: order,
    [`assisted_applications/${ORDER}/automation/flow`]: { state: 'withdrawn', round: 2, heldBy: [], history: [] },
    [`assisted_applications/${ORDER}/ai_drafts/current`]: {
      coverLetterPdfKey: `assisted-application-uploads/${ORDER}/old-letter.pdf`,
      tailoredCv: { pdfKey: `assisted-application-uploads/${ORDER}/old-tailored.pdf`, inplace: { docxKey: `assisted-application-uploads/${ORDER}/old.docx` } },
    },
    [`assisted_applications/${ORDER}/automation/submission`]: { withdrawnAt: T0 },
    ...extra,
  });
}

beforeEach(() => {
  mocks.verifyIdToken.mockReset();
  mocks.verifyIdToken.mockResolvedValue({ uid: 'aAqGpXr2mUQNQlio3gCxut4bBzH3', email: 'valerielinc@gmail.com', email_verified: true });
  mocks.getAdminDb.mockReset(); mocks.getStripe.mockReset(); mocks.retrieveSumUpCheckout.mockReset(); mocks.refundSumUpTransaction.mockReset();
  mocks.files.clear(); mocks.saves.length = 0;
});

describe('owner CV replacement after candidate withdrawal', () => {
  it('replaces the CV, clears stale draft/submission fences and is idempotent', async () => {
    const store = database(withdrawnOrder());
    mocks.getAdminDb.mockReturnValue(store.db);
    mocks.files.set(OLD_CV, Buffer.from('%PDF-1.4\nold', 'utf8'));
    const body = {
      action: 'reopenAfterWithdrawal', orderId: ORDER, authorizedOrderId: ORDER,
      reopenRequestId: 'eliana-cv-20261105',
      reopenReason: 'La candidata ha chiarito che desidera soltanto sostituire il CV.',
      fileName: 'CV aggiornato.pdf', contentBase64: CV_BASE64,
    };

    const first = await handleAssistedApplicationAdmin(request(body));

    expect(first).toMatchObject({ status: 200, body: { ok: true, alreadyReopened: false, reopenState: 'pending', submissionStatus: 'in_progress' } });
    const order = store.read(`assisted_applications/${ORDER}`);
    expect(order).toMatchObject({ submissionStatus: 'in_progress', cvUploadedBy: 'owner', reopenAfterWithdrawal: { status: 'pending', requestId: 'eliana-cv-20261105' } });
    expect(order).not.toHaveProperty('withdrawnAt');
    expect(order).not.toHaveProperty('withdrawalReason');
    expect(order).not.toHaveProperty('cvFileCheck');
    expect(store.read(`assisted_applications/${ORDER}/ai_drafts/current`)).toBeUndefined();
    expect(store.read(`assisted_applications/${ORDER}/automation/submission`)).not.toHaveProperty('withdrawnAt');
    expect(mocks.files.has(OLD_CV)).toBe(false);
    expect([...mocks.files.keys()]).toHaveLength(1);
    expect(store.list(`assisted_applications/${ORDER}/events/`).map((path) => store.read(path))).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: 'automation_reopened_after_withdrawal', requestId: 'eliana-cv-20261105' })]),
    );

    const second = await handleAssistedApplicationAdmin(request(body));

    expect(second).toMatchObject({ status: 200, body: { ok: true, alreadyReopened: true, reopenState: 'pending', submissionStatus: 'in_progress' } });
    expect(mocks.saves).toHaveLength(1);
  });

  it('refuses active, concierge, sent and uncertain orders', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, Record<string, unknown>> | undefined, string]> = [
      [{ paymentStatus: 'paid', submissionStatus: 'in_progress' }, undefined, 'reopen_unavailable'],
      [withdrawnOrder({ billingMode: 'application_concierge' }), undefined, 'concierge_reopen_not_supported'],
      [withdrawnOrder(), { [`assisted_applications/${ORDER}/ai_drafts/current`]: { sent: { at: T0 } } }, 'already_submitted'],
      [withdrawnOrder(), { [`assisted_applications/${ORDER}/automation/submission`]: { withdrawnAt: T0, r2: { state: 'sending', channel: 'email', startedAt: T0 } } }, 'submission_unconfirmed'],
    ];
    for (const [order, extra, expected] of cases) {
      const store = database(order, extra);
      mocks.getAdminDb.mockReturnValue(store.db);
      const result = await handleAssistedApplicationAdmin(request({
        action: 'reopenAfterWithdrawal', orderId: ORDER, authorizedOrderId: ORDER,
        reopenRequestId: 'eliana-cv-20261105', reopenReason: 'Sostituzione autorizzata del CV.',
        fileName: 'updated.pdf', contentBase64: CV_BASE64,
      }));
      expect(result).toEqual({ status: 409, body: { ok: false, error: expected } });
      expect(mocks.saves).toHaveLength(0);
    }
  });
});
