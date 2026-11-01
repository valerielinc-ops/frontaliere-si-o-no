/**
 * A rebuilt tailored CV published with the change that prints it, in one
 * guarded commit. The review page's writers (the photo, the line choices, the
 * candidate's edits and answers: assistedApplicationReview.js) and the
 * owner's answers (assistedApplicationAutomationAdmin.js) share it: every
 * correction of a value the CV prints rebuilds the CV before anything else
 * happens, the submission included (decision 7 of 2026-10-03), because the
 * submission sends the PDF the draft names (scripts/assisted-application/lib/submit.mjs).
 */

import { draftRefFor, flowRefFor } from './assistedApplicationAutomation.js';
import { candidateQuestionAnswerKey, ORDER_QUESTION_ANSWER_EVIDENCE_VERSION, rememberCandidateQuestionAnswers } from './assistedApplicationCandidateEdits.js';
import { answerQuestionSnapshotQuestion, answerQuestionSnapshotsFor, orderQuestionAnswerContext, planCandidateAnswerEvidence, rememberOrderQuestionAnswerSnapshots } from './assistedApplicationAnswerEvidence.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from './assistedApplicationRetention.js';
import { documentFileId } from './assistedApplicationExtraDocuments.js';
import { rebuildTailoredCvPdf, supersededPhotoPdf, tailoredCvChanges } from './assistedApplicationTailoredCvPdf.js';

/** A refused commit or rebuild, answered with its status and code (409 changed_meanwhile, 503 storage_unavailable). */
export class CvCommitError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Objects no document names (a refused request's own, a replaced photo, a
 * superseded PDF), deleted at once. Best effort: a failed delete is logged and
 * never fails the request; the purge of the order's folder is the backstop.
 */
export async function deleteStored(bucket, orderId, keys) {
  if (!bucket) return;
  await Promise.all(keys.filter(Boolean).map(async (key) => {
    try {
      await bucket.file(key).delete({ ignoreNotFound: true });
    } catch (error) {
      console.warn('[assistedApplicationCvCommit] delete failed', orderId, documentFileId(key), String(error?.message || error).slice(0, 120));
    }
  }));
}

function retentionWriteAllowed(order, nowMs) {
  if (!order || order.retentionPurgingAt != null || order.retentionPurgedAt != null || order.retentionPayloadPurgedAt != null) return false;
  const purgeDueAt = retentionPurgeDueAt(order);
  return talentPoolConsentActive(order) || purgeDueAt == null || nowMs < purgeDueAt;
}

function candidateAnswerLedgerPatch({ profileSnapshot, currentOrder, ledger }) {
  const userId = String(ledger?.userId || '').trim();
  // A missing profile may represent account deletion; preserve the order-local answer without recreating it.
  if (!profileSnapshot?.exists || !userId || currentOrder?.userId !== userId
    || !retentionWriteAllowed(currentOrder, Date.now())) return null;

  const profile = profileSnapshot.data() || {};
  const update = planCandidateAnswerEvidence({
    questions: ledger.questions,
    changed: ledger.changed,
    confirmedQuestionSnapshots: ledger.confirmedQuestionSnapshots,
    previous: profile.applicationQuestionAnswerEvidence,
    latestWriteAt: Number(profile.applicationQuestionAnswersUpdatedAt) || 0,
    orderId: ledger.orderId,
    order: currentOrder,
    flow: ledger.flow,
    draft: ledger.draft,
    actor: ledger.actor,
    nowMs: ledger.nowMs,
  });
  if (!update.accepted.size) return null;

  const previous = profile.applicationQuestionAnswers;
  const merged = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}) };
  const changedKeys = new Set(ledger.questions
    .filter(question => Object.hasOwn(ledger.changed, question.id))
    .map(candidateQuestionAnswerKey));
  for (const [key, value] of Object.entries(ledger.questionAnswers)) {
    if (!changedKeys.has(key) || !update.accepted.has(key)) continue;
    delete merged[key];
    merged[key] = update.records[key]?.cleared ? '' : value;
  }

  return {
    applicationQuestionAnswers: Object.fromEntries(Object.entries(merged).slice(-80)),
    applicationQuestionAnswerEvidence: update.records,
    applicationQuestionAnswersUpdatedAt: Math.max(Number(profile.applicationQuestionAnswersUpdatedAt) || 0, Date.now()),
  };
}

function writeCandidateAnswerLedger(transaction, profileRef, profileSnapshot, currentOrder, ledger) {
  if (!profileRef || !ledger) return;
  const patch = candidateAnswerLedgerPatch({ profileSnapshot, currentOrder, ledger });
  if (patch) transaction.set(profileRef, patch, {
    mergeFields: ['applicationQuestionAnswers', 'applicationQuestionAnswerEvidence', 'applicationQuestionAnswersUpdatedAt'],
  });
}

/**
 * The commit of the writers that publish a rebuilt PDF (the photo, the line
 * choices, the candidate's edits and answers, the owner's answers): the flow
 * fields and the draft fields in one transaction, and only while what the
 * request built from is still there: the flow still in the state the request
 * read, this round, the same photo, the same PDFs and, for an edit, no other
 * edit saved meanwhile (an edit writes the e-mail, the letter and the
 * per-round texts whole: as it loaded them, plus its change).
 * Written as two merges built from the request's own snapshot, two
 * overlapping requests (two tabs, a request still running after a reload) or
 * a failure between the writes could leave `flow.photo` null beside a `pdfKey`
 * whose PDF carries the photo, the PDF chooseCv then sends.
 *
 * Refused: the objects the request stored (`created`) are deleted and the
 * page gets a 409 it answers by reloading. A transaction that throws may still
 * have committed: its objects are left to the purge, never deleted under a key
 * a document may name.
 * @param {object} input flow, draft: what the request loaded and built from;
 *   state: the flow state the request read (the review page's writers: candidate_review);
 *   edits: a candidate edit, built also on the letter PDF and the texts of the draft
 */
function answerSnapshotGuardMatches({ orderId, draft, guard }) {
  if (!guard) return true;
  if (Number(guard.draftRound) > 0 && Number(draft?.round) !== Number(guard.draftRound)) return false;
  const answerIds = Array.isArray(guard.answerIds) ? guard.answerIds : [];
  const current = answerQuestionSnapshotsFor({ orderId, questions: draft?.questions || [], draft, nowMs: guard.nowMs });
  return answerIds.every(id => current[id] && guard.snapshots?.[id] === current[id]);
}

export async function commitRebuild({ db, bucket, orderId, flow, draft, state = 'candidate_review', edits = false, created = [], flowPatch = null, draftPatch, answerSnapshotGuard = null, replaceAnswerMaps = false, candidateAnswerLedger = null, nowMs }) {
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const flowRef = flowRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  const profileRef = candidateAnswerLedger?.userId
    ? db.collection('user_cv_profiles').doc(candidateAnswerLedger.userId) : null;
  const same = (left, right) => (left || null) === (right || null);
  const committed = await db.runTransaction(async (transaction) => {
    const [orderSnapshot, flowSnapshot, draftSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef),
      profileRef ? transaction.get(profileRef) : Promise.resolve(null),
    ]);
    if (!orderSnapshot.exists || !retentionWriteAllowed(orderSnapshot.data(), Date.now())) return false;
    const current = { flow: flowSnapshot.data() || {}, draft: draftSnapshot.data() || {} };
    const unchanged = current.flow.state === state
      && Number(current.flow.round || 1) === Number(flow.round || 1)
      && answerSnapshotGuardMatches({ orderId, draft: current.draft, guard: answerSnapshotGuard })
      && same(current.flow.photo?.key, flow.photo?.key)
      && same(current.draft.tailoredCv?.pdfKey, draft.tailoredCv?.pdfKey)
      && (!edits || (same(current.draft.coverLetterPdfKey, draft.coverLetterPdfKey) && same(current.draft.candidateEditedAt, draft.candidateEditedAt)));
    if (!unchanged) return false;
    writeCandidateAnswerLedger(transaction, profileRef, profileSnapshot, orderSnapshot.data(), candidateAnswerLedger);
    if (flowPatch && replaceAnswerMaps) {
      const { answers, ...answerMaps } = flowPatch;
      if (answers !== undefined) transaction.set(flowRef, { answers, updatedAt: nowMs }, { merge: true });
      if (Object.keys(answerMaps).length) transaction.set(flowRef, answerMaps, { mergeFields: Object.keys(answerMaps) });
    } else if (flowPatch) transaction.set(flowRef, { ...flowPatch, updatedAt: nowMs }, { merge: true });
    transaction.set(draftRef, draftPatch, { merge: true });
    return true;
  });
  if (committed) return true;
  await deleteStored(bucket, orderId, created);
  throw new CvCommitError('changed_meanwhile', 409);
}

/**
 * The tailored CV rebuilt for a writer that commits with commitRebuild. The
 * photo the request loaded can be gone before the rebuild reads it: taken back
 * or replaced by another request, which deletes it after its own commit. That
 * is the commit's refusal met earlier (what the request stored so far,
 * `created`, deleted; the 409 the page answers by reloading), not a 500.
 * The photo upload needs none: it reads only the photo it has just stored, a
 * key no other request knows, or no photo at all.
 */
export async function rebuildCvToCommit({ created = [], ...input }) {
  try {
    return await rebuildTailoredCvPdf(input);
  } catch (error) {
    // Storage answers 404 for the photo that is no longer there.
    if (error?.code !== 404 || !input.flow?.photo?.key) throw error;
    await deleteStored(input.bucket, input.orderId, created);
    throw new CvCommitError('changed_meanwhile', 409);
  }
}

/**
 * Answers (the candidate's or the owner's) saved with the tailored CV they
 * print: rebuilt and committed together, before any flow event can dispatch
 * the submission (decision 7). Only the request's own keys are written. A
 * submitted or failed flow keeps its PDF (the record of what left); a
 * renderer or a Storage that fails saves nothing; no bucket, no answers.
 * @returns {Promise<{rebuilt:boolean}>}
 */
export async function saveAnswersWithCv({ db, bucket, orderId, order, flow, draft, answers, answerQuestionSnapshots = {}, answerSnapshotQuestions = null, nowMs, answerActor = null }) {
  const mergedAnswers = { ...(flow.answers || {}), ...answers };
  const orderContext = orderQuestionAnswerContext({ orderId, flow, draft, nowMs });
  const localQuestionDescriptors = Array.isArray(answerSnapshotQuestions) ? answerSnapshotQuestions
    : (draft?.questions || []).map(question => answerQuestionSnapshotQuestion({ question, draft }));
  const currentQuestionSnapshots = answerQuestionSnapshotsFor({ orderId, questions: localQuestionDescriptors, draft, nowMs });
  if (Object.keys(answers || {}).some(id => !currentQuestionSnapshots[id] || answerQuestionSnapshots[id] !== currentQuestionSnapshots[id])) {
    throw new CvCommitError('changed_meanwhile', 409);
  }
  const confirmedQuestionSnapshots = Object.fromEntries(Object.entries(answers || {}).flatMap(([id]) =>
    answerQuestionSnapshots[id] && answerQuestionSnapshots[id] === currentQuestionSnapshots[id]
      ? [[id, currentQuestionSnapshots[id]]] : []));
  const evidenceQuestionSnapshots = answerQuestionSnapshotsFor({ orderId, questions: draft?.questions || [], draft, nowMs });
  const sourceQuestionSnapshotGuard = evidenceQuestionSnapshots;
  const allAnswersConfirmed = Object.keys(answers || {}).length > 0
    && Object.keys(answers || {}).every(id => Boolean(confirmedQuestionSnapshots[id]));
  const trustedOrderAnswers = ['candidate', 'owner'].includes(answerActor) && allAnswersConfirmed;
  const previousOrderAnswers = orderContext.orderAnswers;
  const orderAnswerValues = { ...orderContext.answers, ...answers };
  const questionAnswers = rememberCandidateQuestionAnswers({
    questions: localQuestionDescriptors,
    answers: orderAnswerValues,
    previous: previousOrderAnswers,
    changed: answers,
  });
  const questionAnswerSnapshots = rememberOrderQuestionAnswerSnapshots({ orderId, questions: localQuestionDescriptors, draft,
    answers: orderAnswerValues, changed: answers, questionAnswers, previous: orderContext.questionAnswerSnapshots,
    previousQuestionIds: orderContext.questionAnswerSnapshotIds, previousCompatibility: orderContext.questionAnswerCompatibility,
    confirmed: confirmedQuestionSnapshots, nowMs });
  const orderQuestionAnswersEvidenceVersion = trustedOrderAnswers ? ORDER_QUESTION_ANSWER_EVIDENCE_VERSION : null;
  const nextFlow = { ...flow, answers: mergedAnswers, questionAnswers, questionAnswerSnapshots: questionAnswerSnapshots.snapshots,
    questionAnswerSnapshotIds: questionAnswerSnapshots.questionIds, questionAnswerCompatibility: questionAnswerSnapshots.compatibility,
    orderQuestionAnswersEvidenceVersion };
  const answerUserId = String(order?.userId || '').trim();
  const candidateAnswerLedger = answerUserId && Object.keys(questionAnswers).length
    && Number(draft?.round) === Number(flow.round || 1)
    ? { userId: answerUserId, orderId, questions: draft?.questions || [], changed: answers,
      confirmedQuestionSnapshots: evidenceQuestionSnapshots, questionAnswers, flow, draft: draft || {},
      actor: answerActor, nowMs }
    : null;
  const live = Boolean(draft) && Number(draft.round) === Number(flow.round || 1) && !['submitted', 'failed'].includes(flow.state);
  if (!live || !tailoredCvChanges({ order, draft, flow, nextFlow })) {
    const flowRef = flowRefFor(db, orderId);
    const draftRef = draftRefFor(db, orderId);
    const profileRef = candidateAnswerLedger
      ? db.collection('user_cv_profiles').doc(candidateAnswerLedger.userId) : null;
    const committed = await db.runTransaction(async transaction => {
      const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
      const [currentOrder, currentFlow, currentDraft, profileSnapshot] = await Promise.all([
        transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef),
        profileRef ? transaction.get(profileRef) : Promise.resolve(null),
      ]);
      if (!currentOrder.exists || !retentionWriteAllowed(currentOrder.data(), Date.now())
        || !currentFlow.exists || currentFlow.data()?.state !== flow.state
        || Number(currentFlow.data()?.round || 1) !== Number(flow.round || 1)
        || !answerSnapshotGuardMatches({ orderId, draft: currentDraft.data() || {},
          guard: { answerIds: Object.keys(sourceQuestionSnapshotGuard), snapshots: sourceQuestionSnapshotGuard,
            draftRound: Number(draft?.round) || 1, nowMs } })) return false;
      writeCandidateAnswerLedger(transaction, profileRef, profileSnapshot, currentOrder.data(), candidateAnswerLedger);
      transaction.set(flowRef, { answers, updatedAt: nowMs }, { merge: true });
      transaction.set(flowRef, { questionAnswers, questionAnswerSnapshots: questionAnswerSnapshots.snapshots,
        questionAnswerSnapshotIds: questionAnswerSnapshots.questionIds, questionAnswerCompatibility: questionAnswerSnapshots.compatibility,
        orderQuestionAnswersEvidenceVersion }, { mergeFields: ['questionAnswers', 'questionAnswerSnapshots', 'questionAnswerSnapshotIds',
        'questionAnswerCompatibility', 'orderQuestionAnswersEvidenceVersion'] });
      return true;
    });
    if (!committed) throw new CvCommitError('changed_meanwhile', 409);
    return { rebuilt: false };
  }
  if (!bucket) throw new CvCommitError('storage_unavailable', 503);
  const rebuilt = await rebuildCvToCommit({ bucket, order, orderId, draft, flow: nextFlow, nowMs });
  const rebuildCommitted = await commitRebuild({
    db, bucket, orderId, flow, draft, state: flow.state, nowMs, created: [rebuilt.pdfKey],
    flowPatch: { answers, questionAnswers, questionAnswerSnapshots: questionAnswerSnapshots.snapshots,
      questionAnswerSnapshotIds: questionAnswerSnapshots.questionIds, questionAnswerCompatibility: questionAnswerSnapshots.compatibility,
      orderQuestionAnswersEvidenceVersion },
    replaceAnswerMaps: true,
    answerSnapshotGuard: { answerIds: Object.keys(sourceQuestionSnapshotGuard), snapshots: sourceQuestionSnapshotGuard,
      draftRound: Number(draft?.round) || 1, nowMs },
    candidateAnswerLedger,
    draftPatch: { tailoredCv: { pdfKey: rebuilt.pdfKey, renderer: rebuilt.renderer, photo: rebuilt.photo } },
  });
  if (rebuildCommitted === false) {
    await deleteStored(bucket, orderId, [rebuilt.pdfKey]);
    throw new CvCommitError('changed_meanwhile', 409);
  }
  await deleteStored(bucket, orderId, [supersededPhotoPdf(draft)]);
  return { rebuilt: true };
}
