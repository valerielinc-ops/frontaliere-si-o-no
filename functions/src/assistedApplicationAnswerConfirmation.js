/** Latest server-owned, value-bound receipt for the exact question shown in one order/round.
 * A new confirmation replaces the current pointer with a new ID; clear retains metadata only.
 * No permanent history of superseded Q/A is kept, and old pointers fail closed. */
import { createHash } from 'node:crypto';
import { answerQuestionDescriptor, canonicalQuestionJson } from './lib/applicationQuestionContract.js';
import { validateAnswer } from './lib/answerRules.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from './assistedApplicationRetention.js';

export const ANSWER_CONFIRMATION_VERSION = 'native-answer-confirmation-v1';
export const ANSWER_CONTRACT_REQUIRED_RC_KEY = 'ASSISTED_APPLICATION_ANSWER_CONTRACT_REQUIRED';
/** Compatibility rollout only: source proof is mandatory regardless of this switch. Server template cache refreshes in five minutes. */
export async function answerContractRequired(getValue) {
  try { return String(await getValue(ANSWER_CONTRACT_REQUIRED_RC_KEY)).trim().toLowerCase() === 'true'; }
  catch { return false; }
}
export const sameAnswerMaterial = (left, right) => canonicalQuestionJson(left ?? null) === canonicalQuestionJson(right ?? null);
const hash = value => createHash('sha256').update(canonicalQuestionJson(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const hasAnswer = value => typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && Boolean(value.trim()) || Array.isArray(value) && value.length > 0;

export class AnswerConfirmationError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; this.details = {
    reviewRequired: true, answerConfirmation: { status: 'review_required', authority: false },
  }; }
}

export function answerSourceRetained(order, nowMs) {
  if (!order || order.retentionPurgedAt != null || order.retentionPurgingAt != null || !Number.isFinite(nowMs)) return false;
  const due = retentionPurgeDueAt(order);
  return talentPoolConsentActive(order) || Number.isFinite(due) && nowMs < due;
}

export function confirmedCvHash(order = {}, draft = {}) {
  return draft.cvKey && draft.cvKey === order.cvStorageKey && /^[a-f0-9]{64}$/.test(draft.sourceCvHash || '') ? draft.sourceCvHash : '';
}

function contractOf({ orderId, order = {}, flow = {}, draft = {}, question }) {
  const descriptor = answerQuestionDescriptor(question);
  const native = descriptor?.originalNativeContract;
  const round = Number(flow.round || 1);
  const unavailableOwner = value => value && (value.questionOwned === false || value.ownConsentQuestionOwned === false
    || value.metadataComplete === false || value.ownConsentMetadataComplete === false
    || value.ownershipUnknown === true || value.consentOwnershipUnknown === true);
  if (!orderId || !descriptor || !descriptor.id || !Number.isInteger(round) || round < 1 || Number(draft.round) !== round
    || descriptor.addressContext?.unknown || unavailableOwner(descriptor)
    || native?.addressContext?.unknown || unavailableOwner(native)) return null;
  return { version: ANSWER_CONFIRMATION_VERSION, orderId, userId: String(order.userId || ''), round,
    jobId: String(order.jobId || ''), jobUrl: String(order.jobUrl || ''),
    applyUrl: String(draft.channel?.applyUrl || draft.job?.applyUrl || ''), cvHash: confirmedCvHash(order, draft), question: descriptor };
}

/** GET exposes hashes only; clients return them verbatim and cannot attest native metadata. */
export function answerContractsFor(input) {
  const entries = (Array.isArray(input.draft?.questions) ? input.draft.questions : []).slice(0, 80);
  const duplicate = new Set(entries.filter((q, i) => q?.id && entries.findIndex(other => other?.id === q.id) !== i).map(q => q.id));
  return Object.fromEntries(entries.flatMap(question => {
    const contract = contractOf({ ...input, question });
    return contract && !duplicate.has(question.id) ? [[question.id, hash(contract)]] : [];
  }));
}

/** Withdrawn questions do not keep a current round in an unresolvable review hold. */
export function currentAnswerReviewRequired(flow = {}, draft = {}) {
  const questions = object(draft).questions;
  const ids = new Set((Array.isArray(questions) ? questions : []).map(question => question?.id));
  return Object.entries(object(object(flow).answerConfirmations)).some(([id, record]) => ids.has(id) && record?.provisional === true);
}

/** Missing hashes are provisional; a supplied stale hash never confirms a changed question. */
export function planAnswerConfirmations({ orderId, order, flow, draft, answers, answerContracts = {}, actor, nowMs }) {
  if (!['candidate', 'owner'].includes(actor) || !answerSourceRetained(order, nowMs)
    || flow.retentionPurgedAt != null || Number(draft?.round) !== Number(flow.round || 1)) throw new AnswerConfirmationError('answer_contract_changed');
  const contracts = answerContractsFor({ orderId, order, flow, draft });
  const previous = object(flow.answerConfirmations);
  const currentIds = new Set((draft.questions || []).map(question => question?.id));
  const confirmations = Object.fromEntries(Object.entries(previous).filter(([id, record]) => currentIds.has(id) && record?.provenance?.round === Number(flow.round || 1)));
  for (const [id, answer] of Object.entries(answers)) {
    const question = draft.questions.find(item => item?.id === id);
    const supplied = object(answerContracts)[id];
    if (!question || !contracts[id] || supplied != null && supplied !== contracts[id]) throw new AnswerConfirmationError('answer_contract_changed');
    if (Number(previous[id]?.provenance?.confirmedAt) > nowMs) throw new AnswerConfirmationError('answer_contract_changed');
    const provenance = { actor, orderId, userId: String(order.userId || ''), round: Number(flow.round || 1), confirmedAt: nowMs,
      cvHash: confirmedCvHash(order, draft), jobId: String(order.jobId || ''), jobUrl: String(order.jobUrl || '') };
    const checked = validateAnswer(answer, question, { todayIso: new Date(nowMs).toISOString().slice(0, 10) });
    if (supplied && hasAnswer(answer) && !checked.ok) throw new AnswerConfirmationError('invalid_answers', 400);
    const valid = Boolean(supplied) && hasAnswer(answer) && checked.ok;
    const record = { version: ANSWER_CONFIRMATION_VERSION, contractHash: contracts[id], provisional: !supplied, provenance,
      ...(valid ? { question: answerQuestionDescriptor(question), answer } : { cleared: true }) };
    confirmations[id] = { id: `confirmation-${hash(record)}`, ...record };
  }
  if (Object.keys(confirmations).length > 80) throw new AnswerConfirmationError('answer_contract_changed');
  return { confirmations, reviewRequired: currentAnswerReviewRequired({ answerConfirmations: confirmations }, draft) };
}

/** Recheck the current pointer, raw value, native contract and source retention. */
export function localAnswerEvidence({ orderId, order, flow, draft, nowMs = Date.now() }) {
  if (!answerSourceRetained(order, nowMs) || flow?.retentionPurgedAt != null) return [];
  const contracts = answerContractsFor({ orderId, order, flow, draft });
  return Object.entries(object(flow?.answerConfirmations)).slice(0, 80).flatMap(([id, record]) => {
    const source = record?.provenance;
    if (!record || record.cleared || record.version !== ANSWER_CONFIRMATION_VERSION || !/^confirmation-[a-f0-9]{64}$/.test(record.id || '')
      || source?.orderId !== orderId || source.userId !== String(order.userId || '') || source.round !== Number(flow.round || 1)
      || !['candidate', 'owner'].includes(source.actor) || !Number.isFinite(source.confirmedAt) || source.confirmedAt <= 0 || source.confirmedAt > nowMs
      || record.contractHash !== contracts[id] || !sameAnswerMaterial(record.answer, flow.answers?.[id])
      || !sameAnswerMaterial(record.question, answerQuestionDescriptor(draft?.questions?.find(q => q?.id === id)))
      || !validateAnswer(record.answer, record.question, { todayIso: new Date(nowMs).toISOString().slice(0, 10) }).ok) return [];
    return [{ ...record, category: 'local_answer', scope: 'job', unit: ['yes_no', 'checkbox'].includes(record.question.type) ? 'boolean' : 'question_specific_value' }];
  });
}
