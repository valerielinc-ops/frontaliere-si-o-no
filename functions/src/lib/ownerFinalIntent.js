/** The blocked human intent and its complete native snapshot, never a semantic proof by themselves. */
import { createHash } from 'node:crypto';
import { cloneNativeApplicationTarget } from './nativeApplicationTarget.js';
import { canonicalQuestionJson } from './applicationQuestionContract.js';
import { MAX_FILES_PER_DOCUMENT, MAX_REQUIRED_DOCUMENTS } from '../assistedApplicationExtraDocuments.js';
export const OWNER_NATIVE_PROOF_PROTOCOL = 'owner-final-intent-v1';
export const OWNER_NATIVE_PROOF_VERSION = 'owner-native-proof-v1';
const sha = value => createHash('sha256').update(canonicalQuestionJson(value)).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const httpsUrl = value => {
  if (typeof value !== 'string' || !value || value.length > 2000) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
const invalid = () => Object.assign(new Error('native_proof_invalid'), { code: 'native_proof_invalid', status: 409 });
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const scalar = value => ['string', 'boolean', 'number'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value)) && (typeof value !== 'string' || value.length <= 16000);
const isFile = field => field.nativeFormContract.kind === 'file' || field.nativeFormContract.controlType === 'file';

/** Validate the transport without selecting claims or accepting an answer as evidence. */
export function ownerFinalIntent(raw, { round, nowMs = Date.now() }) {
  let proof; let intent;
  try {
    if (Buffer.byteLength(canonicalQuestionJson({ proof: raw?.nativeProof, intent: raw?.finalIntent }), 'utf8') > 2 * 1024 * 1024) throw invalid();
    ({ proof, intent } = structuredClone({ proof: raw?.nativeProof, intent: raw?.finalIntent }));
  } catch { throw invalid(); }
  if (raw?.nativeProofProtocol !== OWNER_NATIVE_PROOF_PROTOCOL || !digest(raw?.answerSourceFingerprint)
    || !object(proof) || !only(proof, ['version', 'frameUrl', 'round', 'fields', 'attachments', 'target']) || proof.version !== OWNER_NATIVE_PROOF_VERSION || !httpsUrl(proof.frameUrl)
    || !Number.isInteger(round) || round < 1 || proof.round !== round || !Array.isArray(proof.fields) || proof.fields.length > 300
    || !Array.isArray(proof.attachments) || proof.attachments.length > 2 + MAX_FILES_PER_DOCUMENT * MAX_REQUIRED_DOCUMENTS
    || !object(intent) || !only(intent, ['id', 'frameUrl', 'nativeDigest', 'materialDigest', 'submitterDigest', 'capturedAt']) || typeof intent.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(intent.id)
    || intent.frameUrl !== proof.frameUrl || !digest(intent.nativeDigest) || !digest(intent.materialDigest) || !digest(intent.submitterDigest)
    || !Number.isFinite(nowMs) || !Number.isFinite(intent.capturedAt) || intent.capturedAt <= 0
    || intent.capturedAt > nowMs + 5000 || nowMs - intent.capturedAt > 120_000) throw invalid();
  const target = cloneNativeApplicationTarget(proof.target);
  if (!target || target.documentUrl !== proof.frameUrl || sha(target) !== intent.submitterDigest) throw invalid();
  proof.target = target;
  const ids = new Set();
  for (const field of proof.fields) {
    if (!object(field) || !only(field, ['fieldId', 'nativeFormContract', 'proposedAnswer']) || typeof field.fieldId !== 'string' || !field.fieldId || field.fieldId.length > 1000 || ids.has(field.fieldId)
      || !object(field.nativeFormContract) || Buffer.byteLength(canonicalQuestionJson(field.nativeFormContract), 'utf8') > 64000
      || typeof field.nativeFormContract.question !== 'string' || field.nativeFormContract.question.length > 8000
      || typeof field.nativeFormContract.kind !== 'string' || !Array.isArray(field.nativeFormContract.options)) throw invalid();
    ids.add(field.fieldId);
    if (isFile(field)) { if (Object.hasOwn(field, 'proposedAnswer')) throw invalid(); }
    else if (!(scalar(field.proposedAnswer) || Array.isArray(field.proposedAnswer) && field.proposedAnswer.length <= 300 && field.proposedAnswer.every(scalar))) throw invalid();
  }
  const attachmentIds = new Set();
  for (const file of proof.attachments) {
    const field = proof.fields.find(field => field.fieldId === file?.fieldId);
    if (!object(file) || !only(file, ['fieldId', 'slot', 'sha256', 'size']) || !field || !isFile(field) || typeof file.slot !== 'string' || !/^(?:cv|cover_letter|extra_\d+)$/.test(file.slot)
      || !digest(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw invalid();
    const key = canonicalQuestionJson(file);
    if (attachmentIds.has(key)) throw invalid();
    attachmentIds.add(key);
  }
  // Empty file controls remain in the full snapshot. Required/optional purpose is decided by the server proof policy.
  if (sha(proof.fields) !== intent.nativeDigest || sha(proof.attachments) !== intent.materialDigest) throw invalid();
  return Object.freeze({ proof, intent, answerSourceFingerprint: raw.answerSourceFingerprint });
}
