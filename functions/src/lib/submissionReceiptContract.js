/** Content-free proof that one order/round reached a demonstrated send boundary. */
import { createHash } from 'node:crypto';

export const SUBMISSION_RECEIPT_VERSION = 1;
const RECEIPT_FIELDS = Object.freeze([
  'version', 'receiptId', 'orderId', 'round', 'attemptId', 'channel', 'proofKind',
  'observedAt', 'materialSha256', 'referenceSha256', 'receiptSha256',
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SAFE_ATTEMPT = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_CHANNEL = /^[A-Za-z0-9_-]{1,60}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROOF_KINDS = new Set([
  'email_provider_accepted',
  'portal_success_page',
  'candidate_handoff_link',
  'employer_acknowledgement',
  'owner_confirmation',
  'candidate_confirmation',
]);

function stable(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => stable(item)).join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function receiptBody(receipt) {
  return Object.fromEntries(RECEIPT_FIELDS.filter(field => field !== 'receiptSha256').map(field => [field, receipt[field]]));
}

function urlReference(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function referenceFor(proofKind, evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  switch (proofKind) {
    case 'email_provider_accepted': {
      const provider = String(evidence.provider || '').trim().slice(0, 80);
      const messageId = String(evidence.messageId || '').trim().slice(0, 300);
      return provider && messageId ? sha256([proofKind, provider, messageId]) : null;
    }
    case 'portal_success_page': {
      const reference = urlReference(evidence.finalUrl);
      return reference ? sha256([proofKind, reference]) : null;
    }
    case 'candidate_handoff_link': {
      const reference = urlReference(evidence.url);
      return reference ? sha256([proofKind, reference]) : null;
    }
    case 'employer_acknowledgement': {
      const receivedAt = Number(evidence.receivedAt);
      return Number.isSafeInteger(receivedAt) && receivedAt > 0 ? sha256([proofKind, receivedAt]) : null;
    }
    case 'owner_confirmation': {
      const via = String(evidence.via || '').trim();
      const actor = String(evidence.actor || '').trim().toLowerCase();
      return ['owner', 'owner_extension'].includes(via) && actor ? sha256([proofKind, via, actor]) : null;
    }
    case 'candidate_confirmation': {
      const actor = String(evidence.actor || '').trim().toLowerCase();
      const confirmedAt = Number(evidence.confirmedAt);
      return actor && Number.isSafeInteger(confirmedAt) && confirmedAt > 0
        ? sha256([proofKind, actor, confirmedAt]) : null;
    }
    default:
      return null;
  }
}

/**
 * Build a minimal receipt. Raw provider IDs, URLs, candidate details and file
 * names are hashed and never stored in this receipt.
 */
export function createSubmissionReceipt({ orderId, round, attemptId, channel, proofKind, evidence, sentRecord, observedAt }) {
  const id = String(orderId || '');
  const attempt = String(attemptId || '');
  const transport = String(channel || '');
  const numberRound = Number(round);
  const at = Number(observedAt);
  const referenceSha256 = referenceFor(proofKind, evidence);
  if (!SAFE_ID.test(id) || !SAFE_ATTEMPT.test(attempt) || !SAFE_CHANNEL.test(transport)
    || !Number.isInteger(numberRound) || numberRound < 1 || numberRound > 20
    || !Number.isSafeInteger(at) || at <= 0 || !PROOF_KINDS.has(proofKind) || !referenceSha256
    || !sentRecord || typeof sentRecord !== 'object' || Array.isArray(sentRecord)) return null;
  const body = {
    version: SUBMISSION_RECEIPT_VERSION,
    receiptId: sha256([id, numberRound, attempt]).slice(0, 40),
    orderId: id,
    round: numberRound,
    attemptId: attempt,
    channel: transport,
    proofKind,
    observedAt: at,
    materialSha256: sha256(sentRecord),
    referenceSha256,
  };
  return { ...body, receiptSha256: sha256(body) };
}

/** Validate exact shape, cryptographic consistency and the requested context. */
export function verifySubmissionReceipt(receipt, expected = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).length !== RECEIPT_FIELDS.length
    || Object.keys(receipt).some(field => !RECEIPT_FIELDS.includes(field))) return false;
  if (receipt.version !== SUBMISSION_RECEIPT_VERSION || !SAFE_ID.test(receipt.orderId || '')
    || !SAFE_ATTEMPT.test(receipt.attemptId || '') || !SAFE_CHANNEL.test(receipt.channel || '')
    || !Number.isInteger(receipt.round) || receipt.round < 1 || receipt.round > 20
    || !PROOF_KINDS.has(receipt.proofKind) || !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt <= 0
    || !HASH.test(receipt.materialSha256 || '') || !HASH.test(receipt.referenceSha256 || '')
    || !HASH.test(receipt.receiptSha256 || '')) return false;
  if (receipt.receiptId !== sha256([receipt.orderId, receipt.round, receipt.attemptId]).slice(0, 40)
    || receipt.receiptSha256 !== sha256(receiptBody(receipt))) return false;
  if (expected.orderId != null && receipt.orderId !== String(expected.orderId)) return false;
  if (expected.round != null && receipt.round !== Number(expected.round)) return false;
  if (expected.attemptId != null && receipt.attemptId !== String(expected.attemptId)) return false;
  if (expected.channel != null && receipt.channel !== String(expected.channel)) return false;
  if (expected.sentRecord != null && receipt.materialSha256 !== sha256(expected.sentRecord)) return false;
  if (expected.receiptId != null && receipt.receiptId !== String(expected.receiptId)) return false;
  return true;
}
