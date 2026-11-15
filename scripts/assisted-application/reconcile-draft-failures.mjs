#!/usr/bin/env node
/** Queue one safe regeneration for an approved flow whose current draft run failed. */
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { isUnconfirmedSubmission } from '../../functions/src/assistedApplicationSubmissionGuard.js';
import {
  DRAFT_AUTO_RETRY_DELAY_MS,
  DRAFT_AUTO_RETRY_MAX_ATTEMPTS,
  DRAFT_CANDIDATE_EMAIL_MISSING_CODE,
  DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
  draftAutoRetryCountValue,
} from '../../functions/src/assistedApplicationDraftRetryPolicy.js';
import { AUTOMATION_FLAG_KEY, parseAutomationFlag } from '../../functions/src/assistedApplicationAutomationFlag.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from '../../functions/src/assistedApplicationCvCheck.js';
import { recoverCandidateDocumentEmail } from '../../functions/src/assistedApplicationCandidateDocumentEmailRecovery.js';

export const DRAFT_RECOVERY_VERSION = 'draft-recovery-v1';

export function isFirestoreIndexUnavailableError(error) {
  const code = error?.code;
  const message = typeof error?.message === 'string' ? error.message : String(error ?? '');
  const failedPrecondition = code === 9 || String(code) === '9'
    || ['FAILED_PRECONDITION', 'failed-precondition'].includes(String(code))
    || /\bFAILED_PRECONDITION\b/i.test(message);
  return failedPrecondition && /\bindex(?:es)?\b/i.test(message);
}

function hasUncertainSend(record) {
  return record?.state === 'sent' || record?.state === 'sending' || record?.state === 'claimed'
    || record?.sentAttempt || isUnconfirmedSubmission(record);
}

export async function reconcileDraftFailures({ db, apply = false, nowMs = Date.now(), isEnabled = null } = {}) {
  const summary = { scanned: 0, eligible: 0, queued: 0, apply };
  if (!isEnabled) {
    const template = await getRemoteConfig().getTemplate();
    const flag = parseAutomationFlag(template.parameters?.[AUTOMATION_FLAG_KEY]?.defaultValue?.value);
    isEnabled = orderId => flag.all || flag.orders.has(orderId);
  }
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', 'owner_takeover')
      .orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      summary.scanned++;
      if (!(await isEnabled(doc.id))) continue;
      const eligible = await db.runTransaction(async transaction => {
        const flowRef = doc.ref.collection('automation').doc('flow');
        const submissionRef = doc.ref.collection('automation').doc('submission');
        const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
          transaction.get(doc.ref),
          transaction.get(flowRef),
          transaction.get(doc.ref.collection('ai_drafts').doc('current')),
          transaction.get(submissionRef),
        ]);
        const order = orderDoc.data() || {};
        const flow = flowDoc.data() || {};
        const draft = draftDoc.data() || {};
        const submission = submissionDoc.data() || {};
        const round = Number(flow.round) || 1;
        const currentSend = submission[`r${round}`];
        const draftMissing = Number(draft.round) !== round;
        const failedDraft = flow.state === 'owner_takeover'
          && Array.isArray(flow.heldBy) && flow.heldBy.length === 1 && flow.heldBy[0] === 'draft_failed';
        const draftDispatch = flow.dispatch?.mode === 'draft' && Number(flow.dispatch?.round) === round;
        const attempts = draftAutoRetryCountValue(flow);
        const recoveryClockSet = Number(flow.draftAutoRetryAt) > 0;
        let candidateEmailRecovery = false;
        if (attempts !== null && attempts >= DRAFT_AUTO_RETRY_MAX_ATTEMPTS
          && flow.draftCandidateEmailRecoveryVersion !== DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION) {
          const failedEvents = await transaction.get(doc.ref.collection('automation_events')
            .where('error', '==', DRAFT_CANDIDATE_EMAIL_MISSING_CODE));
          candidateEmailRecovery = failedEvents.docs.some(eventDoc => {
            const event = eventDoc.data() || {};
            return event.type === 'draft_failed' && Number(event.round) === round;
          });
        }
        const activeOrder = order.paymentStatus === 'paid'
          && !order.withdrawnAt && !order.retentionPurgingAt && !order.retentionPurgedAt
          && !order.retentionPayloadPurgedAt
          && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
          && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus);
        const noSendEvidence = !draft.sent && !draft.sentAttempt
          && !hasUncertainSend(currentSend) && !Object.values(submission).some(hasUncertainSend);
        if (!activeOrder || !failedDraft || !draftMissing || !draftDispatch || attempts === null
          || (attempts >= DRAFT_AUTO_RETRY_MAX_ATTEMPTS && !candidateEmailRecovery) || recoveryClockSet || !noSendEvidence
          || flow.postingExpiredAt) return false;
        if (apply) {
          const dueAt = nowMs + DRAFT_AUTO_RETRY_DELAY_MS;
          transaction.set(flowRef, {
            // The dedicated, versioned recovery grants exactly one fresh run
            // for existing candidate-email failures whose regular retry was
            // already consumed. The normal state transition increments it.
            draftAutoRetryCount: candidateEmailRecovery ? 0 : attempts,
            draftAutoRetryAt: dueAt,
            ...(candidateEmailRecovery
              ? { draftCandidateEmailRecoveryVersion: DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION }
              : { draftRecoveryVersion: DRAFT_RECOVERY_VERSION }),
            updatedAt: nowMs,
          }, { merge: true });
          transaction.set(doc.ref, { automationDueAt: dueAt, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          transaction.set(doc.ref.collection('events').doc(), {
            type: 'draft_recovery_scheduled', actor: 'system', at: nowMs,
            version: candidateEmailRecovery ? DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION : DRAFT_RECOVERY_VERSION,
          });
        }
        return true;
      });
      if (eligible) {
        summary.eligible++;
        if (apply) summary.queued++;
      }
    }
    cursor = page.docs.length === 100 ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

/** Repair contact-only document rendering for drafts produced by the older email recovery. */
export async function reconcileCandidateDocumentEmails({
  db,
  bucket = null,
  auth = null,
  apply = false,
  nowMs = Date.now(),
  recover = recoverCandidateDocumentEmail,
} = {}) {
  const summary = {
    scanned: 0, eligible: 0, updated: 0, skipped: 0, retryScheduled: 0, indexUnavailable: false, apply,
  };
  if (!db || typeof db.collectionGroup !== 'function') return summary;

  let cursor;
  do {
    let query = db.collectionGroup('automation')
      .where('draftCandidateEmailRecoveryVersion', '==', DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION)
      .orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    let page;
    try {
      page = await query.get();
    } catch (error) {
      if (!isFirestoreIndexUnavailableError(error)) throw error;
      summary.indexUnavailable = true;
      console.warn(
        'Firestore index for automation.draftCandidateEmailRecoveryVersion is unavailable; '
        + 'candidate document recovery is deferred until a later deploy.',
      );
      break;
    }
    for (const flowDoc of page.docs) {
      const orderRef = flowDoc.ref.parent.parent;
      const orderId = orderRef?.id;
      summary.scanned++;
      if (!orderId) continue;
      const outcome = await recover({ db, bucket, auth, orderId, nowMs, apply });
      if (outcome.status === 'eligible') summary.eligible++;
      else if (outcome.status === 'updated') summary.updated++;
      else if (outcome.status === 'skipped') summary.skipped++;
      else if (outcome.status === 'retry_scheduled') summary.retryScheduled++;
    }
    cursor = page.docs.length === 100 ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-draft-failures.mjs [--dry-run | --apply]');
  }
  const db = await getFirestoreDb();
  const { getStorage } = await import('firebase-admin/storage');
  const apply = args.includes('--apply');
  const draftFailures = await reconcileDraftFailures({ db, apply });
  const candidateDocuments = await reconcileCandidateDocumentEmails({
    db,
    bucket: getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET),
    apply,
  });
  console.log(JSON.stringify({ ...draftFailures, candidateDocuments }));
}
