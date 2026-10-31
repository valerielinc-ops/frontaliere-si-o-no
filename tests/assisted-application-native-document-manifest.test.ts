import { createNativeOperation } from '../functions/src/lib/assistedApplicationNativeOperation.js';
import { ownerTargetFixture } from './helpers/ownerNativePrimaryFixture';
vi.mock('../functions/src/lib/primaryApplicationProtocol.js', async original => {
  const actual = await original<any>();
  const { primaryPostingFixture } = await import('./helpers/ownerNativePrimaryFixture');
  return { ...actual, readPrimaryApplicationProtocol: (input: any, options: any) => primaryPostingFixture(actual.readPrimaryApplicationProtocol, input, options, 'Engineer') };
});
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { canonicalQuestionJson } from '../functions/src/lib/applicationQuestionContract.js';
const captured = vi.hoisted(() => ({ context: null as any, proof: null as any }));
// The composed backend supplies these modules. Capture the server producer without granting a send.
vi.mock('../functions/src/lib/nativeQualificationContext.js', () => ({ nativeQualificationContext: (input: any) => {
  captured.context = input; return { scope: { orderId: input.orderId, round: input.flow.round } };
} }));
vi.mock('../functions/src/assistedApplicationNativeProof.js', () => ({ verifyNativeApplicationProof: async (input: any) => {
  captured.proof = input; return { status: 'unknown' };
} }));
import { handleAutomationAdminAction } from '../functions/src/assistedApplicationAutomationAdmin.js';
const digest = (value: any) => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonicalQuestionJson(value)).digest('hex');

describe('current server document manifest for native proof', () => {
  it.each([true, false])('binds only actual current membership (assigned=%s)', async assigned => {
    const now = Date.now(); const id = 'synthetic-source'; const base = `assisted_applications/${id}`;
    const cv = Buffer.from('%PDF synthetic CV'); const diploma = Buffer.from('%PDF synthetic diploma');
    const cvKey = `assisted-application-uploads/${id}/source.pdf`; const key = `assisted-application-uploads/${id}/diploma.pdf`;
    const requested = { id: 'degree', label: 'Degree certificates', kind: 'diploma', keywords: ['degree certificates'], required: true,
      quote: 'degree certificates', originalNativeContract: { question: 'Degree certificates', kind: 'file', options: [] } };
    const order = { cvStorageKey: cvKey, cvUploadedAt: now, jobId: 'synthetic-job', jobTitle: 'Engineer', jobUrl: 'https://example.test/job/engineer.html' };
    const flow = { state: 'owner_takeover', round: 3, answers: {}, documents: assigned ? { degree: { files: [{ key, detectedType: 'pdf' }] } } : {} };
    const draft = { status: 'ready', round: 3, questions: [], cvKey, sourceCvHash: digest(cv), profile: {},
      channel: { applyUrl: 'https://example.test/job/engineer.html' }, requiredDocuments: [requested] };
    const f = createMemoryFirestore({ [base]: order, [`${base}/automation/flow`]: flow, [`${base}/ai_drafts/current`]: draft });
    const downloads: any[] = [];
    const deps = { nowMs: now, nativeOperation: createNativeOperation(), originalCvUrl: async () => 'https://example.test/source.pdf', bucket: { file: (objectKey: string, options: any) => ({
      getMetadata: async () => [{ generation: objectKey === cvKey ? '10' : '42', size: (objectKey === cvKey ? cv : diploma).length }],
      download: async () => { downloads.push({ objectKey, options }); return [objectKey === cvKey ? cv : diploma]; },
    }) } };
    const call = (action: string, extra: any = {}) => handleAutomationAdminAction(f.db,
      { action, orderId: id, nativeProofProtocol: 'owner-final-intent-v1', ...extra }, 'owner@example.test', deps);
    const { kit } = await call('automationFillKit') as any;
    const fields = [{ fieldId: 'diploma-file', nativeFormContract: { question: 'Degree certificates', kind: 'file', options: [] } }];
    const attachments = [{ fieldId: 'diploma-file', slot: 'extra_1', sha256: digest(diploma), size: diploma.length }];
    const target = ownerTargetFixture('https://example.test/job/engineer.html');
    const request = { answerSourceFingerprint: kit.answerSourceFingerprint,
      nativeProof: { version: 'owner-native-proof-v1', frameUrl: 'https://example.test/job/engineer.html', round: 3, target, fields, attachments },
      finalIntent: { id: 'synthetic-final-intent', frameUrl: 'https://example.test/job/engineer.html', nativeDigest: digest(fields),
        materialDigest: digest(attachments), submitterDigest: digest(target), capturedAt: now } };
    captured.proof = null;
    await expect(call('automationMarkClicked', request)).rejects.toMatchObject({ status: 409,
      code: assigned ? 'native_proof_unverified' : 'native_proof_material_changed' });
    expect(f.read(`${base}/automation/submission`)).toBeUndefined();
    if (assigned) {
      expect(captured.proof.docsManifest).toEqual([{ slot: 'extra_1', kind: 'diploma', sha256: digest(diploma), size: diploma.length,
        generation: '42', documentId: 'degree', fileId: 'diploma.pdf', assigned: true, requestedDocument: requested,
        scope: { orderId: id, round: 3, jobId: order.jobId, sourceJobUrl: order.jobUrl } }]);
      expect(captured.context.docsManifest).toEqual(captured.proof.docsManifest);
      expect(downloads.find(item => item.objectKey === key).options).toEqual({ generation: '42' });
    } else expect(captured.proof).toBeNull();
  });
});
