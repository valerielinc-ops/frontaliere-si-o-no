import { createHash } from 'node:crypto';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const serialized = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(serialized(value)).digest('hex');

export const ANSWER_CONFIRMATION_VERSION = 'candidate-answer-confirmation-v2';

function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (Number.isFinite(value?.seconds)) return value.seconds * 1000 + Math.floor((Number(value.nanoseconds) || 0) / 1e6);
  return 0;
}

/** CV identity is bound to the immutable uploaded object, never to extracted or generated text. */
export function answerCvIdentity(order = {}) {
  const key = String(order.cvStorageKey || '').trim();
  const uploadedAt = timestampMillis(order.cvUploadedAt);
  if (!key || !Number.isFinite(uploadedAt) || uploadedAt <= 0) return null;
  return { cvStorageKey: key, cvUploadedAt: uploadedAt };
}

export function answerCvFingerprint({ order = {}, draft = {} } = {}) {
  const identity = answerCvIdentity(order);
  if (!identity || draft.cvKey !== identity.cvStorageKey) return null;
  return hash({ version: ANSWER_CONFIRMATION_VERSION, ...identity });
}

const ANSWER_SOURCES = new Set(['direct_user', 'cv_inferred', 'owner_attested']);
const ANSWER_ORIGINS = new Set(['cv_inferred', 'profile_inferred', 'candidate_reused', 'policy_default', 'unknown']);

/** Preserve only answer origins supplied by a server-side, evidence-verified flow. */
export function answerOriginMetadata({ question = {}, flow = {}, answer } = {}) {
  const id = String(question.id || '').trim();
  const flowOrigin = object(flow.answerOrigins)[id];
  const origin = flowOrigin && Object.hasOwn(flowOrigin, 'value') && sameAnswer(answer, flowOrigin.value) ? flowOrigin : {};
  const candidate = origin.originSource || origin.source || origin.kind;
  let originSource = ANSWER_ORIGINS.has(candidate) ? candidate : 'unknown';
  const sourceFingerprint = originSource === 'cv_inferred'
    ? String(origin.originCvFingerprint || origin.cvFingerprint || '') : '';
  if (originSource === 'cv_inferred' && !/^[a-f0-9]{64}$/.test(sourceFingerprint)) originSource = 'unknown';
  return { originSource, originCvFingerprint: originSource === 'cv_inferred' ? sourceFingerprint : null };
}

function sameAnswer(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null
    && JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Opaque contract returned with a visible question and echoed when its answer is confirmed. */
export function answerConfirmationHash({ userId, orderId, order = {}, flow = {}, draft = {}, questionSnapshotHash,
  sourceKind = 'direct_user', originSource = 'unknown', originCvFingerprint = null } = {}) {
  const candidateId = String(userId || order.userId || '').trim();
  const sourceOrderId = String(orderId || '').trim();
  const round = Number(flow.round || 1);
  const draftRound = Number(draft.round);
  const jobUrl = String(order.jobUrl || '').trim();
  const jobId = String(order.jobId || '').trim();
  const cvDependent = sourceKind === 'cv_inferred' || sourceKind === 'owner_attested';
  const cvIdentity = cvDependent ? answerCvIdentity(order) : null;
  const cvFingerprint = cvDependent ? answerCvFingerprint({ order, draft }) : null;
  const normalizedOrigin = ANSWER_ORIGINS.has(originSource) ? originSource : 'unknown';
  const originalCvFingerprint = normalizedOrigin === 'cv_inferred'
    && /^[a-f0-9]{64}$/.test(originCvFingerprint || '') ? originCvFingerprint : null;
  if (!candidateId || !sourceOrderId || (!jobId && !jobUrl) || !/^[a-f0-9]{64}$/.test(questionSnapshotHash || '')
    || !Number.isInteger(round) || round < 1 || draftRound !== round || !ANSWER_SOURCES.has(sourceKind)
    || cvDependent && (!cvIdentity || !cvFingerprint)) return null;
  return hash({ version: ANSWER_CONFIRMATION_VERSION, candidateId, orderId: sourceOrderId,
    jobId, jobUrl, round, sourceKind, originSource: normalizedOrigin, originCvFingerprint: originalCvFingerprint,
    ...(cvDependent ? { cvIdentity, draftCvKey: String(draft.cvKey || ''), cvFingerprint } : {}), questionSnapshotHash });
}

export function answerConfirmationId({ confirmationHash, answer, actor, confirmedAt } = {}) {
  if (!/^[a-f0-9]{64}$/.test(confirmationHash || '') || !['candidate', 'owner'].includes(actor)
    || !Number.isFinite(confirmedAt) || confirmedAt <= 0) return null;
  return hash({ version: ANSWER_CONFIRMATION_VERSION, confirmationHash, answer: canonical(answer), actor, confirmedAt });
}

export function answerEvidenceFingerprint(records = []) {
  const material = (Array.isArray(records) ? records : []).map(record => ({
    id: record?.id || null,
    key: record?.key || null,
    scope: record?.scope || null,
    confirmationId: record?.confirmationId || null,
    confirmationHash: record?.confirmationHash || null,
    sourceKind: record?.sourceKind || null,
    originSource: record?.originSource || null,
    originCvFingerprint: record?.originCvFingerprint || null,
    cvFingerprint: record?.cvFingerprint || null,
    questionSnapshotHash: record?.questionSnapshotHash || null,
    orderId: record?.provenance?.orderId || null,
    round: record?.provenance?.round || null,
  })).sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  return hash({ version: ANSWER_CONFIRMATION_VERSION, evidence: material });
}
