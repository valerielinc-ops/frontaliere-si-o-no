/** Persist only the live contract observed by this still-current, unsent run. */
import { isDeepStrictEqual } from 'node:util';
import { dedupePortalQuestions, portalQuestionKey } from './portal.mjs';
import { mergeRequiredDocuments, requiredDocumentLabelKey, requiredDocumentsOf } from '../../../../functions/src/assistedApplicationExtraDocuments.js';

const label = question => String(question?.applicationQuestion || question?.question || '').replace(/\s*\*\s*$/, '').trim().replace(/\s+/g, ' ');
const PROVENANCE_KEYS = ['portalNativeContract', 'originalNativeContract', 'ownConsentText', 'ownConsentQuestionLabels',
  'ownConsentLinks', 'ownConsentMetadataComplete', 'ownConsentQuestionOwned', 'ownConsentOwnerKey', 'consentOwnershipUnknown'];
const CONTRACT_KEYS = ['question', 'applicationQuestion', 'type', 'options', 'applicationOptions', 'optionMap', 'validation', 'required', 'context', 'section', 'autocomplete', ...PROVENANCE_KEYS];
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
        else if (['optionMap', 'validation', ...PROVENANCE_KEYS].includes(key)) delete old[key];
      }
      ids.set(live.id, old.id);
    } else {
      questions.push(structuredClone(live));
      ids.set(live.id, live.id);
    }
  }
  return { questions, ids, ambiguous: false };
}

export async function persistLivePortalRequirements({ db, orderRef, expected, round, event, validateExecutionInTransaction = null }) {
  const rawQuestions = Array.isArray(event.questions) ? event.questions : [];
  const details = Array.isArray(event.questionDetails) ? event.questionDetails
    : rawQuestions.filter(question => question && typeof question === 'object' && question.question);
  const incoming = details.filter(question => question && typeof question === 'object' && question.question);
  const rawDocuments = Array.isArray(event.documents) ? event.documents : [];
  const incomingDocuments = rawDocuments.filter(document => document && typeof document === 'object');
  const merged = mergeLivePortalQuestions(expected.draft.questions || [], incoming);
  if (merged.ambiguous) return false;
  const requiredDocuments = mergeRequiredDocuments(expected.draft.requiredDocuments || [], incomingDocuments);
  const patch = {};
  if (incoming.length) patch.questions = merged.questions;
  if (incomingDocuments.length) patch.requiredDocuments = requiredDocuments;
  const draftRef = orderRef.collection('ai_drafts').doc('current');
  const flowRef = orderRef.collection('automation').doc('flow');
  const submissionRef = orderRef.collection('automation').doc('submission');
  const accepted = await db.runTransaction(async tx => {
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
        || !context.execution?.id || context.execution.id !== flow?.executionId) return false;
    }
    const flowForComparison = { ...flow };
    if (validateExecutionInTransaction) for (const key of ['remoteExecutionRound', 'remoteExecutionAttempts']) {
      if (Object.hasOwn(expected.flow, key)) flowForComparison[key] = expected.flow[key];
      else delete flowForComparison[key];
    }
    if (!isDeepStrictEqual(order, expected.order) || !isDeepStrictEqual(flowForComparison, expected.flow)
      || !isDeepStrictEqual(draft, expected.draft) || Number(flow?.round) !== round || flow?.state !== 'submitting'
      || order?.paymentStatus !== 'paid' || ['pending', 'succeeded', 'refunded'].includes(order?.refundStatus)
      || order?.withdrawnAt || order?.retentionPurgedAt || submission.withdrawnAt
      || ['sent', 'submitted', 'withdrawn', 'refunded'].includes(order?.submissionStatus)
      || Number(draft?.round) !== round || draft?.status !== 'ready'
      || draft?.sent || draft?.sentAttempt || Object.entries(submission).some(([key, value]) => /^r\d+$/.test(key)
        && (value?.clickedAt || value?.state === 'sent' || (value?.state === 'sending' && value?.channel === 'email')))) return false;
    if (Object.keys(patch).length) tx.set(draftRef, patch, { merge: true });
    return true;
  });
  if (!accepted) return false;
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
  return true;
}
