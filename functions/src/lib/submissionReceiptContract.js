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

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const messageId = value => typeof value === 'string' && value.length <= 998 && !/[\u0000-\u001f\u007f]/u.test(value) && /^<[^<>\s@]+@[^<>\s@]+>$/u.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** Private actual SMTP payload identity. Only its digest survives retention purge. */
export function submissionEmailHandoff(value) {
  if (!exactKeys(value, ['messageId', 'recipient', 'slotHash']) || !messageId(value.messageId)
    || typeof value.recipient !== 'string' || !value.recipient || value.recipient.length > 320
    || value.recipient !== value.recipient.trim() || /[\u0000-\u001f\u007f<>\s]/u.test(value.recipient) || !value.recipient.includes('@')
    || !sha256(value.slotHash)) return null;
  return { messageId: value.messageId, recipient: value.recipient, slotHash: value.slotHash };
}

/** Already verified inbound outcome authority, never an automatic send permission. */
export function submissionEmployerAckProof(value) {
  if (!exactKeys(value, ['orderId', 'round', 'channel', 'leftAt', 'recordHash', 'messageId', 'providerReceivedAt', 'slotHash'])
    || typeof value.orderId !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/u.test(value.orderId)
    || !Number.isSafeInteger(value.round) || value.round < 1 || value.channel !== 'email'
    || !Number.isFinite(value.leftAt) || value.leftAt <= 0 || !Number.isFinite(value.providerReceivedAt)
    || value.providerReceivedAt < value.leftAt || !sha256(value.recordHash)
    || typeof value.messageId !== 'string' || !value.messageId || value.messageId.length > 200
    || value.messageId !== value.messageId.trim() || /[\/\\\u0000-\u001f\u007f]/u.test(value.messageId) || !sha256(value.slotHash)) return null;
  return { orderId: value.orderId, round: value.round, channel: value.channel, leftAt: value.leftAt,
    recordHash: value.recordHash, messageId: value.messageId, providerReceivedAt: value.providerReceivedAt, slotHash: value.slotHash };
}
