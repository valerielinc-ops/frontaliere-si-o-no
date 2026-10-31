import { ownerTargetFixture } from './helpers/ownerNativePrimaryFixture';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ownerFinalIntent } from '../functions/src/lib/ownerFinalIntent.js';
import { canonicalQuestionJson } from '../functions/src/lib/applicationQuestionContract.js';
const now = Date.now();
const hash = (value: any) => createHash('sha256').update(canonicalQuestionJson(value)).digest('hex');
function request() {
  const fields: any[] = [
    { fieldId: 'degree', nativeFormContract: { question: 'Do you hold a degree?', context: 'Only University X degrees qualify', kind: 'checkbox', options: [] }, proposedAnswer: true },
    { fieldId: 'cv-upload', nativeFormContract: { question: 'CV', kind: 'file', options: [] } },
  ];
  const attachments = [{ fieldId: 'cv-upload', slot: 'cv', sha256: 'a'.repeat(64), size: 500 }];
  const target = ownerTargetFixture('https://example.test/apply/');
  return { nativeProofProtocol: 'owner-final-intent-v1', answerSourceFingerprint: 'b'.repeat(64),
    nativeProof: { version: 'owner-native-proof-v1', successfulControlsDigest: 'c'.repeat(64), frameUrl: 'https://example.test/apply/', round: 1, target, fields, attachments },
    finalIntent: { id: 'synthetic-final-intent', frameUrl: 'https://example.test/apply/', nativeDigest: hash({ fields, successfulControlsDigest: 'c'.repeat(64) }), materialDigest: hash(attachments), submitterDigest: hash(target), capturedAt: now } };
}
describe('owner final intent transport (not semantic authority)', () => {
  it('binds the full opaque successful-control snapshot without accepting it as semantic evidence', () => {
    const raw = request();
    expect(ownerFinalIntent(raw, { round: 1, nowMs: now }).proof.successfulControlsDigest).toBe('c'.repeat(64));
    raw.nativeProof.successfulControlsDigest = 'd'.repeat(64);
    expect(() => ownerFinalIntent(raw, { round: 1, nowMs: now })).toThrow('native_proof_invalid');
    raw.finalIntent.nativeDigest = hash({ fields: raw.nativeProof.fields, successfulControlsDigest: raw.nativeProof.successfulControlsDigest });
    expect(ownerFinalIntent(raw, { round: 1, nowMs: now }).proof.successfulControlsDigest).toBe('d'.repeat(64));
    delete (raw.nativeProof as any).successfulControlsDigest;
    expect(() => ownerFinalIntent(raw, { round: 1, nowMs: now })).toThrow('native_proof_invalid');
  });

  it('owns the full input snapshot and joins files to their native controls', () => {
    const raw = request(); const parsed = ownerFinalIntent(raw, { round: 1, nowMs: now });
    raw.nativeProof.fields[0].nativeFormContract.context = 'Changed after request';
    expect(parsed.proof.fields[0].nativeFormContract.context).toBe('Only University X degrees qualify');
    expect(parsed.proof.attachments[0].fieldId).toBe('cv-upload');
  });
  it('preserves an empty optional file control for the server purpose policy', () => {
    const raw = request(); raw.nativeProof.fields.push({ fieldId: 'optional-extra', nativeFormContract: { question: 'Other optional file', kind: 'file', required: false, options: [] } });
    raw.finalIntent.nativeDigest = hash({ fields: raw.nativeProof.fields, successfulControlsDigest: raw.nativeProof.successfulControlsDigest });
    expect(ownerFinalIntent(raw, { round: 1, nowMs: now }).proof.fields).toHaveLength(3);
  });
  it('counts multibyte native metadata against the byte budget without truncating it', () => {
    const raw = request(); raw.nativeProof.fields[0].nativeFormContract.context = '語'.repeat(22000);
    raw.finalIntent.nativeDigest = hash({ fields: raw.nativeProof.fields, successfulControlsDigest: raw.nativeProof.successfulControlsDigest });
    expect(() => ownerFinalIntent(raw, { round: 1, nowMs: now })).toThrow('native_proof_invalid');
  });
  it.each(['missing_protocol', 'missing_fingerprint', 'stale_round', 'changed_value', 'changed_context', 'wrong_file_field', 'file_fakepath', 'duplicate_field', 'old_intent', 'insecure_url', 'extra_key', 'missing_target', 'changed_target', 'oversize_target'])('refuses incomplete/stale native transport: %s', change => {
    const raw: any = request();
    if (change === 'missing_protocol') delete raw.nativeProofProtocol;
    if (change === 'missing_fingerprint') delete raw.answerSourceFingerprint;
    if (change === 'stale_round') raw.nativeProof.round = 2;
    if (change === 'changed_value') raw.nativeProof.fields[0].proposedAnswer = false;
    if (change === 'changed_context') raw.nativeProof.fields[0].nativeFormContract.context = 'New employer';
    if (change === 'wrong_file_field') raw.nativeProof.attachments[0].fieldId = 'degree';
    if (change === 'file_fakepath') raw.nativeProof.fields[1].proposedAnswer = 'C:\\fakepath\\CV.pdf';
    if (change === 'duplicate_field') raw.nativeProof.fields.push(raw.nativeProof.fields[0]);
    if (change === 'old_intent') raw.finalIntent.capturedAt = now - 120001;
    if (change === 'insecure_url') raw.finalIntent.frameUrl = raw.nativeProof.frameUrl = 'http://example.test/apply/';
    if (change === 'missing_target') delete raw.nativeProof.target;
    if (change === 'changed_target') raw.nativeProof.target.form.action = 'https://example.test/job99/';
    if (change === 'oversize_target') raw.nativeProof.target.extra = 'x'.repeat(140000);
    if (change === 'extra_key') raw.nativeProof.approved = true;
    expect(() => ownerFinalIntent(raw, { round: 1, nowMs: now })).toThrow('native_proof_invalid');
  });
});
