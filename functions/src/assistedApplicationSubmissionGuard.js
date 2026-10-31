/**
 * Durable idempotency of the application's submission, per order and round
 * (`{order}/automation/submission`, field `r<round>`). The watchdog of the
 * flow re-dispatches a submit run that went silent; if the first run's send
 * went through and the run died before reporting, the retry must not send a
 * second application:
 *
 *   claim → 'claimed'       nothing sent yet for this round: go ahead
 *         → 'already_sent'  the retry returns the outcome on record
 *         → 'in_flight'     a previous run started a send whose outcome is
 *                           unknown: never re-sent (career-ops), the owner
 *                           takes over
 *   markSent  the send went through (before the evidence and the event), or
 *             the employer's e-mail later proved that an unconfirmed one did
 *             (`confirmedBy: 'acknowledgement'`)
 *   release   the send failed for certain: a later run may try again
 */

import { applicationPolicyAuthority } from './lib/assistedApplicationPolicyAuthority.js';
import { qualificationCounterContextHash } from './lib/qualificationCounterContext.js';
import { submissionEmployerAckProof, submissionEmailHandoff, submissionAttemptHash, submissionSlotHash, submissionDraftMaterialHash, submissionAttemptMaterialHash, submissionOwnerIntent, minimalSubmissionReceipt, isMinimalSubmissionReceipt } from './lib/submissionReceiptContract.js';
import { assistedApplicationRetained } from './lib/assistedApplicationRetentionPolicy.js';
import { roundWasSent } from './assistedApplicationFlow.js';
import { randomUUID, createHash } from 'node:crypto';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

function executionRecordOf(execution) {
  return { executionId: execution.id, executionGeneration: execution.lease.generation, executionSourceSha: execution.sourceSha,
    executionEngineVersion: execution.engineVersion, executionMaterialVersion: execution.materialVersion, executionRound: execution.round,
    executionTokenHash: createHash('sha256').update(execution.lease.token).digest('hex') };
}
function matchesExecutionRecord(record, execution) {
  return record && Object.entries(executionRecordOf(execution)).every(([key, value]) => record[key] === value);
}

export const SUBMISSION_DOC_ID = 'submission';

export function submissionRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('automation').doc(SUBMISSION_DOC_ID);
}

/**
 * The submission may have reached the employer, and nothing confirmed it: a
 * portal after its final click, or an e-mail whose send started (it is left
 * "sending" only when its outcome is unknown). Before the click nothing left.
 */
export function isUnconfirmedSubmission(record) {
  return record?.state === 'sending' && (Boolean(record.clickedAt) || record.channel === 'email');
}

/** When an unconfirmed submission left: the final click, or the start of the e-mail send. */
export function submissionLeftAt(record) {
  return Number(record?.clickedAt || record?.startedAt) || 0;
}

/** The existing automatic approval policy, with the owner's manual takeover exception. */
export function submissionFlowAllowsSend(flow, round, channel) {
  if (Number(flow?.round) !== Number(round)) return false;
  return channel === 'owner_extension' ? flow.state === 'owner_takeover'
    : ['portal', 'email'].includes(channel) && flow.state === 'submitting' && roundWasSent(flow, round);
}

/** AssistedApplicationUpload.tsx also stamps order.submittedAt when a CV is queued for this
 * service. That legacy field alone never proves delivery to the employer. */
export function hasRecordedSubmission({ order, flow, draft, submission = {} }) {
  return order?.submissionStatus === 'submitted' || flow?.state === 'submitted' || Boolean(flow?.submittedAt) || Boolean(draft?.sent)
    || Object.entries(submission || {}).some(([key, record]) => /^r\d+$/.test(key) && record?.state === 'sent')
    || (Array.isArray(flow?.history) ? flow.history : []).some(entry => entry?.state === 'submitted'
      && ['submit_succeeded', 'submit_acknowledged', 'owner_submitted'].includes(entry.event));
}

export function submissionGuard(db, orderId, round, { execution = null, answerSourceGuard = null, outcomeAuthority = null, receiptClock = execution?.clock || Date.now } = {}) {
  if (execution && outcomeAuthority) throw new Error('execution_outcome_actor_invalid');
  const ref = submissionRefFor(db, orderId);
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const flowRef = orderRef.collection('automation').doc('flow');
  const draftRef = orderRef.collection('ai_drafts').doc('current');
  const guardedRound = Number(round) || 1;
  const key = `r${guardedRound}`;
  let claimedAttemptId = null;
  const requireOwnClaim = (submission, channel) => {
    const current = submission?.[key];
    if (current?.state === 'sent') throw Object.assign(new Error('submission_already_sent'), { code: 'submission_already_sent', record: current });
    if (!claimedAttemptId || current?.state !== 'sending' || current.attemptId !== claimedAttemptId
      || !(Array.isArray(channel) ? channel : [channel]).includes(current.channel) || current.clickedAt) {
      throw Object.assign(new Error('submission_claim_changed'), { code: 'submission_claim_changed' });
    }
  };
  const requireCurrentMandate = (order, flow, nowMs) => {
    if (!applicationPolicyAuthority({ orderId: String(orderId), order, flow, nowMs })) {
      throw Object.assign(new Error('submission_mandate_changed'), { code: 'evidence_source_changed' });
    }
  };
  const armHandoff = async (transaction, submission, nowMs, currentAnswerSourceGuard, materialHashes) => {
    if (typeof currentAnswerSourceGuard?.assertInTransaction !== 'function') {
      throw Object.assign(new Error('evidence_source_changed'), { code: 'evidence_source_changed' });
    }
    const sourceFingerprint = currentAnswerSourceGuard.fingerprint;
    const current = submission[key];
    const attemptHash = submissionAttemptHash(claimedAttemptId);
    const proofRef = orderRef.collection('submission_receipts').doc(attemptHash);
    if ((await transaction.get(proofRef)).exists) {
      throw Object.assign(new Error('submission_claim_changed'), { code: 'submission_claim_changed' });
    }
    // The provider checks current source deadlines after its reads. Keep it
    // as the final await; no proof/document read may open another time gap.
    await currentAnswerSourceGuard.assertInTransaction(transaction);
    if (!/^[a-f0-9]{64}$/.test(sourceFingerprint || '') || currentAnswerSourceGuard.fingerprint !== sourceFingerprint) {
      throw Object.assign(new Error('evidence_source_changed'), { code: 'evidence_source_changed' });
    }
    return { ref: proofRef, frame: { attemptHash, round: guardedRound, channel: current.channel,
      claimArmedAt: current.startedAt, handoffAt: nowMs, sourceFingerprint, ...materialHashes } };
  };
  return {
    attemptBinding() { return claimedAttemptId ? { id: claimedAttemptId, round: guardedRound } : null; },
    async read() {
      return (await ref.get()).data()?.[key] || null;
    },
    /**
     * @param {{resumable?: boolean}} [options] a portal submission: a run that
     *   died BEFORE pressing submit (no clickedAt) left nothing at the
     *   employer, so it may start again; after the click it stays ambiguous
     */
    async claim(channel, nowMs = Date.now(), { resumable = false } = {}) {
      let outcome = null;
      const attemptId = randomUUID();
      await db.runTransaction(async (transaction) => {
        const [submissionDoc, orderDoc, flowDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef),
        ]);
        const submission = submissionDoc.data();
        if (submission?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          outcome = { status: 'withdrawn' };
          return;
        }
        const current = submission?.[key];
        if (current?.state === 'sent') {
          outcome = { status: 'already_sent', record: current };
          return;
        }
        if (current?.state === 'sending' && !(resumable && channel !== 'email' && current.channel !== 'email' && !current.clickedAt)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        if (execution && channel !== 'portal') throw new Error('execution_channel_unsupported');
        const context = execution ? await execution.assertInTransaction(transaction) : null;
        transaction.set(ref, { [key]: { state: 'sending', channel, attemptId, startedAt: nowMs, clickedAt: null,
          ...(context ? executionRecordOf(context.execution) : {}) } }, { merge: true });
        claimedAttemptId = attemptId;
        outcome = { status: 'claimed', resumed: current?.state === 'sending' };
      });
      return outcome;
    },
    /** No claim or repair may hide an application that already left. */
    async inspect() {
      return db.runTransaction(async transaction => {
        const [submissionDoc, orderDoc, flowDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef),
        ]);
        const submission = submissionDoc.data();
        const current = submission?.[key];
        if (current?.state === 'sent') return { status: 'already_sent', record: current };
        if (isUnconfirmedSubmission(current)) return { status: 'in_flight', record: current };
        if (submission?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') return { status: 'withdrawn' };
        return { status: 'available' };
      });
    },
    /** Immediately before SMTP/provider handoff; this is not a portal click. */
    async markEmailSending(nowMs = Date.now(), { answerSourceGuard: currentAnswerSourceGuard = answerSourceGuard, emailHandoff = null } = {}) {
      let emailSnapshot;
      try { emailSnapshot = submissionEmailHandoff(emailHandoff); } catch { emailSnapshot = null; }
      const markerStartedAt = Date.now();
      await db.runTransaction(async transaction => {
        const submissionDoc = await transaction.get(ref);
        requireOwnClaim(submissionDoc.data(), 'email');
        const [orderDoc, flowDoc, draftDoc] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef)]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') throw new Error('application_withdrawn');
        if (!assistedApplicationRetained(orderDoc.data(), nowMs)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        if (!submissionFlowAllowsSend(flowDoc.data(), guardedRound, 'email')) throw Object.assign(new Error('submission_approval_changed'), { code: 'submission_approval_changed' });
        requireCurrentMandate(orderDoc.data(), flowDoc.data(), nowMs);
        if (!emailSnapshot || emailSnapshot.slotHash !== submissionSlotHash({ orderId, order: orderDoc.data() })) throw Object.assign(new Error('submission_email_handoff_changed'), { code: 'evidence_source_changed' });
        const proof = await armHandoff(transaction, submissionDoc.data(), nowMs, currentAnswerSourceGuard, { slotHash: submissionSlotHash({ orderId, order: orderDoc.data() }),
          draftMaterialHash: submissionDraftMaterialHash(draftDoc.data()), attemptMaterialHash: submissionAttemptMaterialHash(draftDoc.data()) });
        const handoffAt = nowMs + Math.max(0, Date.now() - markerStartedAt);
        if (!assistedApplicationRetained(orderDoc.data(), handoffAt)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        requireCurrentMandate(orderDoc.data(), flowDoc.data(), handoffAt);
        let currentEmail; try { currentEmail = submissionEmailHandoff(emailHandoff); } catch { currentEmail = null; }
        if (JSON.stringify(currentEmail) !== JSON.stringify(emailSnapshot)) throw Object.assign(new Error('submission_email_handoff_changed'), { code: 'evidence_source_changed' });
        transaction.set(proof.ref, { ...proof.frame, handoffAt, emailHandoffHash: qualificationCounterContextHash(emailSnapshot) });
        transaction.set(ref, { [key]: { startedAt: handoffAt, emailHandoff: emailSnapshot } }, { merge: true });
      });
    },
    /** Right before a portal's final submit click: from here the outcome may be unknown. */
    async markClicked(nowMs = Date.now(), { answerSourceGuard: currentAnswerSourceGuard = answerSourceGuard, ownerIntent = null, receiptWaitMs = 60_000 } = {}) {
      let intentSnapshot;
      try { intentSnapshot = submissionOwnerIntent(ownerIntent); } catch { intentSnapshot = null; }
      const markerStartedAt = Date.now();
      const deadline = await db.runTransaction(async transaction => {
        // All proof dependencies are reread in the same transaction as the
        // irreversible-send marker, before any write or external send.
        const submissionDoc = await transaction.get(ref);
        requireOwnClaim(submissionDoc.data(), ['portal', 'owner_extension']);
        const executionContext = execution ? await execution.assertInTransaction(transaction) : null;
        if (executionContext && !matchesExecutionRecord(submissionDoc.data()?.[key], executionContext.execution)) throw new Error('execution_submission_superseded');
        if (executionContext && (!Number.isFinite(receiptWaitMs) || receiptWaitMs <= 0)) throw new Error('execution_receipt_wait_invalid');
        const [orderDoc, flowDoc, draftDoc] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef)]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          throw new Error('application_withdrawn');
        }
        if (!assistedApplicationRetained(orderDoc.data(), nowMs)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        if (!submissionFlowAllowsSend(flowDoc.data(), guardedRound, submissionDoc.data()?.[key]?.channel)) throw Object.assign(new Error('submission_approval_changed'), { code: 'submission_approval_changed' });
        requireCurrentMandate(orderDoc.data(), flowDoc.data(), nowMs);
        if (submissionDoc.data()?.[key]?.channel === 'owner_extension' && !intentSnapshot) throw Object.assign(new Error('submission_intent_changed'), { code: 'evidence_source_changed' });
        const proof = await armHandoff(transaction, submissionDoc.data(), nowMs, currentAnswerSourceGuard, { slotHash: submissionSlotHash({ orderId, order: orderDoc.data() }),
          draftMaterialHash: submissionDraftMaterialHash(draftDoc.data()), attemptMaterialHash: submissionAttemptMaterialHash(draftDoc.data()) });
        const handoffAt = nowMs + Math.max(0, Date.now() - markerStartedAt);
        if (!assistedApplicationRetained(orderDoc.data(), handoffAt)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        requireCurrentMandate(orderDoc.data(), flowDoc.data(), handoffAt);
        if (intentSnapshot) {
          let currentIntent; try { currentIntent = submissionOwnerIntent(ownerIntent); } catch { currentIntent = null; }
          if (JSON.stringify(currentIntent) !== JSON.stringify(intentSnapshot)) throw Object.assign(new Error('submission_intent_changed'), { code: 'evidence_source_changed' });
        }
        if (executionContext) {
          const clickNow = receiptClock();
          const actor = executionContext.execution;
          if (!Number.isFinite(clickNow) || !Number.isFinite(actor.lease?.expiresAt) || actor.lease.expiresAt <= clickNow
            || !Number.isFinite(actor.controller?.expiresAt) || actor.controller.expiresAt <= clickNow
            || !actor.controller.runId) throw new Error('execution_lease_lost');
        }
        const prior = executionContext?.execution.clickProof;
        if (prior && (!matchesExecutionRecord(prior, executionContext.execution)
          || prior.submissionAttemptHash !== proof.frame.attemptHash)) throw new Error('execution_click_superseded');
        const drainUntil = executionContext ? prior?.drainUntil || handoffAt + Math.min(90_000, receiptWaitMs) : null;
        transaction.set(proof.ref, { ...proof.frame, handoffAt, ...(intentSnapshot ? { ownerIntent: intentSnapshot } : {}) });
        transaction.set(ref, { [key]: { clickedAt: handoffAt } }, { merge: true });
        if (executionContext && !prior) transaction.set(orderRef.collection('automation').doc('execution'), { clickProof: {
          ...executionRecordOf(executionContext.execution), submissionAttemptHash: proof.frame.attemptHash, clickedAt: handoffAt, drainUntil,
        } }, { merge: true });
        return drainUntil;
      });
      return deadline;
    },
    async markSent(record = {}, observedAt = receiptClock()) {
      if (!Number.isFinite(observedAt) || observedAt <= 0 || typeof receiptClock !== 'function') throw new Error('submission_receipt_invalid');
      let receiptRecord;
      try { receiptRecord = structuredClone(record); } catch { throw new Error('submission_receipt_invalid'); }
      if (!receiptRecord || typeof receiptRecord !== 'object' || Array.isArray(receiptRecord)) throw new Error('submission_receipt_invalid');
      let authority;
      const ackKind = ['employer_ack', 'legacy_employer_ack'].includes(outcomeAuthority?.kind);
      const assertAckInTransaction = ackKind && typeof outcomeAuthority.assertInTransaction === 'function'
        ? outcomeAuthority.assertInTransaction.bind(outcomeAuthority) : null;
      try {
        const { assertInTransaction: _assert, ...snapshot } = outcomeAuthority || {};
        authority = outcomeAuthority == null ? null : structuredClone(snapshot);
      } catch { throw new Error('submission_receipt_authority_invalid'); }
      const ackProof = ackKind ? submissionEmployerAckProof(authority.proof) : null;
      if (ackKind && (!ackProof || !assertAckInTransaction || ackProof.orderId !== String(orderId)
        || ackProof.round !== guardedRound)) throw new Error('submission_receipt_authority_invalid');
      const intent = authority?.kind === 'owner_extension' ? submissionOwnerIntent(authority.ownerIntent) : null;
      if (authority?.kind === 'owner_extension' && !intent) throw new Error('submission_intent_changed');
      if (authority && !['owner_extension', 'employer_ack', 'legacy_employer_ack', 'manual_owner'].includes(authority.kind)) throw new Error('submission_receipt_authority_invalid');
      if (authority?.kind === 'manual_owner' && (typeof authority.actor !== 'string' || !authority.actor.trim())) throw new Error('submission_receipt_authority_invalid');
      return db.runTransaction(async transaction => {
        const executionContext = execution ? await execution.assertOutcomeInTransaction(transaction) : null;
        const [orderDoc, submissionDoc, draftDoc] = await Promise.all([
          transaction.get(orderRef), transaction.get(ref), transaction.get(draftRef),
        ]);
        if (!orderDoc.exists) throw new Error('submission_receipt_order_missing');
        const current = submissionDoc.data()?.[key];
        if (ackProof && authority.kind === 'legacy_employer_ack') {
          // Historical truth has no ARM/UUID/material photograph. It receives
          // its own content-free provenance and can never authorize a send.
          const bindingHash = qualificationCounterContextHash(ackProof);
          const receiptRef = orderRef.collection('submission_receipts').doc(bindingHash);
          const [receiptDoc, flowDoc] = await Promise.all([transaction.get(receiptRef), transaction.get(flowRef)]);
          const stored = receiptDoc.data();
          if (receiptDoc.exists && (stored.kind !== 'legacy_employer_ack' || stored.bindingHash !== bindingHash
            || stored.round !== guardedRound || stored.slotHash !== ackProof.slotHash || stored.recordHash !== ackProof.recordHash
            || stored.leftAt !== ackProof.leftAt || stored.providerReceivedAt !== ackProof.providerReceivedAt || !isMinimalSubmissionReceipt(stored.minimalReceipt, bindingHash, guardedRound))) throw new Error('legacy_ack_authority_changed');
          if (current?.state === 'sent') {
            // SENT wins over a new claim. An unbound historical SENT is not
            // silently upgraded into a new verified source or photograph.
            const retained = assistedApplicationRetained(orderDoc.data(), receiptClock());
            return { minimal: !retained || !stored || current.receiptBindingHash !== bindingHash || current.originalRecordHash !== ackProof.recordHash, alreadySent: true,
              ...(retained && stored && current.receiptBindingHash === bindingHash && current.originalRecordHash === ackProof.recordHash ? { record: current } : {}), receipt: stored?.minimalReceipt || null };
          }
          if (!current && stored) return { minimal: true, receipt: stored.minimalReceipt };
          if (current?.state !== 'sending' || Object.hasOwn(current, 'attemptId')
            || current.channel !== ackProof.channel || !isUnconfirmedSubmission(current)
            || submissionLeftAt(current) !== ackProof.leftAt
            || Number(flowDoc.data()?.round) !== guardedRound
            || qualificationCounterContextHash(current) !== ackProof.recordHash
            || submissionSlotHash({ orderId, order: orderDoc.data() }) !== ackProof.slotHash) throw new Error('legacy_ack_authority_changed');
          const asserted = submissionEmployerAckProof(await assertAckInTransaction(transaction));
          if (!asserted || qualificationCounterContextHash(asserted) !== bindingHash) throw new Error('legacy_ack_authority_changed');
          const currentNow = receiptClock();
          if (!Number.isFinite(currentNow) || ackProof.providerReceivedAt > currentNow) throw new Error('legacy_ack_authority_changed');
          const legacyRecord = { channel: ackProof.channel, confirmedBy: 'acknowledgement',
            confirmedAt: ackProof.providerReceivedAt, provenance: 'legacy_employer_ack',
            receiptBindingHash: bindingHash, originalRecordHash: ackProof.recordHash };
          const minimum = stored?.minimalReceipt || minimalSubmissionReceipt({ record: legacyRecord,
            attemptHash: bindingHash, round: guardedRound, at: ackProof.providerReceivedAt });
          transaction.set(receiptRef, { kind: 'legacy_employer_ack', bindingHash, round: guardedRound, slotHash: ackProof.slotHash, recordHash: ackProof.recordHash,
            leftAt: ackProof.leftAt, providerReceivedAt: ackProof.providerReceivedAt, minimalReceipt: minimum }, { merge: true });
          if (!assistedApplicationRetained(orderDoc.data(), currentNow)) return { minimal: true, receipt: minimum };
          transaction.set(ref, { [key]: { ...legacyRecord, state: 'sent', sentAt: ackProof.leftAt } }, { merge: true });
          return { minimal: false, receipt: minimum };
        }
        let id = claimedAttemptId || (authority?.kind === 'employer_ack' ? authority.attemptId : null);
        if (authority?.kind === 'manual_owner' && !id) id = current?.attemptId || null;
        let proofRef; let frame;
        if (intent) {
          // The ledger is deleted by purge; the original intent still locates
          // exactly one immutable frame, without accepting a client attempt ID.
          const matches = await transaction.get(orderRef.collection('submission_receipts')
            .where('ownerIntent.idHash', '==', intent.idHash).limit(2));
          if (matches.docs.length !== 1) throw new Error('submission_intent_changed');
          proofRef = matches.docs[0].ref; frame = matches.docs[0].data();
          if (JSON.stringify(submissionOwnerIntent(frame.ownerIntent)) !== JSON.stringify(intent)
            || frame.channel !== 'owner_extension') throw new Error('submission_intent_changed');
        } else if (id) {
          proofRef = orderRef.collection('submission_receipts').doc(submissionAttemptHash(id));
          frame = (await transaction.get(proofRef)).data();
        } else if (authority?.kind === 'manual_owner') {
          // Explicit authenticated human truth is distinct from automatic
          // admission. Its unbound receipt never grants automatic healing.
          proofRef = orderRef.collection('submission_receipts').doc(submissionAttemptHash(`manual-owner-receipt:${guardedRound}`));
          frame = (await transaction.get(proofRef)).data();
        } else throw new Error('submission_receipt_unbound');
        const manual = authority?.kind === 'manual_owner' && !frame;
        const attemptHash = proofRef.id;
        const unboundManual = manual || frame?.kind === 'manual_owner_assertion';
        if (unboundManual && (authority?.kind !== 'manual_owner'
          || (frame && (frame.attemptHash !== attemptHash || frame.round !== guardedRound)))) throw new Error('submission_receipt_unbound');
        if (!unboundManual && (!frame || frame.attemptHash !== attemptHash || frame.round !== guardedRound
          || !['portal', 'email', 'owner_extension'].includes(frame.channel)
          || !['sourceFingerprint', 'slotHash', 'draftMaterialHash', 'attemptMaterialHash'].every(field => /^[a-f0-9]{64}$/.test(frame[field] || ''))
          || !Number.isFinite(frame.claimArmedAt) || frame.claimArmedAt <= 0
          || !Number.isFinite(frame.handoffAt) || frame.handoffAt <= 0)) throw new Error('submission_receipt_unbound');
        if (!unboundManual && current?.attemptId && submissionAttemptHash(current.attemptId) !== attemptHash) throw new Error('submission_claim_changed');
        if (!id && current?.attemptId && submissionAttemptHash(current.attemptId) === attemptHash) id = current.attemptId;
        if (!unboundManual && current && frame.channel !== 'email' && (!current.clickedAt || Number(current.clickedAt) !== frame.handoffAt)) throw new Error('submission_receipt_unbound');
        if (authority?.kind === 'employer_ack' && Number(authority.leftAt) !== frame?.handoffAt) throw new Error('submission_receipt_unbound');
        if (ackProof && !current && isMinimalSubmissionReceipt(frame.minimalReceipt, attemptHash, guardedRound)) return { minimal: true, receipt: frame.minimalReceipt };
        if (ackProof && current?.state === 'sent' && isMinimalSubmissionReceipt(frame.minimalReceipt, attemptHash, guardedRound)) {
          const retained = assistedApplicationRetained(orderDoc.data(), receiptClock());
          return { minimal: !retained, alreadySent: true, ...(retained ? { record: current } : {}), receipt: frame.minimalReceipt };
        }
        if (ackProof) {
          const email = submissionEmailHandoff(current?.emailHandoff);
          if (!email || frame.channel !== 'email' || frame.emailHandoffHash !== qualificationCounterContextHash(email)
            || ackProof.channel !== 'email' || ackProof.leftAt !== frame.handoffAt
            || ackProof.slotHash !== frame.slotHash
            || (current?.state !== 'sent' && qualificationCounterContextHash(current) !== ackProof.recordHash)) throw new Error('submission_receipt_authority_invalid');
          const asserted = submissionEmployerAckProof(await assertAckInTransaction(transaction));
          if (!asserted || qualificationCounterContextHash(asserted) !== qualificationCounterContextHash(ackProof)) throw new Error('submission_receipt_authority_invalid');
          receiptRecord = { ...receiptRecord, confirmedBy: 'acknowledgement', confirmedAt: ackProof.providerReceivedAt };
        }
        if (executionContext) {
          const clickProof = executionContext.execution.clickProof;
          if (!matchesExecutionRecord(clickProof, executionContext.execution) || !clickProof.clickedAt
            || clickProof.submissionAttemptHash !== attemptHash || clickProof.executionRound !== guardedRound
            || (current && (!matchesExecutionRecord(current, executionContext.execution) || !current.clickedAt))) throw new Error('execution_receipt_unproven');
        }
        const photo = draftDoc.data()?.sentAttempt;
        if (!receiptRecord.sent && photo && !unboundManual && frame.attemptMaterialHash === submissionAttemptMaterialHash(draftDoc.data())
          && submissionAttemptHash(photo.submissionAttempt?.id || '') === attemptHash && Number(photo.submissionAttempt?.round) === guardedRound) {
          receiptRecord = { ...receiptRecord, sent: { ...photo,
            ...(receiptRecord.confirmedBy ? { confirmedBy: receiptRecord.confirmedBy, confirmedAt: receiptRecord.confirmedAt || observedAt } : {}) } };
        }
        const minimum = frame?.minimalReceipt || minimalSubmissionReceipt({ record: receiptRecord, attemptHash, round: guardedRound, at: ackProof?.providerReceivedAt ?? observedAt });
        if (!isMinimalSubmissionReceipt(minimum, attemptHash, guardedRound)) throw new Error('submission_receipt_unbound');
        // The observed timestamp is not a retention clock. Re-read the private
        // clock after the final await; no eligibility/QA gate follows a send.
        const currentNow = receiptClock();
        if (!Number.isFinite(currentNow) || (ackProof && ackProof.providerReceivedAt > currentNow)) throw new Error('submission_receipt_clock_unknown');
        let executionMinimum = null;
        if (executionContext) {
          const tokenHash = executionContext.execution.clickProof.executionTokenHash;
          executionMinimum = executionContext.execution.minimalReceipt || { ...minimum, attempt: tokenHash };
          if (!isMinimalSubmissionReceipt(executionMinimum, tokenHash, guardedRound) || executionMinimum.hash !== minimum.hash) throw new Error('execution_receipt_superseded');
        }
        transaction.set(proofRef, { ...(manual ? { kind: 'manual_owner_assertion', attemptHash, round: guardedRound } : {}),
          minimalReceipt: minimum }, { merge: true });
        if (executionMinimum) transaction.set(orderRef.collection('automation').doc('execution'), { minimalReceipt: executionMinimum }, { merge: true });
        if (!assistedApplicationRetained(orderDoc.data(), currentNow)) return { minimal: true, receipt: minimum };
        if (current?.state === 'sent') return { minimal: false, alreadySent: true, record: current, receipt: minimum };
        if (!unboundManual && (!current || submissionAttemptHash(current.attemptId || '') !== attemptHash)) return { minimal: true, receipt: minimum };
        transaction.set(ref, { [key]: { ...receiptRecord, state: 'sent', sentAt: ackProof?.leftAt ?? observedAt,
          attemptId: id || null, ...(unboundManual ? { provenance: 'manual_owner_assertion' } : {}),
          ...(frame?.channel ? { channel: frame.channel } : {}) } }, { merge: true });
        return { minimal: false, receipt: minimum };
      });
    },
    /** Cleanup is CAS-protected too: a newer claim/receipt keeps its dossier. */
    async clearReleasedAttempt() {
      return db.runTransaction(async transaction => {
        const [submissionDoc, draftDoc, flowDoc] = await Promise.all([transaction.get(ref), transaction.get(draftRef), transaction.get(flowRef)]);
        const current = submissionDoc.data()?.[key];
        if (!claimedAttemptId || current?.state !== 'failed' || current.attemptId !== claimedAttemptId) return false;
        const draft = draftDoc.data();
        if (!draft) return true;
        if (Number(draft.round) !== guardedRound || Number(flowDoc.data()?.round) !== guardedRound) return false;
        if (!draft.sentAttempt) return true;
        if (draft.sentAttempt.submissionAttempt?.id !== claimedAttemptId
          || Number(draft.sentAttempt.submissionAttempt?.round) !== guardedRound) return false;
        transaction.set(draftRef, { sentAttempt: null }, { merge: true });
        return true;
      });
    },
    async release(reason, nowMs = Date.now()) {
      return db.runTransaction(async transaction => {
        const current = (await transaction.get(ref)).data()?.[key];
        if (!claimedAttemptId || current?.state !== 'sending' || current.attemptId !== claimedAttemptId) return false;
        if (execution) {
          const context = await execution.assertInTransaction(transaction);
          if (!matchesExecutionRecord(current, context.execution)) throw new Error('execution_submission_superseded');
          if (current.clickedAt && !['portal_refused', 'portal_validation'].includes(reason)) throw new Error('execution_ambiguous_release_forbidden');
        }
        transaction.set(ref, { [key]: { state: 'failed', reason: String(reason || '').slice(0, 120), releasedAt: nowMs } }, { merge: true });
        return true;
      });
    },
  };
}

/** Outcome only: the authenticated owner extension supplies its original captured intent. */
export async function adoptConfirmedOwnerIntentReceipt({ db, orderId, round, ownerIntent, record, nowMs = Date.now(), receiptClock = Date.now }) {
  const guardedRound = Number(round);
  if (!Number.isInteger(guardedRound) || guardedRound < 1 || guardedRound > 20) throw new Error("submission_receipt_invalid_round");
  return submissionGuard(db, orderId, guardedRound, { outcomeAuthority: { kind: "owner_extension", ownerIntent }, receiptClock }).markSent(record, nowMs);
}
