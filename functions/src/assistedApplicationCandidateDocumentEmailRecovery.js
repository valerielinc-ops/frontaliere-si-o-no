import { randomUUID } from 'node:crypto';
import { candidateDocumentIdentity } from './assistedApplicationAiDraftCore.js';
import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import {
  DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
} from './assistedApplicationDraftRetryPolicy.js';
import { inPlaceReady } from './assistedApplicationDocxInPlace.js';
import { rebuildLetterPdf } from './assistedApplicationLetterPdf.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET, isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';
import { getStorage } from 'firebase-admin/storage';
import { withRegisteredCandidateEmail } from './assistedApplicationDocumentIdentity.js';
import { rebuildInPlaceDocx, rebuildTailoredCvPdf } from './assistedApplicationTailoredCvPdf.js';

export const DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_VERSION = 'draft-document-email-v1';
export const DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_MAX_ATTEMPTS = 2;
export const DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_RETRY_DELAY_MS = 5 * 60 * 1000;

const COLLECTION = 'assisted_applications';
const EVENT_TYPE = 'draft_candidate_email_document_recovered';
const EVENT_PREFIX = 'candidate-email-document-recovery';
const SEND_STATES = new Set(['sent', 'sending', 'claimed']);
const CLAIM_TTL_MS = 10 * 60 * 1000;

function hasSubmitDispatchEvidence(dispatch, round) {
  if (dispatch?.mode !== 'submit') return false;
  const dispatchRound = dispatch.round;
  // A submit dispatch with a missing or invalid round may already have reached
  // the employer. Treat it as evidence so recovery cannot rewrite its files.
  if (dispatchRound == null || !Number.isSafeInteger(dispatchRound) || dispatchRound <= 0) return true;
  return !Number.isSafeInteger(round) || round <= 0 || dispatchRound === round;
}

function hasSendEvidence({ flow, draft, submission, round }) {
  const current = submission?.[`r${round}`] || {};
  return SEND_STATES.has(current.state)
    || Number(current.clickedAt) > 0
    || current.sentAttempt
    || draft?.sent
    || draft?.sentAttempt
    || ['submitting', 'submitted', 'withdrawn'].includes(flow?.state)
    || flow?.submittedVia === 'postal'
    || hasSubmitDispatchEvidence(flow?.dispatch, round);
}

function eligibleState({ flow, draft, submission, nowMs = Date.now(), checkRecoveryClock = true, checkAttemptLimit = true }) {
  const round = Number(flow?.round) || 1;
  if (flow?.draftCandidateEmailRecoveryVersion !== DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION
    || flow?.draftCandidateEmailDocumentRecoveryVersion === DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_VERSION
    || draft?.status !== 'ready' || Number(draft?.round) !== round) return { eligible: false, round };
  if (hasSendEvidence({ flow, draft, submission, round })) return { eligible: false, round, reason: 'send_evidence' };
  const attempts = flow.draftCandidateEmailDocumentRecoveryAttemptCount === undefined
    ? 0 : Number(flow.draftCandidateEmailDocumentRecoveryAttemptCount);
  if (!Number.isSafeInteger(attempts) || attempts < 0
    || (checkAttemptLimit && attempts >= DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_MAX_ATTEMPTS)) {
    return { eligible: false, round, reason: 'attempt_limit' };
  }
  if (checkRecoveryClock) {
    const retryAt = Number(flow.draftCandidateEmailDocumentRecoveryRetryAt) || 0;
    const startedAt = Number(flow.draftCandidateEmailDocumentRecoveryStartedAt) || 0;
    if (retryAt > nowMs || (startedAt > 0 && nowMs - startedAt < CLAIM_TTL_MS)) {
      return { eligible: false, round, reason: 'backoff' };
    }
  }
  return { eligible: true, round };
}

function safeEvent({ nowMs, round, result, reason = null, documents = [] }) {
  return {
    type: EVENT_TYPE,
    actor: 'system',
    at: nowMs,
    version: DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_VERSION,
    round,
    result,
    ...(reason ? { reason } : {}),
    documents,
  };
}

function refsFor(db, orderId) {
  const orderRef = db.collection(COLLECTION).doc(orderId);
  return {
    orderRef,
    flowRef: orderRef.collection('automation').doc('flow'),
    submissionRef: orderRef.collection('automation').doc('submission'),
    draftRef: orderRef.collection('ai_drafts').doc('current'),
  };
}

async function readCurrent(db, refs) {
  return db.runTransaction(async transaction => {
    const [orderSnapshot, flowSnapshot, draftSnapshot, submissionSnapshot] = await Promise.all([
      transaction.get(refs.orderRef),
      transaction.get(refs.flowRef),
      transaction.get(refs.draftRef),
      transaction.get(refs.submissionRef),
    ]);
    return {
      order: orderSnapshot.data() || {},
      flow: flowSnapshot.data() || {},
      draft: draftSnapshot.data() || {},
      submission: submissionSnapshot.data() || {},
    };
  });
}

function flowWithoutRecoveryMetadata(flow) {
  const current = { ...(flow || {}) };
  delete current.draftCandidateEmailDocumentRecoveryAttemptCount;
  delete current.draftCandidateEmailDocumentRecoveryStartedAt;
  delete current.draftCandidateEmailDocumentRecoveryRetryAt;
  delete current.draftCandidateEmailDocumentRecoveryVersion;
  return current;
}

async function claimRecovery({ db, refs, nowMs }) {
  return db.runTransaction(async transaction => {
    const [orderSnapshot, flowSnapshot, draftSnapshot, submissionSnapshot] = await Promise.all([
      transaction.get(refs.orderRef),
      transaction.get(refs.flowRef),
      transaction.get(refs.draftRef),
      transaction.get(refs.submissionRef),
    ]);
    const current = {
      order: orderSnapshot.data() || {},
      flow: flowSnapshot.data() || {},
      draft: draftSnapshot.data() || {},
      submission: submissionSnapshot.data() || {},
    };
    const eligibility = eligibleState({ ...current, nowMs });
    if (!eligibility.eligible) return { ...current, status: 'ineligible', reason: eligibility.reason || null };
    const attemptCount = (Number(current.flow.draftCandidateEmailDocumentRecoveryAttemptCount) || 0) + 1;
    const startedAt = nowMs;
    transaction.set(refs.flowRef, {
      draftCandidateEmailDocumentRecoveryAttemptCount: attemptCount,
      draftCandidateEmailDocumentRecoveryStartedAt: startedAt,
      draftCandidateEmailDocumentRecoveryRetryAt: nowMs + DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_RETRY_DELAY_MS,
    }, { merge: true });
    return {
      ...current,
      flow: {
        ...current.flow,
        draftCandidateEmailDocumentRecoveryAttemptCount: attemptCount,
        draftCandidateEmailDocumentRecoveryStartedAt: startedAt,
        draftCandidateEmailDocumentRecoveryRetryAt: nowMs + DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_RETRY_DELAY_MS,
      },
      round: eligibility.round,
      status: 'claimed',
    };
  });
}

async function saveOutcome({ db, refs, expected, nowMs, result, reason = null, documents = [], draftPatch = null, complete = true }) {
  const eventRef = refs.orderRef.collection('events').doc(`${EVENT_PREFIX}-r${expected.round}`);
  return db.runTransaction(async transaction => {
    const [orderSnapshot, flowSnapshot, draftSnapshot, submissionSnapshot] = await Promise.all([
      transaction.get(refs.orderRef),
      transaction.get(refs.flowRef),
      transaction.get(refs.draftRef),
      transaction.get(refs.submissionRef),
    ]);
    const order = orderSnapshot.data() || {};
    const flow = flowSnapshot.data() || {};
    const draft = draftSnapshot.data() || {};
    const submission = submissionSnapshot.data() || {};
    const current = eligibleState({ flow, draft, submission, nowMs, checkRecoveryClock: false, checkAttemptLimit: false });
    const original = eligibleState({ ...expected, nowMs, checkRecoveryClock: false, checkAttemptLimit: false });
    if (!current.eligible || !original.eligible
      || JSON.stringify(draft) !== JSON.stringify(expected.draft)
      || JSON.stringify(flowWithoutRecoveryMetadata(flow)) !== JSON.stringify(flowWithoutRecoveryMetadata(expected.flow))
      || JSON.stringify(order) !== JSON.stringify(expected.order)) return false;
    if (Number(flow.draftCandidateEmailDocumentRecoveryAttemptCount) !== Number(expected.flow.draftCandidateEmailDocumentRecoveryAttemptCount)
      || Number(flow.draftCandidateEmailDocumentRecoveryStartedAt) !== Number(expected.flow.draftCandidateEmailDocumentRecoveryStartedAt)) return false;

    transaction.set(refs.flowRef, {
      draftCandidateEmailDocumentRecoveryStartedAt: 0,
      ...(complete ? { draftCandidateEmailDocumentRecoveryVersion: DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_VERSION } : {}),
      ...(!complete ? { draftCandidateEmailDocumentRecoveryRetryAt: nowMs + DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_RETRY_DELAY_MS } : {}),
    }, { merge: true });
    if (draftPatch) transaction.set(refs.draftRef, draftPatch, { merge: true });
    transaction.set(eventRef, safeEvent({ nowMs, round: expected.round, result, reason, documents }));
    return true;
  });
}

async function removeCreated(bucket, keys) {
  await Promise.all(keys.map(key => bucket.file(key).delete({ ignoreNotFound: true }).catch(() => {})));
}

/**
 * Repair only the contact rendering on an unsent, version-marked draft. The
 * stored letter and tailored CV text are passed through their existing pure
 * renderers; this function never invokes a model or edits answers/flow timing.
 */
export async function recoverCandidateDocumentEmail({
  db,
  bucket = null,
  auth = null,
  orderId,
  nowMs = Date.now(),
  apply = true,
  renderLetter = rebuildLetterPdf,
  renderCv = rebuildTailoredCvPdf,
  renderInPlace = rebuildInPlaceDocx,
} = {}) {
  if (!db || !orderId) return { status: 'ineligible', reason: 'missing_context' };
  const storage = bucket || getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  const refs = refsFor(db, String(orderId));
  let current = await readCurrent(db, refs);
  let eligibility = eligibleState({ ...current, nowMs });
  if (!eligibility.eligible) return { status: 'ineligible', reason: eligibility.reason || null };
  let expected = { ...current, round: eligibility.round };

  if (apply) {
    current = await claimRecovery({ db, refs, nowMs });
    if (current.status !== 'claimed') return { status: 'ineligible', reason: current.reason || null };
    eligibility = { eligible: true, round: current.round };
    expected = { ...current, round: current.round };
  }

  const order = await withRegisteredCandidateEmail(current.order, { auth });
  const { identity } = candidateWithEdits({ order, draft: current.draft, flow: current.flow });
  if (!candidateDocumentIdentity(identity, order).email) {
    if (!apply) return { status: 'eligible', reason: 'no_contact_source' };
    const saved = await saveOutcome({ db, refs, expected, nowMs, result: 'skipped', reason: 'no_contact_source' });
    return { status: saved ? 'skipped' : 'stale', reason: saved ? 'no_contact_source' : 'concurrent_change' };
  }

  if (!apply) return { status: 'eligible' };

  let draftPatch = {};
  const keys = [];
  const documents = [];
  if (inPlaceReady(current.draft)) {
    let inplace;
    try {
      inplace = await renderInPlace({ bucket: storage, order, draft: current.draft, flow: current.flow });
    } catch {
      inplace = null;
    }
    if (!inplace || inplace.status !== 'ready') {
      const saved = await saveOutcome({
        db, refs, expected, nowMs, result: 'skipped', reason: 'inplace_page_check_required',
      });
      return { status: saved ? 'skipped' : 'stale', reason: saved ? 'inplace_page_check_required' : 'concurrent_change' };
    }
    draftPatch.tailoredCv = { inplace };
    documents.push('in_place_cv');
  }

  try {
    if (current.draft.coverLetterPdfKey) {
      if (!isAssistedApplicationCvKey(orderId, current.draft.coverLetterPdfKey)) {
        throw new Error('invalid_letter_key');
      }
      const dateMs = Number(current.draft.completedAt) > 0 ? Number(current.draft.completedAt) : nowMs;
      const rendered = await renderLetter({
        order,
        orderId,
        draft: current.draft,
        flow: current.flow,
        letter: current.draft.coverLetter,
        nowMs,
        dateMs,
      });
      const key = `assisted-application-uploads/${orderId}/ai-cover-letter-r${eligibility.round}-email-recovery-${randomUUID().slice(0, 12)}.pdf`;
      await storage.file(key).save(rendered.pdf, { contentType: 'application/pdf', resumable: false });
      keys.push(key);
      draftPatch.coverLetterPdfKey = key;
      draftPatch.coverLetterRenderer = rendered.renderer;
      documents.push('letter');
    }

    if (current.draft.tailoredCv?.status === 'ready' && current.draft.tailoredCv?.pdfKey && current.draft.tailoredCv?.cv) {
      if (!isAssistedApplicationCvKey(orderId, current.draft.tailoredCv.pdfKey)) throw new Error('invalid_cv_key');
      const rendered = await renderCv({
        bucket: storage,
        order,
        orderId,
        draft: current.draft,
        flow: current.flow,
        nowMs,
      });
      if (!rendered?.pdfKey || !isAssistedApplicationCvKey(orderId, rendered.pdfKey)) throw new Error('cv_render_unavailable');
      keys.push(rendered.pdfKey);
      draftPatch.tailoredCv = {
        ...current.draft.tailoredCv,
        ...(draftPatch.tailoredCv || {}),
        pdfKey: rendered.pdfKey,
        renderer: rendered.renderer,
        photo: Boolean(rendered.photo),
        size: Number(rendered.size) || null,
      };
      documents.push('tailored_cv');
    }

    if (!documents.length) {
      await removeCreated(storage, keys);
      const saved = await saveOutcome({ db, refs, expected, nowMs, result: 'skipped', reason: 'no_renderable_documents' });
      return { status: saved ? 'skipped' : 'stale', reason: saved ? 'no_renderable_documents' : 'concurrent_change' };
    }
  } catch {
    await removeCreated(storage, keys);
    const finalAttempt = Number(expected.flow.draftCandidateEmailDocumentRecoveryAttemptCount)
      >= DRAFT_CANDIDATE_EMAIL_DOCUMENT_RECOVERY_MAX_ATTEMPTS;
    const saved = await saveOutcome({
      db, refs, expected, nowMs,
      result: finalAttempt ? 'skipped' : 'retry_scheduled',
      reason: 'render_unavailable',
      complete: finalAttempt,
    });
    return {
      status: saved ? (finalAttempt ? 'skipped' : 'retry_scheduled') : 'stale',
      reason: saved ? 'render_unavailable' : 'concurrent_change',
    };
  }

  const saved = await saveOutcome({ db, refs, expected, nowMs, result: 'updated', documents, draftPatch });
  if (!saved) {
    await removeCreated(storage, keys);
    return { status: 'stale', reason: 'concurrent_change' };
  }
  return { status: 'updated', documents };
}
