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
 *   release   the send failed for certain: writes `confirmedNotSent`, keeps
 *             click evidence, and lets a later run try again
 */

import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

export const SUBMISSION_DOC_ID = 'submission';

// Account failures are deliberately a closed, retention-safe vocabulary. The
// runner may report only these two fields: no portal text, locator, URL,
// credential or candidate answer crosses the event boundary.
export const ACCOUNT_FAILURE_CODES = Object.freeze([
  'no_create_button',
  'no_sign_in_button',
  'login_unobserved',
  'create_unanswered',
  'create_refused',
  'locator_control_error',
  'verification_timeout',
  'verification_unobserved',
  'verification_rejected',
  'auth_steps_exhausted',
  'unknown',
]);
export const ACCOUNT_FAILURE_STAGES = Object.freeze(['login', 'registration', 'verification', 'application', 'unknown']);
const ACCOUNT_FAILURE_FIELDS = Object.freeze(['code', 'stage']);

/** Serialize only the finite admin/read-only account diagnostic shape. */
export function serializeAccountFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ACCOUNT_FAILURE_FIELDS.length || keys.some(key => !ACCOUNT_FAILURE_FIELDS.includes(key))) return null;
  if (!ACCOUNT_FAILURE_CODES.includes(value.code) || !ACCOUNT_FAILURE_STAGES.includes(value.stage)) return null;
  return { code: value.code, stage: value.stage };
}

/** Read a stored diagnostic without exposing or accepting any extra fields. */
export function getAccountFailure(record) {
  return serializeAccountFailure(record?.accountFailure);
}

export function submissionRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('automation').doc(SUBMISSION_DOC_ID);
}

/**
 * The submission may have reached the employer, and nothing confirmed it: a
 * portal after its final click, or an e-mail whose send started. A durable
 * release records the separate proof that the employer did not receive it.
 */
export function isUnconfirmedSubmission(record) {
  if (record?.state === 'failed' && record.confirmedNotSent === true) return false;
  return record?.state !== 'sent' && (Boolean(record?.clickedAt) || (record?.state === 'sending' && record.channel === 'email'));
}

/** When an unconfirmed submission left: the final click, or the start of the e-mail send. */
export function submissionLeftAt(record) {
  return Number(record?.clickedAt || record?.startedAt) || 0;
}

export function submissionGuard(db, orderId, round) {
  const ref = submissionRefFor(db, orderId);
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const flowRef = orderRef.collection('automation').doc('flow');
  const key = `r${Number(round) || 1}`;
  return {
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
      await db.runTransaction(async (transaction) => {
        const [submissionDoc, orderDoc, flowDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef),
        ]);
        const submission = submissionDoc.data();
        if (submission?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          outcome = { status: 'withdrawn' };
          return;
        }
        let current = submission?.[key];
        if (current?.state === 'sent') {
          outcome = { status: 'already_sent', record: current };
          return;
        }
        // Before confirmedNotSent was persisted, release() already meant that
        // a portal failure was proven before the next retry. Migrate only that
        // narrow legacy shape: an explicit portal failure with click evidence
        // and no field at all. A current `confirmedNotSent: false` remains an
        // unknown outcome and must stay locked.
        const legacyReleasedPortal = current?.state === 'failed'
          && current.channel === 'portal'
          && Number(current.clickedAt) > 0
          && !Object.prototype.hasOwnProperty.call(current, 'confirmedNotSent');
        if (legacyReleasedPortal) {
          transaction.set(ref, { [key]: { confirmedNotSent: true } }, { merge: true });
          current = { ...current, confirmedNotSent: true };
        }
        // Keep click evidence, but allow a retry only when release() also
        // recorded a definitive no-send outcome. An unconfirmed click stays locked.
        if (isUnconfirmedSubmission(current)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        if (current?.state === 'sending' && !(resumable && !current.clickedAt)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        transaction.set(ref, { [key]: { state: 'sending', channel, startedAt: nowMs, clickedAt: null, confirmedNotSent: false } }, { merge: true });
        outcome = { status: 'claimed', resumed: current?.state === 'sending' };
      });
      return outcome;
    },
    /** Right before a portal's final submit click: from here the outcome may be unknown. */
    async markClicked(nowMs = Date.now()) {
      await db.runTransaction(async transaction => {
        const [submissionDoc, orderDoc, flowDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef),
        ]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          throw new Error('application_withdrawn');
        }
        transaction.set(ref, { [key]: { clickedAt: nowMs } }, { merge: true });
      });
    },
    async markSent(record = {}, nowMs = Date.now()) {
      await ref.set({ [key]: { state: 'sent', sentAt: nowMs, ...record } }, { merge: true });
    },
    async release(reason, nowMs = Date.now(), metadata = {}) {
      const failure = Object.prototype.hasOwnProperty.call(metadata || {}, 'accountFailure')
        ? serializeAccountFailure(metadata.accountFailure)
        : undefined;
      const record = {
        state: 'failed', reason: String(reason || '').slice(0, 120), releasedAt: nowMs,
        confirmedNotSent: true,
      };
      if (failure) record.accountFailure = failure;
      await ref.set({ [key]: record }, { merge: true });
    },
  };
}
