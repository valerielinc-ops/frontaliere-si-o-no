/**
 * tests/functions/error-response.test.ts
 *
 * Agent F — 5XX hardening unit tests.
 *
 * Verifies that Cloud Function handlers convert predictable failure modes
 * (invalid input, missing config, Firestore/Resend outage) into STRUCTURED
 * JSON responses with the correct HTTP status code, rather than letting a
 * raw exception bubble up as an unhandled 500. This is what keeps the
 * reliability score of the frontaliereticino.ch footprint above the Semrush
 * 5XX threshold.
 *
 * These tests exercise the core handler functions directly (not the
 * `onRequest` wrapper) so they run in Vitest + jsdom without emulators.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-admin before importing the handler under test. The handler
// uses admin.firestore.FieldValue.serverTimestamp() during payload assembly,
// so we expose a stub that matches that shape.
vi.mock('firebase-admin', () => {
  return {
    default: {
      firestore: Object.assign(
        () => ({ collection: () => ({ doc: () => ({}) }) }),
        { FieldValue: { serverTimestamp: () => '__server_ts__' } },
      ),
    },
  };
});

// `@google-cloud/recaptcha-enterprise` is only installed under functions/
// node_modules, not at the repo root, so mock it to keep this test file
// self-contained when running under Vitest at the repo root.
vi.mock('@google-cloud/recaptcha-enterprise', () => ({
  RecaptchaEnterpriseServiceClient: class {
    projectPath() { return 'projects/stub'; }
    async createAssessment() { return [{ tokenProperties: { valid: false, invalidReason: 'STUB' } }]; }
  },
}));

// Same story for firebase-admin/remote-config — pulled transitively by the
// reCAPTCHA handler via remoteConfigSecrets.js.
vi.mock('firebase-admin/remote-config', () => ({
  getRemoteConfig: () => ({ getTemplate: async () => ({ parameters: {} }) }),
}));

// Mock emailI18n so handler imports resolve without loading heavy email assets.
vi.mock('../../functions/src/emailI18n.js', () => ({
  t: (_lang: string, _key: string) => 'stub',
  htmlLang: (l: string) => l,
  normalizeLocale: (l: string) => (l === 'it' || l === 'en' || l === 'de' || l === 'fr' ? l : 'it'),
}));

// Mock the resend webhook core to avoid pulling firebase-admin wiring.
vi.mock('../../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
  ensureAdminApp: () => undefined,
}));

// Resolve the handler module lazily after mocks are registered.
async function loadSendCalculatorReport() {
  const mod = await import('../../functions/src/sendCalculatorReport.js');
  return mod.handleSendCalculatorReport;
}

type StubDb = {
  collection: ReturnType<typeof vi.fn>;
};

/**
 * Build an in-memory Firestore stub that mimics the chainable API the handler
 * uses: db.collection(x).doc(y).get()/set(); db.collection(x).doc(y).collection(z).add().
 * Behaviour is controlled by the `overrides` argument.
 */
function makeDbStub(overrides: {
  getImpl?: () => Promise<{ exists: boolean }>;
  setImpl?: () => Promise<void>;
  addImpl?: () => Promise<{ id: string }>;
} = {}): StubDb {
  const getImpl = overrides.getImpl ?? (async () => ({ exists: false }));
  const setImpl = overrides.setImpl ?? (async () => undefined);
  const addImpl = overrides.addImpl ?? (async () => ({ id: 'evt_1' }));
  return {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(getImpl),
        set: vi.fn(setImpl),
        collection: vi.fn(() => ({ add: vi.fn(addImpl) })),
      })),
    })),
  };
}

/** Minimal stub that mimics the Resend SDK's `emails.send` return shape. */
function makeResendClient(behaviour: 'ok' | 'error') {
  return {
    emails: {
      send: vi.fn(async () =>
        behaviour === 'ok'
          ? { data: { id: 'res_ok' }, error: null }
          : { data: null, error: { name: 'send_failed', message: 'simulated' } },
      ),
    },
  };
}

const VALID_PDF_BASE64 = Buffer.from('%PDF-1.4 fake', 'utf8').toString('base64');

describe('handleSendCalculatorReport — structured error responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 with structured body for an invalid email', async () => {
    const handle = await loadSendCalculatorReport();
    const res = await handle({
      email: 'not-an-email',
      pdfBase64: VALID_PDF_BASE64,
      resultSummary: {},
      locale: 'it',
      sourcePath: '/',
      resendApiKey: 'fake',
      db: makeDbStub(),
      resendClient: makeResendClient('ok'),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'invalid_email' });
  });

  it('returns 400 when PDF payload is missing', async () => {
    const handle = await loadSendCalculatorReport();
    const res = await handle({
      email: 'user@example.com',
      pdfBase64: '',
      resultSummary: {},
      locale: 'it',
      sourcePath: '/',
      resendApiKey: 'fake',
      db: makeDbStub(),
      resendClient: makeResendClient('ok'),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'missing_pdf' });
  });

  it('returns 413 when PDF exceeds the 2MB cap', async () => {
    const handle = await loadSendCalculatorReport();
    // Size the base64 string so the decoded bytes exceed 2MB.
    const oversized = 'A'.repeat(3 * 1024 * 1024);
    const res = await handle({
      email: 'user@example.com',
      pdfBase64: oversized,
      resultSummary: {},
      locale: 'it',
      sourcePath: '/',
      resendApiKey: 'fake',
      db: makeDbStub(),
      resendClient: makeResendClient('ok'),
    });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, error: 'pdf_too_large' });
  });

  it('returns 500 with stable body when Resend API key is not configured', async () => {
    const handle = await loadSendCalculatorReport();
    const res = await handle({
      email: 'user@example.com',
      pdfBase64: VALID_PDF_BASE64,
      resultSummary: {},
      locale: 'it',
      sourcePath: '/',
      resendApiKey: '',
      db: makeDbStub(),
      resendClient: makeResendClient('ok'),
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'missing_resend_api_key' });
  });

  it('returns 503 structured error (no unhandled 500) when Firestore upsert fails', async () => {
    const handle = await loadSendCalculatorReport();
    const db = makeDbStub({
      getImpl: async () => {
        throw new Error('UNAVAILABLE: simulated outage');
      },
    });
    const res = await handle({
      email: 'user@example.com',
      pdfBase64: VALID_PDF_BASE64,
      resultSummary: {},
      locale: 'it',
      sourcePath: '/',
      resendApiKey: 'fake',
      db,
      resendClient: makeResendClient('ok'),
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'firestore_unavailable' });
  });

  it('returns 502 structured error when Resend rejects the email send', async () => {
    const handle = await loadSendCalculatorReport();
    const res = await handle({
      email: 'user@example.com',
      pdfBase64: VALID_PDF_BASE64,
      resultSummary: { netCH_CHF: 50000, netIT_CHF: 30000, savingsCHF: 20000 },
      locale: 'it',
      sourcePath: '/',
      resendApiKey: 'fake',
      db: makeDbStub(),
      resendClient: makeResendClient('error'),
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, error: 'email_send_failed' });
  });

  it('returns 200 with messageId even when best-effort event write fails (no regression to 5XX)', async () => {
    const handle = await loadSendCalculatorReport();
    // First Firestore op (upsert) succeeds; subsequent event write fails.
    // The handler must swallow that best-effort failure and still return 200.
    let firstCall = true;
    const db: StubDb = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({ exists: false })),
          set: vi.fn(async () => undefined),
          collection: vi.fn(() => ({
            add: vi.fn(async () => {
              if (firstCall) {
                firstCall = false;
                throw new Error('event log down');
              }
              return { id: 'evt' };
            }),
          })),
        })),
      })),
    };
    const res = await handle({
      email: 'user@example.com',
      pdfBase64: VALID_PDF_BASE64,
      resultSummary: { netCH_CHF: 50000, netIT_CHF: 30000, savingsCHF: 20000 },
      locale: 'it',
      sourcePath: '/',
      resendApiKey: 'fake',
      db,
      resendClient: makeResendClient('ok'),
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messageId).toBe('res_ok');
  });
});

describe('handleRecaptchaVerification — structured error responses', () => {
  it('returns 400 when the token is missing', async () => {
    const { handleRecaptchaVerification } = await import('../../functions/src/recaptchaVerification.js');
    const res = await handleRecaptchaVerification({ body: { action: 'CONTACT_FORM' } } as any);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INVALID');
  });

  it('returns 400 when the action is not in the allowlist', async () => {
    const { handleRecaptchaVerification } = await import('../../functions/src/recaptchaVerification.js');
    const res = await handleRecaptchaVerification({ body: { token: 'tok', action: 'NOT_REAL' } } as any);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INVALID');
  });
});
