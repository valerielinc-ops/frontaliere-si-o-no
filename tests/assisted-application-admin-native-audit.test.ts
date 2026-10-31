import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { ownerTargetFixture } from './helpers/ownerNativePrimaryFixture';
import { canonicalQuestionJson } from '../functions/src/lib/applicationQuestionContract.js';
import { createNativeOperation, disposeNativeOperation } from '../functions/src/lib/assistedApplicationNativeOperation.js';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { withNativeValidation } from '../scripts/assisted-application/lib/portal/qualification-gate.mjs';
const io = vi.hoisted(() => ({ db: null as any, bucket: null as any, decoded: null as any, primaryTitle: 'Engineer' }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: async () => io.decoded }) }));
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: () => io.bucket }) }));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ getAdminDb: () => io.db }));
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn(async () => { throw new Error('provider_request_forbidden'); }) }));
vi.mock('../functions/src/lib/primaryApplicationProtocol.js', async original => {
  const actual = await original<any>();
  const { primaryPostingFixture } = await import('./helpers/ownerNativePrimaryFixture');
  return { ...actual, readPrimaryApplicationProtocol: (input: any, options: any) => primaryPostingFixture(actual.readPrimaryApplicationProtocol, input, options, io.primaryTitle) };
});
const { SITE_ADMIN_UIDS, SITE_ADMIN_EMAILS } = await import('../functions/src/adminAuth.js');
const { handleAssistedApplicationAdmin } = await import('../functions/src/assistedApplicationAdminCore.js');
const url = 'https://jobs.example.test/job/engineer-42.html';
const hash = (value: any) => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonicalQuestionJson(value)).digest('hex');
let nativeFields: any[];
beforeAll(async () => {
  // The Review form is a redraw at the same URL. Its separately fetched primary posting has the real H1.
  const dom = new JSDOM(`<form aria-label="Your personal details" method="post" action="${url}"><label>Your first name<input name="first_name" value="Synthetic"></label><label>Your last name<input name="last_name" value="Candidate"></label><label>Your email<input type="email" name="email" value="candidate@example.test"></label><label>CV<input type="file" name="cv"></label><button type="submit">Send application</button></form>`, { url, runScripts: 'outside-only' });
  const w = dom.window as any;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  w.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 });
  w.Element.prototype.getClientRects = () => [{ width: 20, height: 20 }];
  const style = w.getComputedStyle.bind(w); w.getComputedStyle = (element: any) => style(element); w.CSS = { escape: (value: string) => value };
  const evaluate = (fn: Function, arg?: any) => w.eval(`(${fn.toString()})`)(arg);
  const frame = { url: () => url, evaluate: async (fn: Function, arg: any) => evaluate(fn, arg) };
  const fields = await withNativeValidation({ frames: () => [frame] }, evaluate(extractFieldsInPage).fields);
  nativeFields = fields.map((field: any) => ({ fieldId: field.id, nativeFormContract: field.originalNativeContract,
    ...(field.kind === 'file' || field.inputType === 'file' ? {} : { proposedAnswer: w.document.querySelector(`[data-aa-id="${field.id}"]`).value }) }));
  expect(nativeFields).toHaveLength(4); expect(nativeFields.every(field => field.nativeFormContract)).toBe(true);
  dom.window.close();
});
afterEach(() => vi.restoreAllMocks());

describe('actual AdminCore native audit and entry deadline (synthetic I/O, no browser activation)', () => {
  it.each(['normal', 'audit_10s', 'audit_abort', 'audit_deadline', 'audit_failure', 'commit_abort', 'commit_deadline', 'foreign_target', 'audit_source_changed', 'audit_primary_changed'])('%s preserves ACK/marker ordering', async mode => {
    io.primaryTitle = 'Engineer';
    const entry = Date.now(); let clock = entry; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const controller = new AbortController(); const operation = createNativeOperation({ now: () => clock, signal: controller.signal });
    try {
      const id = 'native-core-synthetic'; const base = `assisted_applications/${id}`; const bytes = Buffer.from('%PDF synthetic source bytes');
      const order = { paymentStatus: 'paid', consentVersion: 'assisted-application-v2', consentedAt: entry - 1000,
        cvStorageKey: `assisted-application-uploads/${id}/source.pdf`, cvUploadedAt: entry, jobTitle: 'Engineer', jobUrl: url,
        applicantName: 'Synthetic Candidate', applicantEmail: 'candidate@example.test' };
      const flow = { state: 'owner_takeover', round: 1, answers: {}, questionAnswers: {} };
      const draft = { status: 'ready', round: 1, questions: [], cvKey: order.cvStorageKey, sourceCvHash: hash(bytes),
        factSources: { text: 'Synthetic original source.' }, job: { title: 'Engineer', applyUrl: url }, channel: { type: 'portal', applyUrl: url }, profile: {} };
      const store = createMemoryFirestore({ [base]: order, [`${base}/automation/flow`]: flow, [`${base}/ai_drafts/current`]: draft });
      io.db = store.db; io.decoded = { uid: SITE_ADMIN_UIDS[0], email: SITE_ADMIN_EMAILS[0], email_verified: true };
      io.bucket = { file: () => ({ getMetadata: async () => [{ generation: '1', size: bytes.length }], download: async () => [bytes], getSignedUrl: async () => ['https://files.example.test/source.pdf'] }) };
      let auditCount = 0; let markerCompleted = false;
      const collection = store.db.collection;
      store.db.collection = (name: string) => {
        const ref = collection(name);
        return name !== 'admin_audit_log' ? ref : { ...ref, add: async (data: any) => {
          if (data.action === 'assisted_application_automationMarkClicked') {
            auditCount++;
            if (mode === 'audit_failure') throw new Error('synthetic audit unavailable');
            if (mode === 'audit_10s') clock += 10_000;
            if (mode === 'audit_abort') controller.abort();
            if (mode === 'audit_deadline') clock = entry + 120_001;
            if (mode === 'audit_primary_changed') io.primaryTitle = 'Another role';
            if (mode === 'audit_source_changed') store.docs.set(base, { ...store.read(base), applicantName: 'Changed during audit' });
          }
          return ref.add(data);
        } };
      };
      const runTransaction = store.db.runTransaction;
      store.db.runTransaction = async (callback: any) => {
        const result = await runTransaction(callback);
        if (store.read(`${base}/automation/submission`)?.r1?.clickedAt && !markerCompleted) {
          markerCompleted = true;
          if (mode === 'commit_abort') controller.abort();
          if (mode === 'commit_deadline') clock = entry + 120_001;
        }
        return result;
      };
      const req = (body: any) => ({ method: 'POST', headers: { authorization: 'Bearer synthetic-test-token' },
        body: { orderId: id, nativeProofProtocol: 'owner-final-intent-v1', ...body } });
      const kit = await handleAssistedApplicationAdmin(req({ action: 'automationFillKit' }), { nativeOperation: operation });
      expect(kit.status).toBe(200);
      const proof = { version: 'owner-native-proof-v1', frameUrl: url, round: 1, target: ownerTargetFixture(url), fields: structuredClone(nativeFields), attachments: [] };
      if (mode === 'foreign_target') proof.target.form.action = proof.target.destination.url = 'https://jobs.example.test/job/engineer-99.html';
      const finalIntent = { id: 'synthetic-intent-0001', frameUrl: url, nativeDigest: hash(proof.fields), materialDigest: hash(proof.attachments), submitterDigest: hash(proof.target), capturedAt: clock };
      const result = await handleAssistedApplicationAdmin(req({ action: 'automationMarkClicked', answerSourceFingerprint: kit.body.kit.answerSourceFingerprint,
        nativeProof: proof, finalIntent }), { nativeOperation: operation });
      expect(auditCount).toBe(mode === 'foreign_target' ? 0 : 1);
      if (mode === 'normal' || mode === 'audit_10s') {
        expect(result.status).toBe(200); expect(markerCompleted).toBe(true);
        expect(result.body.acknowledgedAt).toBe(clock); expect(result.body.expiresAt - result.body.acknowledgedAt).toBe(5000);
        expect(clock).toBe(entry + (mode === 'audit_10s' ? 10_000 : 0));
        const frames = [...store.docs].filter(([key]) => key.includes('/submission_receipts/'));
        expect(frames).toHaveLength(1); expect(frames[0][1].ownerIntent).toEqual(result.body.ownerIntent);
        expect(frames[0][1].sourceFingerprint).toBe(result.body.answerSourceFingerprint); expect(Object.keys(result.body.ownerIntent)).toHaveLength(5);
      } else {
        expect(result.status).toBe(mode === 'audit_failure' ? 503 : 409); expect(result.body.finalIntentId).toBeUndefined();
        expect(markerCompleted).toBe(mode.startsWith('commit_'));
      }
    } finally { disposeNativeOperation(operation); }
  });
});
