import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { canonicalQuestionJson } from '../functions/src/lib/applicationQuestionContract.js';
import { handleAutomationAdminAction } from '../functions/src/assistedApplicationAutomationAdmin.js';
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn(async () => { throw new Error('external_request_forbidden'); }) }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => ''), bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}) }));
const now = Date.now(); const id = 'native-proof-source'; const base = `assisted_applications/${id}`;
const bytes = Buffer.from('%PDF synthetic');
const hash = (value: any) => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonicalQuestionJson(value)).digest('hex');
async function fixture() {
  const order = { cvUploadedAt: now, cvStorageKey: `assisted-application-uploads/${id}/source.pdf`, applicantName: 'Synthetic Candidate' };
  const flow = { state: 'owner_takeover', round: 1, answers: {}, questionAnswers: {} };
  const draft = { round: 1, status: 'ready', questions: [], cvKey: order.cvStorageKey, sourceCvHash: hash(bytes), profile: {}, channel: { applyUrl: 'https://example.test/apply/' } };
  const store = createMemoryFirestore({ [base]: order, [`${base}/automation/flow`]: flow, [`${base}/ai_drafts/current`]: draft });
  const metadata = vi.fn(async () => [{ generation: '1', size: bytes.length }]);
  const deps = { nowMs: now, originalCvUrl: async () => 'https://example.test/source.pdf',
    bucket: { file: () => ({ getMetadata: metadata, download: async () => [bytes] }) }, runEffect: vi.fn(async () => { throw new Error('effect_forbidden'); }) };
  const call = (action: string, extra: any = {}) => handleAutomationAdminAction(store.db,
    { action, orderId: id, nativeProofProtocol: 'owner-final-intent-v1', ...extra }, 'owner@example.test', deps);
  const { kit } = await call('automationFillKit') as any;
  const fields: any[] = [{ fieldId: 'degree', nativeFormContract: { question: 'Do you hold the required degree?', kind: 'checkbox', options: [] }, proposedAnswer: true },
    { fieldId: 'file', nativeFormContract: { question: 'CV', kind: 'file', options: [] } }];
  const attachments = [{ fieldId: 'file', slot: 'cv', sha256: hash(bytes), size: bytes.length }];
  const raw = { answerSourceFingerprint: kit.answerSourceFingerprint,
    nativeProof: { version: 'owner-native-proof-v1', frameUrl: 'https://example.test/apply/', round: 1, fields, attachments },
    finalIntent: { id: 'synthetic-final-intent', frameUrl: 'https://example.test/apply/', nativeDigest: hash(fields), materialDigest: hash(attachments), submitterDigest: 'c'.repeat(64), capturedAt: now } };
  return { store, call, raw, metadata };
}
describe('complete owner preauthorization refuses before a click', () => {
  it.each(['missing_proof', 'stale_kit', 'wrong_file', 'wrong_destination', 'unproved_degree'])('refuses %s without a claim, click or ACK', async mode => {
    const f = await fixture();
    if (mode === 'stale_kit') f.store.docs.set(base, { ...f.store.read(base), applicantName: 'Changed Candidate' });
    if (mode === 'wrong_file') { f.raw.nativeProof.attachments[0].sha256 = 'f'.repeat(64); f.raw.finalIntent.materialDigest = hash(f.raw.nativeProof.attachments); }
    if (mode === 'wrong_destination') f.raw.nativeProof.frameUrl = f.raw.finalIntent.frameUrl = 'https://different.example.test/another-job/';
    const codes: Record<string, string> = { missing_proof: 'native_proof_invalid', stale_kit: 'evidence_source_changed', wrong_file: 'native_proof_material_changed', wrong_destination: 'native_proof_destination_changed', unproved_degree: 'native_proof_unverified' };
    await expect(f.call('automationMarkClicked', mode === 'missing_proof' ? {} : f.raw)).rejects.toMatchObject({ code: codes[mode], status: 409 });
    expect(f.store.read(`${base}/automation/submission`)).toBeUndefined();
    if (['missing_proof', 'stale_kit', 'wrong_destination'].includes(mode)) expect(f.metadata).not.toHaveBeenCalled();
  });
});
