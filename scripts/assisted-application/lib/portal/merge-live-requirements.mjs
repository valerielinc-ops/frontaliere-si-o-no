/**
 * Persist only the live contract observed by this still-current, unsent run.
 *
 * Recovery contract: this file changes what held applications may resume, so
 * currentPortalCodeVersion() hashes every .mjs in this directory and
 * assisted-application-portal-recovery.yml triggers on it both through the
 * directory glob and by explicit path. Keep the two workflow entries together.
 */
import { isDeepStrictEqual } from 'node:util';
import { dedupePortalQuestions, portalQuestionKey } from './portal.mjs';
import { mergeRequiredDocuments, requiredDocumentLabelKey, requiredDocumentsOf } from '../../../../functions/src/assistedApplicationExtraDocuments.js';
import { privacySemanticIdentifierFields } from '../../../../functions/src/lib/applicationConsent.js';
import { isUnconfirmedSubmission } from '../../../../functions/src/assistedApplicationSubmissionGuard.js';

const label = question => String(question?.applicationQuestion || question?.question || '').replace(/\s*\*\s*$/, '').trim().replace(/\s+/g, ' ');
const PROVENANCE_KEYS = ['portalNativeContract', 'originalNativeContract', 'ownConsentText', 'ownConsentQuestionLabels',
  'ownConsentLinks', 'ownConsentMetadataComplete', 'ownConsentQuestionOwned', 'ownConsentOwnerKey', 'consentOwnershipUnknown'];
const PORTAL_FIELD_METADATA_KEYS = ['ariaLabel', 'ariaDescription', 'title', 'placeholder', 'description', 'labels', 'privacyMetadataIncomplete'];
const CONTRACT_KEYS = [...new Set(['question', 'applicationQuestion', 'type', 'options', 'applicationOptions', 'optionMap', 'validation', 'required', 'context', 'section', 'autocomplete', ...PROVENANCE_KEYS,
  ...privacySemanticIdentifierFields.filter(key => key !== 'id'), ...PORTAL_FIELD_METADATA_KEYS])];
function sameField(old, live) {
  if (old?.source !== 'portal' || live?.source !== 'portal' || !label(old) || label(old) !== label(live)) return false;
  return ['context', 'section', 'autocomplete'].every(key => !String(old[key] || '').trim()
    || String(old[key]).trim() === String(live[key] || '').trim());
}

export function mergeLivePortalQuestions(existingQuestions = [], incomingQuestions = []) {
  const questions = dedupePortalQuestions(existingQuestions).map(question => ({ ...question }));
  const incoming = dedupePortalQuestions(incomingQuestions);
  const ids = new Map();
  const uniqueId = (items, id) => items.filter(question => question?.id === id).length === 1;
  if (incoming.length !== incomingQuestions.length || incomingQuestions.some(question => !String(question?.id || '').trim() || !uniqueId(incomingQuestions, question.id))) {
    return { questions, ids, ambiguous: true };
  }
  const matches = new Map();
  const references = new Set();
  // Determine the relation before mutating either catalogue: missing context
  // cannot pick the first of two otherwise identical fields on a later form.
  for (const live of incoming) {
    const byId = existingQuestions.filter(question => question.id === live.id);
    // The pre-submit gate sends bounded descriptors of existing questions,
    // without native provenance. Keep the reference, never upgrade a contract
    // from that shortened descriptor.
    if (live.source !== 'portal') {
      if (byId.length !== 1) return { questions, ids, ambiguous: true };
      matches.set(live, byId[0].id);
      references.add(live);
      continue;
    }
    const byField = existingQuestions.filter(question => sameField(question, live));
    const old = byId.length === 1 && sameField(byId[0], live) ? byId[0]
      : !byId.length && byField.length === 1 ? byField[0] : null;
    if (old && uniqueId(existingQuestions, old.id) && uniqueId(incomingQuestions, live.id)
      && byField.length === 1 && incomingQuestions.filter(question => sameField(old, question)).length === 1) {
      matches.set(live, old.id);
    } else if (questions.some(question => question.id === live.id
      || (portalQuestionKey(question) || question.id) === (portalQuestionKey(live) || live.id))) {
      return { questions, ids, ambiguous: true };
    }
  }
  for (const live of incoming) {
    const oldId = matches.get(live);
    const old = oldId && questions.find(question => question.id === oldId);
    if (old) {
      for (const key of references.has(live) ? [] : CONTRACT_KEYS) {
        if (Object.hasOwn(live, key)) old[key] = structuredClone(live[key]);
        else if (['optionMap', 'validation', ...PROVENANCE_KEYS, ...PORTAL_FIELD_METADATA_KEYS].includes(key)) delete old[key];
      }
      ids.set(live.id, old.id);
    } else {
      questions.push(structuredClone(live));
      ids.set(live.id, live.id);
    }
  }
  return { questions, ids, ambiguous: false };
}

// Reasons a live requirement cannot be stored. Reported as
// `requirement_context_changed:<reason>` (functions/src/assistedApplicationFlow.js
// retries only the ones that can clear by themselves).
const canon = value => {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, canon(item)]));
  }
  return value;
};
const same = (a, b) => isDeepStrictEqual(canon(a), canon(b));
const pick = (source, keys) => Object.fromEntries(keys.map(key => [key, source?.[key]]));
// Only what the live question was read against. Counters, heartbeats, e-mail
// engagement and whatever this very run wrote (a prepared photo on
// flow.documents) do not make a discovered question obsolete.
const ORDER_CONTEXT_KEYS = ['jobUrl', 'cvStorageKey', 'paymentStatus', 'submissionStatus', 'refundStatus', 'withdrawnAt', 'retentionPurgedAt'];
const FLOW_CONTEXT_KEYS = ['state', 'round', 'executionId', 'answers', 'questionAnswers', 'questionAnswerSnapshots', 'formOverrides', 'portalRecoveryVersion'];
// Remote execution claims move these two counters; only an actor that attests its own generation in the
// transaction (validateExecutionInTransaction) may ignore them, any other writer must see them unchanged.
const REMOTE_COUNTER_KEYS = ['remoteExecutionRound', 'remoteExecutionAttempts'];
const flowContext = (flow, withCounters) => ({ ...pick(flow, FLOW_CONTEXT_KEYS), ...(withCounters ? pick(flow, REMOTE_COUNTER_KEYS) : {}),
  dispatch: pick(flow?.dispatch, ['mode', 'round', 'sourceSha']) });
const DRAFT_CONTEXT_KEYS = ['status', 'round', 'questions', 'requiredDocuments', 'approval', 'job', 'channel'];
const documentFileKeys = document => (Array.isArray(document?.files) ? document.files : []).map(file => file?.key ?? JSON.stringify(canon(file)));
// Files may only be added (by this run); a removed or replaced one is a real change.
const documentsStillPresent = (expected = {}, current = {}) => Object.entries(expected || {}).every(([id, document]) => {
  const present = new Set(documentFileKeys(current?.[id]));
  return documentFileKeys(document).every(key => present.has(key));
});

export async function persistLivePortalRequirementsDetailed({ db, orderRef, expected, round, event, validateExecutionInTransaction = null }) {
  const rawQuestions = Array.isArray(event.questions) ? event.questions : [];
  const details = Array.isArray(event.questionDetails) ? event.questionDetails
    : rawQuestions.filter(question => question && typeof question === 'object' && question.question);
  const incoming = details.filter(question => question && typeof question === 'object' && question.question);
  const rawDocuments = Array.isArray(event.documents) ? event.documents : [];
  const incomingDocuments = rawDocuments.filter(document => document && typeof document === 'object');
  const merged = mergeLivePortalQuestions(expected.draft.questions || [], incoming);
  if (merged.ambiguous) return { ok: false, reason: 'ambiguous_identity' };
  const requiredDocuments = mergeRequiredDocuments(expected.draft.requiredDocuments || [], incomingDocuments);
  const patch = {};
  if (incoming.length) patch.questions = merged.questions;
  if (incomingDocuments.length) patch.requiredDocuments = requiredDocuments;
  const draftRef = orderRef.collection('ai_drafts').doc('current');
  const flowRef = orderRef.collection('automation').doc('flow');
  const submissionRef = orderRef.collection('automation').doc('submission');
  const rejected = await db.runTransaction(async tx => {
    const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
      tx.get(orderRef), tx.get(flowRef), tx.get(draftRef), tx.get(submissionRef),
    ]);
    const order = orderDoc.data(); const flow = flowDoc.data(); const draft = draftDoc.data();
    const submission = submissionDoc.data() || {};
    // Remote execution claims may change only these two counters. The actor
    // must attest the current generation inside this same transaction first.
    if (validateExecutionInTransaction) {
      const context = await validateExecutionInTransaction(tx);
      if (!context || !isDeepStrictEqual(context.flow, flow)
        || !context.execution?.id || context.execution.id !== flow?.executionId) return 'execution_superseded';
    }
    if (Number(flow?.round) !== round || flow?.state !== 'submitting') return 'flow_not_submitting';
    if (order?.paymentStatus !== 'paid' || ['pending', 'succeeded', 'refunded'].includes(order?.refundStatus)
      || order?.withdrawnAt || order?.retentionPurgedAt || submission.withdrawnAt
      || ['sent', 'submitted', 'withdrawn', 'refunded'].includes(order?.submissionStatus)) return 'order_closed';
    if (Number(draft?.round) !== round || draft?.status !== 'ready') return 'draft_not_ready';
    if (draft?.sent || draft?.sentAttempt || Object.entries(submission).some(([key, value]) => /^r\d+$/.test(key)
      && (value?.state === 'sent' || isUnconfirmedSubmission(value)
        || (value?.state === 'sending' && value?.channel === 'email')))) return 'submission_started';
    if (!same(pick(order, ORDER_CONTEXT_KEYS), pick(expected.order, ORDER_CONTEXT_KEYS))) return 'order_changed';
    if (!same(flowContext(flow, !validateExecutionInTransaction), flowContext(expected.flow, !validateExecutionInTransaction))
      || !documentsStillPresent(expected.flow?.documents, flow?.documents)) return 'flow_changed';
    if (!same(pick(draft, DRAFT_CONTEXT_KEYS), pick(expected.draft, DRAFT_CONTEXT_KEYS))) return 'draft_changed';
    if (Object.keys(patch).length) tx.set(draftRef, patch, { merge: true });
    return null;
  });
  if (rejected) return { ok: false, reason: rejected };
  event.questions = rawQuestions.map(question => {
    const id = typeof question === 'string' ? question : question?.id;
    return merged.ids.get(id) || id;
  }).filter(Boolean);
  event.questionDetails = incoming.map(question => ({ ...question, id: merged.ids.get(question.id) || question.id }));
  event.documents = [...new Set(rawDocuments.map(raw => {
    if (typeof raw === 'string') return raw;
    const candidate = requiredDocumentsOf({ requiredDocuments: [raw] })[0];
    if (!candidate) return '';
    const key = requiredDocumentLabelKey(candidate.label);
    return requiredDocuments.find(document => document.id === candidate.id
      || (key && requiredDocumentLabelKey(document.label) === key))?.id || '';
  }).filter(Boolean))];
  return { ok: true, reason: null };
}

/** Boolean form kept for callers that do not report a reason. */
export async function persistLivePortalRequirements(args) {
  return (await persistLivePortalRequirementsDetailed(args)).ok;
}
