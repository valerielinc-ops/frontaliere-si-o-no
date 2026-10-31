/** Server-owned, content-free identity of an attempted submission and its slot. */
import { createHash } from 'node:crypto';
import { qualificationCounterContextHash } from './qualificationCounterContext.js';
export const submissionAttemptHash = attemptId => createHash('sha256').update(String(attemptId)).digest('hex');
export const submissionSlotHash = ({ orderId, order = {} }) => qualificationCounterContextHash({ orderId: String(orderId),
  jobId: order.jobId ?? null, jobUrl: order.jobUrl ?? null,
  parentServiceId: order.parentServiceId ?? null, parentProposalId: order.parentProposalId ?? null });

/** Only the two receipt-photo fields may change as a normal post-send write. */
export function submissionDraftMaterialHash(draft) {
  if (!draft) return qualificationCounterContextHash(null);
  const { sent: _sent, sentAttempt: _sentAttempt, ...material } = draft;
  return qualificationCounterContextHash(material);
}
export const submissionAttemptMaterialHash = draft => qualificationCounterContextHash(draft?.sentAttempt || null);

export function minimalSubmissionReceipt({ record, attemptHash, round, at }) {
  if (!/^[a-f0-9]{64}$/.test(attemptHash || '') || !Number.isInteger(round) || round < 1 || !Number.isFinite(at) || at <= 0) throw new Error('invalid_submission_receipt');
  return { hash: createHash('sha256').update(JSON.stringify(record)).digest('hex'), attempt: attemptHash, at, status: 'sent', round };
}
export const isMinimalSubmissionReceipt = (receipt, attemptHash, round) => receipt?.status === 'sent' && receipt.attempt === attemptHash
  && receipt.round === round && /^[a-f0-9]{64}$/.test(receipt.hash || '') && Number.isFinite(receipt.at) && receipt.at > 0;

const OWNER_INTENT_HASH_FIELDS = ['idHash', 'nativeDigest', 'materialDigest', 'submitterDigest', 'assessmentHash'];
/** Audit metadata of an already verified server intent; these digests never grant by themselves. */
export function submissionOwnerIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== OWNER_INTENT_HASH_FIELDS.length
    || !OWNER_INTENT_HASH_FIELDS.every(key => Object.hasOwn(value, key) && typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))) return null;
  return Object.fromEntries(OWNER_INTENT_HASH_FIELDS.map(key => [key, value[key]]));
}
