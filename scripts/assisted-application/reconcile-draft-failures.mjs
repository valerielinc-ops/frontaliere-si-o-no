#!/usr/bin/env node
/** Queue one safe regeneration for an approved flow whose current draft run failed. */
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { isUnconfirmedSubmission } from '../../functions/src/assistedApplicationSubmissionGuard.js';
import {
  DRAFT_AUTO_RETRY_DELAY_MS,
  DRAFT_AUTO_RETRY_MAX_ATTEMPTS,
  draftAutoRetryCountValue,
} from '../../functions/src/assistedApplicationDraftRetryPolicy.js';
import { AUTOMATION_FLAG_KEY, parseAutomationFlag } from '../../functions/src/assistedApplicationAutomationFlag.js';

export const DRAFT_RECOVERY_VERSION = 'draft-recovery-v1';

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
        const activeOrder = order.paymentStatus === 'paid'
          && !order.withdrawnAt && !order.retentionPurgingAt && !order.retentionPurgedAt
          && !order.retentionPayloadPurgedAt
          && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
          && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus);
        const noSendEvidence = !draft.sent && !draft.sentAttempt
          && !hasUncertainSend(currentSend) && !Object.values(submission).some(hasUncertainSend);
        if (!activeOrder || !failedDraft || !draftMissing || !draftDispatch || attempts === null
          || attempts >= DRAFT_AUTO_RETRY_MAX_ATTEMPTS || recoveryClockSet || !noSendEvidence
          || flow.postingExpiredAt) return false;
        if (apply) {
          const dueAt = nowMs + DRAFT_AUTO_RETRY_DELAY_MS;
          transaction.set(flowRef, {
            draftAutoRetryCount: attempts,
            draftAutoRetryAt: dueAt,
            draftRecoveryVersion: DRAFT_RECOVERY_VERSION,
            updatedAt: nowMs,
          }, { merge: true });
          transaction.set(doc.ref, { automationDueAt: dueAt, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          transaction.set(doc.ref.collection('events').doc(), {
            type: 'draft_recovery_scheduled', actor: 'system', at: nowMs, version: DRAFT_RECOVERY_VERSION,
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

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-draft-failures.mjs [--dry-run | --apply]');
  }
  console.log(JSON.stringify(await reconcileDraftFailures({ db: await getFirestoreDb(), apply: args.includes('--apply') })));
}
