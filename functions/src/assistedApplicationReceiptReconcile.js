/** Reconcile an already SENT fact before new execution admission; this never authorizes a send. */
import { FieldValue } from 'firebase-admin/firestore';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { transition } from './assistedApplicationFlow.js';
import { assistedApplicationRetained } from './lib/assistedApplicationRetentionPolicy.js';
import { qualificationCounterContextHash } from './lib/qualificationCounterContext.js';
import { submissionAttemptHash, submissionSlotHash, submissionDraftMaterialHash, submissionAttemptMaterialHash, isMinimalSubmissionReceipt, submissionOwnerIntent } from './lib/submissionReceiptContract.js';
import { submittedOrderFields } from './lib/submittedOrderFields.js';

const SHA256 = /^[a-f0-9]{64}$/;


export async function reconcileCanonicalSubmissionReceipt({ db, orderId, round, nowMs = Date.now() }) {
  const startedAt = Date.now();
  const guardedRound = Number(round);
  if (!Number.isInteger(guardedRound) || guardedRound < 1) return { handled: false, reason: 'invalid_round' };
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const flowRef = orderRef.collection('automation').doc('flow');
  const draftRef = orderRef.collection('ai_drafts').doc('current');
  const submissionRef = orderRef.collection('automation').doc('submission');
  return db.runTransaction(async tx => {
    const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
      tx.get(orderRef), tx.get(flowRef), tx.get(draftRef), tx.get(submissionRef),
    ]);
    const record = submissionDoc.data()?.[`r${guardedRound}`];
    if (record?.state !== 'sent') return { handled: false, reason: 'not_sent', round: guardedRound };
    const handled = reason => ({ handled: true, reason, round: guardedRound });
    const order = orderDoc.data(); const flow = flowDoc.data(); const draft = draftDoc.data();
    // The durable fact still prevents a resend after deletion or withdrawal.
    // This path creates no event, draft, notification or other retained data.
    if (!order || !flow || !assistedApplicationRetained(order, nowMs)) return handled('receipt_only');
    if (Number(flow.round) !== guardedRound || Number(draft?.round) !== guardedRound) return handled('stale_round');
    if (order.withdrawnAt || flow.state === 'withdrawn') return handled('closed_slot');
    if (typeof record.attemptId !== 'string' || !record.attemptId) return handled('legacy_unbound');
    const attemptHash = submissionAttemptHash(record.attemptId);
    const proofRef = orderRef.collection('submission_receipts').doc(attemptHash);
    const frame = (await tx.get(proofRef)).data();
    if (!frame || frame.attemptHash !== attemptHash || frame.round !== guardedRound || !SHA256.test(frame.sourceFingerprint || '')
      || (frame.channel === 'owner_extension' && !submissionOwnerIntent(frame.ownerIntent))
      || !SHA256.test(frame.draftMaterialHash || '') || !SHA256.test(frame.attemptMaterialHash || '')
      || !isMinimalSubmissionReceipt(frame.minimalReceipt, attemptHash, guardedRound)) return handled('receipt_unbound');
    if (frame.slotHash !== submissionSlotHash({ orderId, order })) return handled('slot_changed');
    const attempt = draft.sentAttempt;
    if (frame.draftMaterialHash !== submissionDraftMaterialHash(draft)
      || (attempt && frame.attemptMaterialHash !== submissionAttemptMaterialHash(draft))) return handled('material_conflict');
    if (attempt && (attempt.submissionAttempt?.id !== record.attemptId
      || Number(attempt.submissionAttempt?.round) !== guardedRound)) return handled('material_conflict');
    if (draft.sent && !record.sent && (draft.sent.submissionAttempt?.id !== record.attemptId
      || Number(draft.sent.submissionAttempt?.round) !== guardedRound)) return handled('material_conflict');
    if (draft.sent && record.sent && qualificationCounterContextHash(draft.sent) !== qualificationCounterContextHash(record.sent)) return handled('material_conflict');
    const currentNowMs = nowMs + Math.max(0, Date.now() - startedAt);
    if (!assistedApplicationRetained(order, currentNowMs)) return handled('receipt_only');
    const timestamp = FieldValue.serverTimestamp();
    const channel = String(record.channel || frame.channel || 'automation').slice(0, 40);
    const orderPatch = submittedOrderFields({ order, flow: { ...flow, submittedVia: channel }, timestamp });
    if (!orderPatch && order.submissionStatus !== 'submitted') return handled('closed_slot');
    const transitionEventType = frame.channel === 'owner_extension' && submissionOwnerIntent(frame.ownerIntent)
      && ['owner_takeover', 'candidate_handoff'].includes(flow.state) ? 'owner_submitted' : 'submit_acknowledged';
    const result = flow.state === 'submitted' ? null : transition(flow, { type: transitionEventType }, { draft, nowMs: currentNowMs });
    if (result?.ignored) return handled('flow_not_compatible');
    if (!result && !orderPatch && !attempt && (draft.sent || !record.sent)) return handled('already_reconciled');
    // No source/eligibility check after a proven send, and no effect runner:
    // only the existing submitted fields and audit history are reconciled.
    if (result) {
      tx.set(flowRef, { ...flow, ...result.flow, submittedVia: channel, updatedAt: currentNowMs });
      tx.set(orderRef, { automationState: 'submitted', automationDueAt: null, automationUpdatedAt: timestamp }, { merge: true });
      tx.set(orderRef.collection('events').doc(`receipt-transition-${attemptHash}`), buildAssistedApplicationEvent('automation_transition', {
        actor: 'durable_receipt', transitionEventType, fromState: flow.state, toState: 'submitted', round: guardedRound,
      }));
    }
    if (orderPatch) {
      tx.set(orderRef, orderPatch, { merge: true });
      tx.set(orderRef.collection('events').doc(`receipt-completed-${attemptHash}`), buildAssistedApplicationEvent('manual_submission_completed', {
        actorEmail: 'automation', fromStatus: order.submissionStatus, toStatus: 'submitted', submissionNotes: orderPatch.submissionNotes, channel,
      }));
    }
    if ((!draft.sent && record.sent) || attempt) tx.set(draftRef, { sent: draft.sent || record.sent || { ...attempt, confirmedBy: 'durable_receipt', confirmedAt: currentNowMs }, sentAttempt: null }, { merge: true });
    return handled('reconciled');
  });
}
