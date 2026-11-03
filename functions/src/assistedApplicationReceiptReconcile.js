/** Reconcile a durable send receipt when the runner's success event was lost. */
import { createHash } from 'node:crypto';
import { submissionGuard, submissionRefFor } from './assistedApplicationSubmissionGuard.js';
import { verifySubmissionReceipt } from './lib/submissionReceiptContract.js';

const orderRefFor = (db, orderId) => db.collection('assisted_applications').doc(String(orderId));
const flowRefFor = (db, orderId) => orderRefFor(db, orderId).collection('automation').doc('flow');

const AMBIGUOUS_HOLDS = new Set(['portal_ambiguous', 'portal_antibot_ambiguous', 'email_ambiguous']);
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
export const SUBMISSION_RECEIPT_RETRY_LIMIT = 12;

function receiptAt(record, receiptKey = 'receipt') {
  return receiptKey === 'candidate'
    ? record?.confirmationReceipts?.candidate || null
    : record?.receipt || null;
}

function validReceiptFor(record, receipt, orderId, round) {
  return verifySubmissionReceipt(receipt, {
    orderId, round, attemptId: record?.attemptId, channel: record?.channel,
    ...(receipt?.proofKind === 'candidate_confirmation'
      ? { attemptId: receipt.attemptId, channel: receipt.channel }
      : {}),
    sentRecord: record?.sent && typeof record.sent === 'object' ? record.sent : {},
  });
}

function legacyProofFor(record, orderId, round, nowMs) {
  // Records with an attempt id came from the receipt-aware writer. A missing
  // receipt there is a damaged modern record, not a legacy record to upgrade.
  if (record?.attemptId) return null;
  const observedAt = Number(record?.confirmedAt || record?.sentAt || nowMs);
  const attemptId = `legacy-${createHash('sha256').update(`${orderId}:${round}:${record?.channel}:${observedAt}`).digest('hex').slice(0, 32)}`;
  if (record?.channel === 'email' && record.provider && record.messageId) {
    return { kind: 'email_provider_accepted', attemptId, observedAt, evidence: { provider: record.provider, messageId: record.messageId } };
  }
  if (record?.channel && record.finalUrl) {
    return { kind: 'portal_success_page', attemptId, observedAt, evidence: { finalUrl: record.finalUrl } };
  }
  if (record?.confirmedBy === 'acknowledgement') {
    return { kind: 'employer_acknowledgement', attemptId, observedAt, evidence: { receivedAt: Number(record.confirmedAt || observedAt) } };
  }
  if (record?.by && ['owner', 'owner_extension'].includes(record.channel)) {
    return { kind: 'owner_confirmation', attemptId, observedAt, evidence: { via: record.channel, actor: record.by } };
  }
  return null;
}

async function setNextAttempt({ db, orderId, round, receiptId, receiptKey = 'receipt', nowMs, completed = false, reason = 'reconciliation_pending' }) {
  const orderRef = orderRefFor(db, orderId);
  const submissionRef = submissionRefFor(db, orderId);
  return db.runTransaction(async transaction => {
    const [orderSnapshot, submissionSnapshot] = await Promise.all([
      transaction.get(orderRef), transaction.get(submissionRef),
    ]);
    const order = orderSnapshot.data() || {};
    const current = submissionSnapshot.data()?.[`r${round}`] || {};
    if (receiptAt(current, receiptKey)?.receiptId !== receiptId) return false;
    if (completed || order.submissionStatus === 'submitted') {
      transaction.set(orderRef, { automationDueAt: null, submissionReceiptDueAt: null, submissionReceiptAttempts: 0,
        submissionReceiptStatus: 'complete', submissionReceiptIssue: null, submissionReceiptCheckedAt: nowMs }, { merge: true });
      return true;
    }
    const attempts = (Number(order.submissionReceiptAttempts) || 0) + 1;
    if (attempts >= SUBMISSION_RECEIPT_RETRY_LIMIT) {
      transaction.set(orderRef, { automationDueAt: null, submissionReceiptDueAt: null, submissionReceiptAttempts: attempts,
        submissionReceiptStatus: 'needs_review', submissionReceiptIssue: reason, submissionReceiptCheckedAt: nowMs }, { merge: true });
      return true;
    }
    const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 9));
    transaction.set(orderRef, { submissionReceiptDueAt: nowMs + delay, submissionReceiptAttempts: attempts,
      submissionReceiptStatus: 'pending', submissionReceiptIssue: reason, submissionReceiptCheckedAt: nowMs }, { merge: true });
    return true;
  });
}

async function deferInvalidReceipt({ db, orderId, round, receiptKey = 'receipt', observedRecord, nowMs }) {
  const orderRef = orderRefFor(db, orderId);
  const submissionRef = submissionRefFor(db, orderId);
  return db.runTransaction(async transaction => {
    const [orderSnapshot, submissionSnapshot] = await Promise.all([
      transaction.get(orderRef), transaction.get(submissionRef),
    ]);
    const order = orderSnapshot.data() || {};
    const current = submissionSnapshot.data()?.[`r${round}`] || null;
    // A write completed after the initial read: preserve its due marker.
    if ((receiptAt(current, receiptKey)?.receiptId || null) !== (receiptAt(observedRecord, receiptKey)?.receiptId || null)
      || current?.attemptId !== observedRecord?.attemptId || current?.state !== observedRecord?.state) return false;
    if (current?.state === 'sent') {
      const attempts = (Number(order.submissionReceiptAttempts) || 0) + 1;
      if (attempts >= SUBMISSION_RECEIPT_RETRY_LIMIT) {
        transaction.set(orderRef, { automationDueAt: null, submissionReceiptDueAt: null, submissionReceiptAttempts: attempts,
          submissionReceiptStatus: 'needs_review', submissionReceiptIssue: 'receipt_missing_or_invalid', submissionReceiptCheckedAt: nowMs }, { merge: true });
        return true;
      }
      const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 9));
      transaction.set(orderRef, { submissionReceiptDueAt: nowMs + delay, submissionReceiptAttempts: attempts,
        submissionReceiptStatus: 'pending', submissionReceiptIssue: 'receipt_missing_or_invalid', submissionReceiptCheckedAt: nowMs }, { merge: true });
    } else {
      transaction.set(orderRef, { automationDueAt: null, submissionReceiptDueAt: null, submissionReceiptAttempts: 0,
        submissionReceiptStatus: 'needs_review', submissionReceiptIssue: 'receipt_missing_or_invalid', submissionReceiptCheckedAt: nowMs }, { merge: true });
    }
    return true;
  });
}

/**
 * Reconcile one order only from a receipt whose attempt, round and material
 * hash still match the durable submission record. This function never sends.
 */
export async function reconcileSubmissionReceipt({ db, orderId, applyEvent, runEffect, nowMs = Date.now(), allowLegacyUpgrade = true } = {}) {
  if (!db || typeof applyEvent !== 'function') return { reconciled: false, reason: 'dependencies_missing' };
  const orderRef = orderRefFor(db, orderId);
  const [orderSnapshot, flowSnapshot] = await Promise.all([
    orderRef.get(), flowRefFor(db, orderId).get(),
  ]);
  const order = orderSnapshot.data() || {};
  const flow = flowSnapshot.data() || {};
  const submission = (await submissionRefFor(db, orderId).get()).data() || {};
  const latestRound = Object.keys(submission).filter(key => /^r\d+$/.test(key))
    .map(key => Number(key.slice(1))).filter(Number.isInteger).sort((a, b) => b - a)[0] || 1;
  const round = Number(flow.round) || latestRound;
  const record = submission[`r${round}`] || null;
  const receiptKey = ['candidate_handoff', 'submitted'].includes(flow.state) && record?.confirmationReceipts?.candidate
    ? 'candidate' : 'receipt';
  const dueAt = Number(order.submissionReceiptDueAt) || 0;
  if (dueAt && dueAt > nowMs) return { reconciled: false, pending: true, reason: 'not_due' };
  if (allowLegacyUpgrade && receiptKey === 'receipt' && record?.state === 'sent' && !record.receipt) {
    const proof = legacyProofFor(record, orderId, round, nowMs);
    if (proof) {
      await submissionGuard(db, orderId, round).markSent({ ...record, sent: record.sent || {} }, nowMs, proof);
      return reconcileSubmissionReceipt({ db, orderId, applyEvent, runEffect, nowMs, allowLegacyUpgrade: false });
    }
  }
  const receipt = receiptAt(record, receiptKey);
  if (!validReceiptFor(record, receipt, orderId, round)) {
    if (record?.state === 'sent') await deferInvalidReceipt({ db, orderId, round, receiptKey, observedRecord: record, nowMs });
    return { reconciled: false, reason: 'receipt_missing_or_invalid' };
  }
  if (receipt.observedAt > nowMs || (record.state !== 'sent' && receiptKey !== 'candidate')) {
    await setNextAttempt({ db, orderId, round, receiptId: receipt.receiptId, receiptKey, nowMs, reason: 'receipt_not_committed' });
    return { reconciled: false, pending: true, receiptVerified: true, reason: 'receipt_not_committed' };
  }

  let result = null;
  if (flow.state === 'submitting') {
    result = await applyEvent({
      db, orderId,
      event: { type: 'submit_succeeded', round, channel: record.channel, receiptId: receipt.receiptId },
      actor: 'submission-receipt-reconcile', runEffect, nowMs,
      patchFlow: () => ({ submittedVia: String(record.channel || '').slice(0, 40) }),
    });
  } else if (['owner_takeover', 'candidate_handoff'].includes(flow.state) && receipt.proofKind === 'owner_confirmation') {
    result = await applyEvent({
      db, orderId, event: { type: 'owner_submitted', round },
      actor: 'submission-receipt-reconcile', runEffect, nowMs,
      patchFlow: () => ({ submittedVia: String(record.channel || 'owner').slice(0, 40) }),
    });
  } else if (flow.state === 'candidate_handoff' && receipt.proofKind === 'candidate_confirmation') {
    result = await applyEvent({
      db, orderId, event: { type: 'candidate_confirmed_submitted', round },
      actor: 'submission-receipt-reconcile', runEffect, nowMs,
    });
  } else if (flow.state === 'owner_takeover' && (flow.heldBy || []).some(held => AMBIGUOUS_HOLDS.has(held))) {
    result = await applyEvent({
      db, orderId,
      event: { type: 'submit_acknowledged', round, receiptId: receipt.receiptId },
      actor: 'submission-receipt-reconcile', runEffect, nowMs,
      patchFlow: () => ({ submittedVia: String(record.channel || '').slice(0, 40) }),
    });
  } else if (flow.state === 'submitted' && runEffect) {
    // The flow event may already be durable while the effect that projects it
    // to the paid order lost its acknowledgement.
    result = await runEffect({ db, orderId, effect: { type: 'mark_submitted' }, flow, nowMs });
  } else if (order.submissionStatus === 'submitted') {
    await setNextAttempt({ db, orderId, round, receiptId: receipt.receiptId, receiptKey, nowMs, completed: true });
    return { reconciled: true, alreadySubmitted: true, receiptId: receipt.receiptId };
  } else {
    await setNextAttempt({ db, orderId, round, receiptId: receipt.receiptId, receiptKey, nowMs, reason: 'flow_not_reconcilable' });
    return { reconciled: false, pending: true, receiptVerified: true, reason: 'flow_not_reconcilable', receiptId: receipt.receiptId };
  }

  const latestOrder = (await orderRef.get()).data() || {};
  const completed = latestOrder.submissionStatus === 'submitted';
  await setNextAttempt({ db, orderId, round, receiptId: receipt.receiptId, receiptKey, nowMs, completed });
  return {
    reconciled: completed,
    pending: !completed,
    receiptVerified: true,
    ...(result?.ignored ? { reason: result.ignored } : {}),
    receiptId: receipt.receiptId,
  };
}
