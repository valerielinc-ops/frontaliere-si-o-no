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
  const same = (left, right) => (left || null) === (right || null);
  const committed = await db.runTransaction(async (transaction) => {
    const [flowSnapshot, draftSnapshot] = await Promise.all([transaction.get(flowRef), transaction.get(draftRef)]);
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
export async function saveAnswersWithCv({ db, bucket, orderId, order, flow, draft, answers, nowMs }) {
  const nextFlow = { ...flow, answers: { ...(flow.answers || {}), ...answers } };
  const live = Boolean(draft) && Number(draft.round) === Number(flow.round || 1) && !['submitted', 'failed'].includes(flow.state);
  if (!live || !tailoredCvChanges({ order, draft, flow, nextFlow })) {
    await flowRefFor(db, orderId).set({ answers, updatedAt: nowMs }, { merge: true });
    return { rebuilt: false };
  }
  if (!bucket) throw new CvCommitError('storage_unavailable', 503);
  const rebuilt = await rebuildCvToCommit({ bucket, order, orderId, draft, flow: nextFlow, nowMs });
  await commitRebuild({
    db, bucket, orderId, flow, draft, state: flow.state, nowMs, created: [rebuilt.pdfKey],
    flowPatch: { answers },
    draftPatch: { tailoredCv: { pdfKey: rebuilt.pdfKey, renderer: rebuilt.renderer, photo: rebuilt.photo } },
  });
  await deleteStored(bucket, orderId, [supersededPhotoPdf(draft)]);
  return { rebuilt: true };
}
