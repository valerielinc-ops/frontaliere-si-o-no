import { submissionRefFor } from './assistedApplicationSubmissionGuard.js';
import { submissionIrreversibility, publicSubmissionState } from './assistedApplicationSubmissionState.js';
import { qualificationCounterContext, qualificationAnswerOriginContext, qualificationCounterContextHash } from './lib/qualificationCounterContext.js';
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
import { candidateQuestionAnswerKey, rememberCandidateQuestionAnswers } from './assistedApplicationCandidateEdits.js';
import { answerContractsFor, planAnswerConfirmations, localAnswerEvidence, sameAnswerMaterial, answerSourceRetained, AnswerConfirmationError } from './assistedApplicationAnswerConfirmation.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { planCandidateAnswerEvidence } from './assistedApplicationAnswerEvidence.js';
import { documentFileId } from './assistedApplicationExtraDocuments.js';
import { rebuildTailoredCvPdf, supersededPhotoPdf, tailoredCvChanges } from './assistedApplicationTailoredCvPdf.js';

/** A refused commit or rebuild, answered with its status and code (409 changed_meanwhile, 503 storage_unavailable). */
export class CvCommitError extends Error {
  constructor(code, status, details = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
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
export async function commitRebuild({ db, bucket, orderId, flow, draft, state = 'candidate_review', edits = false, created = [], flowPatch = null, draftPatch, nowMs }) {
  const flowRef = flowRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const submissionRef = submissionRefFor(db, orderId);
  const same = (left, right) => (left || null) === (right || null);
  let irreversibleError = null;
  const committed = await db.runTransaction(async (transaction) => {
    irreversibleError = null; // Firestore can retry the callback with a different current ledger.
    const [flowSnapshot, draftSnapshot, orderSnapshot, submissionSnapshot] = await Promise.all([transaction.get(flowRef), transaction.get(draftRef), transaction.get(orderRef), transaction.get(submissionRef)]);
    const irreversibility = submissionIrreversibility({ submission: submissionSnapshot.data() });
    if (irreversibility) { irreversibleError = new CvCommitError(irreversibility, 409, { state: publicSubmissionState({ order: orderSnapshot.data(), flow: flowSnapshot.data(), submission: submissionSnapshot.data() }) }); return false; }
    if (!orderSnapshot.exists || !answerSourceRetained(orderSnapshot.data(), Math.max(nowMs, Date.now()))) return false;
    const current = { flow: flowSnapshot.data() || {}, draft: draftSnapshot.data() || {} };
    const unchanged = current.flow.state === state
      && Number(current.flow.round || 1) === Number(flow.round || 1)
      && same(current.flow.photo?.key, flow.photo?.key)
      && same(current.draft.tailoredCv?.pdfKey, draft.tailoredCv?.pdfKey)
      && (!edits || (same(current.draft.coverLetterPdfKey, draft.coverLetterPdfKey) && same(current.draft.candidateEditedAt, draft.candidateEditedAt)));
    if (!unchanged) return false;
    if (flowPatch) transaction.set(flowRef, { ...flowPatch, updatedAt: nowMs }, { merge: true });
    transaction.set(draftRef, draftPatch, { merge: true });
    return true;
  });
  if (committed) return;
  await deleteStored(bucket, orderId, created);
  throw irreversibleError || new CvCommitError('changed_meanwhile', 409);
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
    if (error?.code === 'artifact_retention_closed') {
      await deleteStored(input.bucket, input.orderId, created);
      throw new CvCommitError('changed_meanwhile', 409);
    }
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
 * submitted flow takes no answer, with or without a receipt: the Word copies
 * are built from these answers, the PDF that left is not. A failed flow keeps
 * its PDF (the record of what left); a renderer or a Storage that fails saves
 * nothing; no bucket, no answers.
 * @returns {Promise<{rebuilt:boolean}>}
 */
export async function saveAnswersWithCv({ db, bucket, orderId, order, flow, draft, answers, nowMs, answerActor = null, answerContracts = {}, requireAnswerContracts = false }) {
  if (!answers || !Object.keys(answers).length) throw new CvCommitError('no_valid_answers', 400);
  const startedAt = Date.now();
  const currentTime = () => Math.max(nowMs + Math.max(0, Date.now() - startedAt), Date.now());
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const flowRef = flowRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  const intakeRef = orderRef.collection('automation').doc('intake');
  const submissionRef = submissionRefFor(db, orderId);
  const [intakeSnapshot, submissionSnapshot, freshOrder, freshFlow] = await Promise.all([intakeRef.get(), submissionRef.get(), orderRef.get(), flowRef.get()]);
  const initialIrreversibility = submissionIrreversibility({ submission: submissionSnapshot.data() });
  if (initialIrreversibility) throw new CvCommitError(initialIrreversibility, 409, { state: publicSubmissionState({ order: freshOrder.data(), flow: freshFlow.data(), submission: submissionSnapshot.data() }) });
  if ([flow?.state, freshFlow.data()?.state].includes('submitted')) throw new CvCommitError('already_sent', 409, { state: 'submitted' });
  const intake = intakeSnapshot.data() || null;
  const mergedAnswers = { ...(flow.answers || {}), ...answers };
  const previousMemory = { ...(flow.questionAnswers || {}) };
  for (const id of Object.keys(answers)) {
    const previous = flow.answerConfirmations?.[id]; const question = draft?.questions?.find(question => question?.id === id);
    if (previous?.provenance?.orderId !== orderId || previous.provenance.userId !== String(order.userId || '')
      || previous.question?.id !== id || !/^confirmation-[a-f0-9]{64}$/.test(previous.id || '')) continue;
    const oldKey = candidateQuestionAnswerKey(previous.question);
    if (oldKey && oldKey !== candidateQuestionAnswerKey(question)) delete previousMemory[oldKey];
  }
  const questionAnswers = rememberCandidateQuestionAnswers({ questions: draft?.questions || [], answers: mergedAnswers,
    previous: previousMemory, changed: answers });
  const candidateFlow = { ...flow, answers: mergedAnswers, questionAnswers };
  const beforeCounterHash = qualificationCounterContextHash(qualificationCounterContext({ order, flow, intake }));
  const sourceCounterHash = qualificationCounterContextHash(qualificationAnswerOriginContext({ order, flow: candidateFlow, intake }));
  let confirmation;
  try {
    confirmation = planAnswerConfirmations({ orderId, order, flow, draft, answers, answerContracts, actor: answerActor, nowMs, sourceCounterHash, intake });
  } catch (error) {
    if (error instanceof AnswerConfirmationError) throw new CvCommitError(error.code, error.status, error.details);
    throw error;
  }
  if (confirmation.reviewRequired && requireAnswerContracts) throw new CvCommitError('answer_contract_required', 409,
    { reviewRequired: true, answerConfirmation: { status: 'review_required', authority: false } });
  const nextFlow = { ...candidateFlow, answerConfirmations: confirmation.confirmations };
  const persistCandidateQuestionAnswers = async () => {
    const userId = String(order?.userId || '').trim();
    if (!userId) return;
    const profileRef = db.collection('user_cv_profiles').doc(userId);
    try {
      await db.runTransaction(async transaction => {
        const [snapshot, sourceOrder, sourceFlow, sourceDraft, sourceIntake] = await Promise.all([
          transaction.get(profileRef), transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef), transaction.get(intakeRef),
        ]);
        if (!snapshot.exists || !sourceOrder.exists || !sourceFlow.exists || !sourceDraft.exists || !answerSourceRetained(sourceOrder.data(), currentTime())) return;
        const local = localAnswerEvidence({ orderId, order: sourceOrder.data(), flow: sourceFlow.data(), draft: sourceDraft.data(), intake: sourceIntake.data() || null, nowMs: currentTime() });
        const confirmed = Object.fromEntries(local.map(record => [record.question.id, record]));
        // A late mirror cannot resurrect a receipt that a later save cleared/replaced.
        const changed = Object.fromEntries(Object.entries(answers).filter(([id, value]) =>
          (!confirmation.reviewRequired || value == null || typeof value === 'string' && !value.trim() || Array.isArray(value) && !value.some(item => String(item ?? '').trim()))
          && sameAnswerMaterial(sourceFlow.data().answerConfirmations?.[id], confirmation.confirmations[id])));
        if (!Object.keys(changed).length) return;
        const current = snapshot.data()?.applicationQuestionAnswers;
        const update = planCandidateAnswerEvidence({ questions: sourceDraft.data().questions || [], changed,
          confirmations: { ...Object.fromEntries(Object.entries(sourceFlow.data().answerConfirmations || {}).filter(([, receipt]) => receipt?.cleared)), ...confirmed }, previous: snapshot.data()?.applicationQuestionAnswerEvidence,
          latestWriteAt: Number(snapshot.data()?.applicationQuestionAnswersUpdatedAt) || 0,
          orderId, order: sourceOrder.data(), flow: sourceFlow.data(), draft: sourceDraft.data(), actor: answerActor, nowMs, limit: null });
        if (!update.accepted.size) return;
        const merged = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}) };
        // One selection owns both maps, including eviction and metadata-only clear clocks.
        for (const key of update.accepted) {
          const record = update.records[key];
          if (!record) continue;
          delete merged[key]; merged[key] = record.cleared ? '' : record.answer;
        }
        const selected = Object.fromEntries(Object.entries(merged).slice(-80));
        const evidence = Object.fromEntries(Object.entries(update.records).filter(([key, record]) => record && Object.hasOwn(selected, key)
          && sameAnswerMaterial(selected[key], record.cleared ? '' : record.answer)));
        transaction.set(profileRef, { applicationQuestionAnswers: selected, applicationQuestionAnswerEvidence: evidence,
          applicationQuestionAnswersUpdatedAt: Math.max(Number(snapshot.data()?.applicationQuestionAnswersUpdatedAt) || 0, nowMs),
        }, { mergeFields: ['applicationQuestionAnswers', 'applicationQuestionAnswerEvidence', 'applicationQuestionAnswersUpdatedAt'] });
      });
    } catch (error) {
      // The local confirmed receipt remains valid; a failed optional account mirror grants no extra authority.
      console.warn('[assistedApplicationCvCommit] candidate answer ledger failed', orderId, error instanceof Error ? error.message : String(error));
    }
  };
  const live = Boolean(draft) && Number(draft.round) === Number(flow.round || 1) && flow.state !== 'failed';
  const needsRebuild = !confirmation.reviewRequired && live && tailoredCvChanges({ order, draft, flow, nextFlow });
  if (needsRebuild && !bucket) throw new CvCommitError('storage_unavailable', 503);
  const rebuilt = needsRebuild ? await rebuildCvToCommit({ db, bucket, order, orderId, draft, flow: nextFlow, nowMs }) : null;
  let committed;
  try {
    committed = await db.runTransaction(async transaction => {
      const [os, fs, ds, ins, ss] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef), transaction.get(intakeRef), transaction.get(submissionRef)]);
      const irreversibility = submissionIrreversibility({ submission: ss.data() });
      if (irreversibility) throw new CvCommitError(irreversibility, 409, { state: publicSubmissionState({ order: os.data(), flow: fs.data(), submission: ss.data() }) });
      // Sent while the PDF was built: refused here, before any contract or field comparison can answer otherwise.
      if (fs.data()?.state === 'submitted') throw new CvCommitError('already_sent', 409, { state: 'submitted' });
      if (!os.exists || !fs.exists || !ds.exists) return false;
      const currentFlow = fs.data(); const currentDraft = ds.data();
      if (qualificationCounterContextHash(qualificationCounterContext({ order: os.data(), flow: currentFlow, intake: ins.data() || null })) !== beforeCounterHash) return false;
      const contractUnchanged = sameAnswerMaterial(answerContractsFor({ orderId, order, flow, draft }),
        answerContractsFor({ orderId, order: os.data(), flow: currentFlow, draft: currentDraft }));
      if (!contractUnchanged) throw new AnswerConfirmationError('answer_contract_changed');
      const unchanged = ['state', 'round', 'answers', 'questionAnswers', 'answerConfirmations', 'photo', 'formOverrides', 'feedback'].every(field => sameAnswerMaterial(flow[field], currentFlow[field]))
        && ['tailoredCv', 'candidateEditedAt', 'coverLetterPdfKey'].every(field => sameAnswerMaterial(draft[field], currentDraft[field]));
      if (!unchanged) return false;
      // Revalidate source retention and all supplied contracts inside the write transaction.
      if (!answerSourceRetained(os.data(), currentTime())) throw new AnswerConfirmationError('answer_contract_changed');
      planAnswerConfirmations({ orderId, order: os.data(), flow: currentFlow, draft: currentDraft, answers, answerContracts, actor: answerActor, nowMs, sourceCounterHash, intake: ins.data() || null });
      transaction.set(flowRef, { answers: mergedAnswers, questionAnswers, answerConfirmations: confirmation.confirmations,
        answerReviewRequired: confirmation.reviewRequired, updatedAt: nowMs },
      { mergeFields: ['answers', 'questionAnswers', 'answerConfirmations', 'answerReviewRequired', 'updatedAt'] });
      if (rebuilt) transaction.set(draftRef, { tailoredCv: { pdfKey: rebuilt.pdfKey, renderer: rebuilt.renderer, photo: rebuilt.photo } }, { merge: true });
      return true;
    });
  } catch (error) {
    // A transaction may have committed before a transport failure; never delete its possibly referenced PDF.
    if (error instanceof AnswerConfirmationError || error instanceof CvCommitError) {
      if (rebuilt) await deleteStored(bucket, orderId, [rebuilt.pdfKey]);
      throw new CvCommitError(error.code, error.status, error.details);
    }
    throw error;
  }
  if (!committed) {
    if (rebuilt) await deleteStored(bucket, orderId, [rebuilt.pdfKey]);
    throw new CvCommitError('changed_meanwhile', 409);
  }
  if (rebuilt) await deleteStored(bucket, orderId, [supersededPhotoPdf(draft)]);
  await persistCandidateQuestionAnswers();
  return { rebuilt: Boolean(rebuilt), reviewRequired: confirmation.reviewRequired, rawSaved: true,
    answerConfirmation: { status: confirmation.reviewRequired ? 'review_required' : 'confirmed', authority: !confirmation.reviewRequired } };
}
