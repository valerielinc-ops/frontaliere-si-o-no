/**
 * Side effects of the automated assisted-application flow.
 *
 * `runAutomationEffect` is the `runEffect` callback that
 * assistedApplicationAutomation.js calls after each committed transition:
 *   - email          one keyed message (sent at most once per key and round);
 *   - dispatch       the GitHub Actions agent (draft or submit);
 *   - mark_submitted the order moves to `submitted` (the existing concierge
 *                    trigger then sends the customer's "inviata" e-mail);
 *   - refund         the ad closed before sending (the one refund the welcome
 *                    e-mail promises when automation is on).
 */

import { FieldValue } from 'firebase-admin/firestore';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { dispatchAgentWorkflow, draftRefFor, orderRefFor } from './assistedApplicationAutomation.js';
import { buildCandidateAutomationEmail, buildOwnerAutomationEmail } from './assistedApplicationAutomationEmails.js';
import {
  buildReviewPageUrl,
  customerEmailFor,
  resolveOrderLocale,
  sendOrderNotification,
} from './assistedApplicationNotifications.js';
import { getReviewTokenSecret, mintReviewToken } from './assistedApplicationReviewToken.js';
import { openRequiredDocuments } from './assistedApplicationExtraDocuments.js';

const SUBMITTABLE_STATUSES = new Set(['awaiting_upload', 'ready_for_manual_submission', 'in_progress']);
const VERDICT_LABELS = { strong: 'forte', good: 'buono', weak: 'debole', poor: 'scarso' };

function formatPrice(order, locale) {
  const amount = Number(order?.amountTotal);
  const cents = Number.isFinite(amount) ? amount : 99;
  try {
    return new Intl.NumberFormat({ it: 'it-IT', de: 'de-DE', fr: 'fr-FR', en: 'en-IE' }[locale] || 'it-IT', {
      style: 'currency',
      currency: String(order?.currency || 'eur').toUpperCase(),
    }).format(cents / 100);
  } catch {
    return '0,99 €';
  }
}

async function reviewUrlFor(order, orderId, round, locale, deps) {
  const secret = await (deps.getSecret || getReviewTokenSecret)();
  return buildReviewPageUrl(order, mintReviewToken({ secret, orderId, round }), locale);
}

/** Notification key: one message per kind, round and (for reasons) cause. */
export function automationEmailKey(effect, flow) {
  const round = Number(flow?.round) || 1;
  if (effect.kind === 'owner_review') return `auto_owner_review_r${round}${effect.held ? '_held' : ''}`;
  if (effect.kind === 'owner_takeover') {
    // A known code names the message; a raw runner error only its step.
    const reason = String(effect.reason || 'x');
    const code = /^[a-z_]{1,40}$/.test(reason) ? reason : `${effect.stage || 'run'}_error`;
    return `auto_owner_takeover_${code}_r${round}`;
  }
  if (effect.kind === 'candidate_action_needed') return `auto_candidate_action_${(flow?.history || []).length}`;
  // One per wait for the candidate's answers (a wait may come back in the same round, at the portal).
  if (effect.kind === 'candidate_questions_reminder') return `auto_candidate_questions_reminder_${effect.since}_n${effect.nudge}`;
  if (effect.kind === 'owner_candidate_silent') return `auto_owner_candidate_silent_${effect.since}`;
  if (effect.kind === 'candidate_handoff' || effect.kind === 'candidate_handoff_reminder' || effect.kind === 'candidate_posting_closed') {
    return `auto_${effect.kind}`;
  }
  return `auto_${effect.kind}_r${round}${effect.held ? '_held' : ''}`;
}

async function sendAutomationEmail({ db, orderId, effect, flow, nowMs, deps }) {
  const draftSnapshot = await draftRefFor(db, orderId).get();
  const draft = draftSnapshot.exists ? draftSnapshot.data() || {} : {};
  const key = automationEmailKey(effect, flow);
  const isOwner = effect.kind.startsWith('owner_');
  // Build inside sendOrderNotification's claim (it hands us the fresh order).
  let reviewUrl = '';
  if (!isOwner && effect.kind !== 'candidate_posting_closed') {
    const snapshot = await orderRefFor(db, orderId).get();
    const order = snapshot.data() || {};
    reviewUrl = await reviewUrlFor(order, orderId, flow.round || 1, resolveOrderLocale(order), deps);
  }
  // Open questions and the required documents still missing (school reports, test results…).
  const openQuestions = (draft.questions || []).filter((question) => question.required
    && !String(flow.answers?.[question.id] ?? '').trim()).length
    + openRequiredDocuments(draft, flow.documents || {}).length;
  const build = (order) => {
    const locale = resolveOrderLocale(order);
    const common = {
      job: draft.job?.title || order.jobTitle,
      company: order.companyName,
      orderId: String(orderId),
    };
    if (isOwner) {
      return buildOwnerAutomationEmail(effect.kind, {
        ...common,
        deadlineAt: flow.deadlineAt,
        flags: effect.flags || [],
        reason: effect.reason,
        stage: effect.stage,
        attempts: effect.attempts,
        verdict: VERDICT_LABELS[draft.verdict] || draft.verdict,
        summary: draft.summaryIt,
        channel: draft.channel?.label,
        candidateEmail: customerEmailFor(order),
        days: effect.days,
        nudges: effect.nudges,
      });
    }
    return buildCandidateAutomationEmail(effect.kind, {
      ...common,
      locale,
      name: order.applicantName,
      jobUrl: order.jobUrl,
      reviewUrl,
      deadlineAt: flow.deadlineAt,
      held: Boolean(effect.held),
      openQuestions,
      reason: effect.reason || flow.heldBy?.[0],
      price: formatPrice(order, locale),
    });
  };
  return (deps.sendNotification || sendOrderNotification)({
    db,
    orderId,
    key,
    build,
    audience: isOwner ? 'owner' : 'customer',
    meta: { round: flow.round || 1 },
    nowMs,
  });
}

async function markSubmitted({ db, orderId, effect, flow }) {
  const orderRef = orderRefFor(db, orderId);
  const via = effect.by === 'candidate' ? 'il candidato dal portale (handoff)'
    : effect.by === 'owner' ? 'Valerie sul portale, dopo lo stop del robot'
      : `automazione (${flow.submittedVia || 'invio'})`;
  const notes = `Candidatura inviata da ${via}.`;
  let changed = false;
  await db.runTransaction(async (transaction) => {
    changed = false; // reset on every retry of the transaction
    const snapshot = await transaction.get(orderRef);
    const order = snapshot.data() || {};
    if (!SUBMITTABLE_STATUSES.has(order.submissionStatus)) return;
    const timestamp = FieldValue.serverTimestamp();
    transaction.set(orderRef, {
      submissionStatus: 'submitted',
      submittedAt: timestamp,
      statusChangedAt: timestamp,
      updatedAt: timestamp,
      submissionNotes: notes,
    }, { merge: true });
    transaction.set(orderRef.collection('events').doc(), buildAssistedApplicationEvent('manual_submission_completed', {
      actorEmail: 'automation',
      fromStatus: order.submissionStatus,
      toStatus: 'submitted',
      submissionNotes: notes,
      channel: flow.submittedVia || (effect.by === 'candidate' ? 'handoff' : effect.by === 'owner' ? 'owner' : 'automation'),
    }));
    changed = true;
  });
  return { ok: true, changed };
}

export const REFUND_MAX_ATTEMPTS = 5;
const REFUND_RETRY_MS = 15 * 60 * 1000;
// A refusal that no retry can change: Valerie is told at once.
const REFUND_PERMANENT_ERRORS = new Set(['payment_not_refundable', 'already_submitted', 'payment_reference_missing', 'order_not_found']);

/**
 * The automatic refund of a closed ad. The candidate's "we refunded you"
 * e-mail (effect.notify) leaves only after the refund went through; a failed
 * refund is retried by the sweep (order.automationRefundDueAt), and after the
 * last attempt, or at once for a permanent refusal, Valerie is alerted.
 */
async function refund({ db, orderId, effect, flow, nowMs, deps }) {
  const issue = deps.issueRefund || (await import('./assistedApplicationAdminCore.js')).issueAssistedApplicationRefund;
  const orderRef = orderRefFor(db, orderId);
  const previous = (await orderRef.get()).data()?.automationRefund || {};
  try {
    const result = await issue(db, { orderId, submissionNotes: `Rimborso automatico: ${effect.reason || 'annuncio chiuso'} prima dell'invio.` }, 'automation');
    await orderRef.set({ automationRefund: { ...previous, status: 'refunded', refundedAt: nowMs }, automationRefundDueAt: null }, { merge: true });
    const notified = effect.notify
      ? await sendAutomationEmail({ db, orderId, effect: { type: 'email', kind: effect.notify }, flow, nowMs, deps })
      : null;
    return { ok: true, refund: result?.body || result || null, notified };
  } catch (error) {
    const code = error?.code || (error instanceof Error ? error.message : String(error));
    const attempts = Number(previous.attempts || 0) + 1;
    const final = attempts >= REFUND_MAX_ATTEMPTS || REFUND_PERMANENT_ERRORS.has(code);
    const dueAt = final ? null : nowMs + REFUND_RETRY_MS * attempts;
    await orderRef.set({
      automationRefund: { reason: effect.reason || 'posting_closed', notify: effect.notify || null, attempts, lastError: String(code).slice(0, 120), status: final ? 'failed' : 'retrying', dueAt },
      automationRefundDueAt: dueAt,
    }, { merge: true });
    if (final) {
      await sendAutomationEmail({ db, orderId, effect: { type: 'email', kind: 'owner_takeover', reason: 'refund_failed' }, flow, nowMs, deps });
    }
    return { ok: false, error: String(code).slice(0, 120), attempts, retryAt: dueAt };
  }
}

/**
 * @param {{db, orderId:string, effect:object, flow:object, nowMs:number}} context
 * @param {object} [deps] test seams: dispatch, sendNotification, getSecret, issueRefund
 */
export async function runAutomationEffect(context, deps = {}) {
  const { db, orderId, effect, flow } = context;
  switch (effect.type) {
    case 'dispatch':
      return (deps.dispatch || dispatchAgentWorkflow)({ orderId, mode: effect.mode, round: flow.round || 1 });
    case 'email':
      return sendAutomationEmail({ ...context, deps });
    case 'mark_submitted':
      return markSubmitted({ db, orderId, effect, flow });
    case 'refund':
      return refund({ db, orderId, effect, flow, nowMs: context.nowMs || Date.now(), deps });
    default:
      throw new Error(`unknown_effect:${effect.type}`);
  }
}
