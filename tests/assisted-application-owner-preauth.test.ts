import { ownerTargetFixture } from './helpers/ownerNativePrimaryFixture';
vi.mock('../functions/src/lib/primaryApplicationProtocol.js', async original => {
  const actual = await original<any>();
  const { primaryPostingFixture } = await import('./helpers/ownerNativePrimaryFixture');
  return { ...actual, readPrimaryApplicationProtocol: (input: any, options: any) => primaryPostingFixture(actual.readPrimaryApplicationProtocol, input, options, 'Engineer') };
});
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createNativeOperation, disposeNativeOperation } from '../functions/src/lib/assistedApplicationNativeOperation.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { canonicalQuestionJson } from '../functions/src/lib/applicationQuestionContract.js';
import { handleAutomationAdminAction } from '../functions/src/assistedApplicationAutomationAdmin.js';
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn(async () => { throw new Error('external_request_forbidden'); }) }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => ''), bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}) }));
const now = Date.now(); const id = 'native-proof-source'; const base = `assisted_applications/${id}`;
const bytes = Buffer.from('%PDF synthetic');
const hash = (value: any) => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonicalQuestionJson(value)).digest('hex');
async function fixture() {
  const order = { cvUploadedAt: now, cvStorageKey: `assisted-application-uploads/${id}/source.pdf`, applicantName: 'Synthetic Candidate', jobTitle: 'Engineer', jobUrl: 'https://example.test/job/engineer.html' };
  const flow = { state: 'owner_takeover', round: 1, answers: {}, questionAnswers: {} };
  const draft = { round: 1, status: 'ready', questions: [], cvKey: order.cvStorageKey, sourceCvHash: hash(bytes), profile: {}, channel: { applyUrl: 'https://example.test/job/engineer.html' } };
  const store = createMemoryFirestore({ [base]: order, [`${base}/automation/flow`]: flow, [`${base}/ai_drafts/current`]: draft });
  const metadata = vi.fn(async () => [{ generation: '1', size: bytes.length }]);
  const nativeOperation = createNativeOperation();
  const deps = { nowMs: now, nativeOperation, originalCvUrl: async () => 'https://example.test/source.pdf',
    bucket: { file: () => ({ getMetadata: metadata, download: async () => [bytes] }) }, runEffect: vi.fn(async () => { throw new Error('effect_forbidden'); }) };
  const call = (action: string, extra: any = {}) => handleAutomationAdminAction(store.db,
    { action, orderId: id, nativeProofProtocol: 'owner-final-intent-v1', ...extra }, 'owner@example.test', deps);
  const { kit } = await call('automationFillKit') as any;
  const fields: any[] = [{ fieldId: 'degree', nativeFormContract: { question: 'Do you hold the required degree?', kind: 'checkbox', options: [] }, proposedAnswer: true },
    { fieldId: 'file', nativeFormContract: { question: 'CV', kind: 'file', options: [] } }];
  const attachments = [{ fieldId: 'file', slot: 'cv', sha256: hash(bytes), size: bytes.length }];
  const target = ownerTargetFixture('https://example.test/job/engineer.html');
  const raw = { answerSourceFingerprint: kit.answerSourceFingerprint,
    nativeProof: { version: 'owner-native-proof-v1', frameUrl: 'https://example.test/job/engineer.html', round: 1, target, fields, attachments },
    finalIntent: { id: 'synthetic-final-intent', frameUrl: 'https://example.test/job/engineer.html', nativeDigest: hash(fields), materialDigest: hash(attachments), submitterDigest: hash(target), capturedAt: now } };
  return { store, call, raw, metadata, nativeOperation, deps };
}
describe('complete owner preauthorization refuses before a click', () => {
  it.each(['missing', 'forged', 'expired', 'aborted'])('refuses a %s private operation before reads or ARM', async mode => {
    const f = await fixture();
    disposeNativeOperation(f.nativeOperation);
    const controller = new AbortController();
    let clock = now;
    f.deps.nativeOperation = mode === 'forged' ? { startedAt: now, deadlineAt: now + 120_000, signal: controller.signal } as any
      : mode === 'missing' ? null as any : createNativeOperation({ now: () => clock, signal: controller.signal });
    if (mode === 'expired') clock += 115_000;
    if (mode === 'aborted') controller.abort();
    const read = vi.spyOn(f.store.db, 'runTransaction');
    await expect(f.call('automationMarkClicked', f.raw)).rejects.toMatchObject({ code: 'native_operation_expired', status: 409 });
    expect(read).not.toHaveBeenCalled();
    expect(f.metadata).not.toHaveBeenCalled();
    expect(f.store.read(`${base}/automation/submission`)).toBeUndefined();
    disposeNativeOperation(f.deps.nativeOperation);
  });
  it.each(['deadline', 'abort'])('rechecks the operation after the last material read: %s', async mode => {
    const f = await fixture();
    disposeNativeOperation(f.nativeOperation);
    let clock = now;
    const controller = new AbortController();
    f.deps.nativeOperation = createNativeOperation({ now: () => clock, signal: controller.signal });
    f.metadata.mockImplementationOnce(async () => {
      if (mode === 'deadline') clock += 115_000; else controller.abort();
      return [{ generation: '1', size: bytes.length }];
    });
    await expect(f.call('automationMarkClicked', f.raw)).rejects.toMatchObject({ code: 'native_operation_expired', status: 409 });
    expect(f.store.read(`${base}/automation/submission`)).toBeUndefined();
    disposeNativeOperation(f.deps.nativeOperation);
  });
  it.each(['missing_proof', 'stale_kit', 'wrong_file', 'wrong_destination', 'unproved_degree'])('refuses %s without a claim, click or ACK', async mode => {
    const f = await fixture();
    if (mode === 'stale_kit') f.store.docs.set(base, { ...f.store.read(base), applicantName: 'Changed Candidate' });
    if (mode === 'wrong_file') { f.raw.nativeProof.attachments[0].sha256 = 'f'.repeat(64); f.raw.finalIntent.materialDigest = hash(f.raw.nativeProof.attachments); }
    if (mode === 'wrong_destination') { f.raw.nativeProof.target.form.action = f.raw.nativeProof.target.destination.url = 'https://different.example.test/another-job/'; f.raw.finalIntent.submitterDigest = hash(f.raw.nativeProof.target); }
    const codes: Record<string, string> = { missing_proof: 'native_proof_invalid', stale_kit: 'evidence_source_changed', wrong_file: 'native_proof_material_changed', wrong_destination: 'native_proof_destination_changed', unproved_degree: 'native_proof_unverified' };
    await expect(f.call('automationMarkClicked', mode === 'missing_proof' ? {} : f.raw)).rejects.toMatchObject({ code: codes[mode], status: 409 });
    disposeNativeOperation(f.nativeOperation);
    expect(f.store.read(`${base}/automation/submission`)).toBeUndefined();
    if (['missing_proof', 'stale_kit', 'wrong_destination'].includes(mode)) expect(f.metadata).not.toHaveBeenCalled();
  });
});
