/**
 * The follow-up sweep (rules in assistedApplicationFollowup.js):
 *
 *   scheduled ──due──▶ Codex drafts follow-up n ──▶ awaiting_candidate
 *        (the candidate gets it; it leaves at the deadline, 12 h, or on "send")
 *   awaiting_candidate ──deadline / "send"──▶ sending ──▶ sent n
 *        ──▶ scheduled (day 14) | done (after the 2nd)
 *   any ──employer replied / "stop" / not sendable──▶ stopped
 *
 * A send is claimed in a transaction (awaiting_candidate → sending), so the
 * candidate's click and the sweep can never send the same follow-up twice;
 * a send whose outcome is unknown is never retried (career-ops).
 */

import { candidateIdentity, checkDraftFacts } from './assistedApplicationAiDraftCore.js';
import { draftRefFor, isAutomationEnabled, orderRefFor } from './assistedApplicationAutomation.js';
import { buildCandidateAutomationEmail } from './assistedApplicationAutomationEmails.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { EMPLOYER_MAIL_FROM, senderName, textToHtml, replySubject } from './assistedApplicationEmployerMail.js';
import {
  DAY_MS,
  FOLLOWUP_REVIEW_MS,
  FOLLOWUP_SCHEMA,
  MAX_FOLLOWUPS,
  employerReplied,
  followupDueAt,
  followupRefFor,
  followupSystemPrompt,
  followupUserText,
  sanitizeFollowup,
} from './assistedApplicationFollowup.js';
import { ASSISTED_APPLICATION_SENDER, buildReviewPageUrl, customerEmailFor, resolveOrderLocale } from './assistedApplicationNotifications.js';
import { getReviewTokenSecret, mintReviewToken } from './assistedApplicationReviewToken.js';

const SENDING_STALE_MS = 30 * 60 * 1000;
const MAX_SEND_ATTEMPTS = 2;
const INTL = { it: 'it-CH', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };

function formatAppliedOn(ms, language) {
  try {
    return new Intl.DateTimeFormat(INTL[language] || 'it-CH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Zurich' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

async function loadContext(db, orderId, sinceMs = 0) {
  const [orderSnapshot, followupSnapshot, draftSnapshot] = await Promise.all([
    orderRefFor(db, orderId).get(),
    followupRefFor(db, orderId).get(),
    draftRefFor(db, orderId).get(),
  ]);
  const followup = followupSnapshot.exists ? followupSnapshot.data() || null : null;
  const inboxSnapshot = await orderRefFor(db, orderId).collection('inbox').where('receivedAt', '>=', Number(followup?.submittedAt ?? sinceMs)).get();
  return {
    order: orderSnapshot.data() || {},
    followup,
    draft: draftSnapshot.exists ? draftSnapshot.data() || {} : {},
    inbox: (inboxSnapshot.docs || []).map((doc) => doc.data() || {}),
  };
}

async function update(db, orderId, followup, patch, event, nowMs, dueAt = null) {
  const history = [...(followup.history || []), { at: nowMs, ...event }].slice(-20);
  await followupRefFor(db, orderId).set({ ...patch, history }, { merge: true });
  await orderRefFor(db, orderId).set({ followupDueAt: dueAt }, { merge: true });
}

async function stop(db, orderId, followup, reason, nowMs) {
  await update(db, orderId, followup, { state: 'stopped', stopReason: reason, dueAt: null }, { event: 'stopped', reason }, nowMs, null);
  return { ok: true, stopped: reason };
}

/** Codex drafts follow-up n; the candidate gets it with the 12-hour clock. */
async function draftFollowup({ db, orderId, context, nowMs, codex, sendCascade, getSecret }) {
  const { order, followup, draft } = context;
  const n = Number(followup.sent || 0) + 1;
  const language = draft.language || 'it';
  const appliedOn = formatAppliedOn(followup.submittedAt, language);
  const days = Math.max(1, Math.round((nowMs - followup.submittedAt) / DAY_MS));
  const previous = [...(followup.history || [])].reverse().find((item) => item.event === 'sent')?.body || null;
  const raw = await codex({
    systemPrompt: followupSystemPrompt(language, n),
    userText: followupUserText({
      companyName: order.companyName,
      roleTitle: draft.job?.title || order.jobTitle,
      contactPerson: draft.contactPerson,
      appliedOn,
      days,
      application: { subject: followup.subject, body: draft.applicationEmail?.body || '' },
      previousFollowup: previous,
      evidence: (draft.matches || []).filter((item) => item.status === 'met' && item.evidence).slice(0, 4).map((item) => item.evidence),
      postingExcerpt: draft.factSources?.posting || '',
    }),
    schema: FOLLOWUP_SCHEMA,
    name: 'followup',
    timeoutMs: 420_000,
  });
  const { body, violations } = sanitizeFollowup(raw, { n });
  // The date and the day count the model was given are facts too.
  const facts = checkDraftFacts({ followup: body }, { ...draft.factSources, order: `${draft.factSources?.order || ''}\n${appliedOn}\n${days}` });
  const pending = { n, body, subject: replySubject(followup.subject), createdAt: nowMs, deadlineAt: nowMs + FOLLOWUP_REVIEW_MS, attempts: 0 };
  if (violations.length || !facts.ok) {
    // Not sendable as written: kept for the owner queue, never sent.
    await update(db, orderId, followup, { state: 'stopped', stopReason: violations[0] || 'fact_check', pending, dueAt: null }, { event: 'held', n, reason: violations.join(',') || 'fact_check' }, nowMs, null);
    return { ok: true, held: violations.length ? violations : ['fact_check'] };
  }
  await update(db, orderId, followup, { state: 'awaiting_candidate', pending, dueAt: pending.deadlineAt }, { event: 'drafted', n }, nowMs, pending.deadlineAt);

  const to = customerEmailFor(order);
  if (to) {
    const locale = resolveOrderLocale(order);
    const token = mintReviewToken({ secret: await getSecret(), orderId, round: n, kind: 'followup', nowMs, ttlMs: 14 * DAY_MS });
    const email = buildCandidateAutomationEmail('candidate_followup_review', {
      locale,
      name: candidateIdentity(order, draft.profile).name,
      job: draft.job?.title || order.jobTitle,
      company: order.companyName,
      jobUrl: order.jobUrl,
      reviewUrl: buildReviewPageUrl(order, token, locale),
      deadlineAt: pending.deadlineAt,
      days,
      followupText: body,
      orderId,
    });
    await sendCascade([{
      payload: { from: ASSISTED_APPLICATION_SENDER, to: [to], subject: email.subject, html: email.html, text: email.text, tracking: false },
      recipient: { email: to },
      meta: { orderId, key: `followup_review_${n}` },
    }], { delayMs: 0 });
  }
  return { ok: true, drafted: n };
}

/**
 * Sends the pending follow-up to the employer (claimed in a transaction).
 * @param {'candidate'|'deadline'} by
 */
export async function sendFollowup({ db, orderId, nowMs, sendCascade, by }) {
  const ref = followupRefFor(db, orderId);
  let claimed = null;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.data();
    if (current?.state !== 'awaiting_candidate' || !current.pending) return;
    transaction.set(ref, { state: 'sending', sendingSince: nowMs }, { merge: true });
    claimed = current;
  });
  if (!claimed) return { ok: false, error: 'not_pending' };
  const { order, draft } = await loadContext(db, orderId);
  const pending = claimed.pending;
  const identity = candidateIdentity(order, draft.profile);
  // career-ops: never a phone number in a generated message.
  const text = `${pending.body}\n\n${[identity.name, identity.email].filter(Boolean).join('\n')}`;
  const messageId = claimed.messageId;
  const { failed, sent } = await sendCascade([{
    payload: {
      from: `${senderName(identity.name)} <${EMPLOYER_MAIL_FROM}>`,
      to: [claimed.to],
      subject: pending.subject,
      text,
      html: textToHtml(text),
      ...(identity.email ? { replyTo: identity.email } : {}),
      ...(messageId ? { headers: { 'In-Reply-To': messageId, References: messageId } } : {}),
      tracking: false,
    },
    recipient: { email: claimed.to },
    meta: { orderId, key: `employer_followup_${pending.n}` },
  }], { delayMs: 0, forceProvider: 'resend' });

  if (failed.length) {
    if (failed[0].ambiguousDelivery || pending.attempts + 1 >= MAX_SEND_ATTEMPTS) {
      return stop(db, orderId, claimed, failed[0].ambiguousDelivery ? 'send_ambiguous' : 'send_failed', nowMs);
    }
    const retryAt = nowMs + 60 * 60 * 1000;
    await update(db, orderId, claimed, { state: 'awaiting_candidate', pending: { ...pending, attempts: pending.attempts + 1 }, dueAt: retryAt }, { event: 'send_failed', n: pending.n }, nowMs, retryAt);
    return { ok: false, error: 'send_failed' };
  }
  const next = followupDueAt(claimed.submittedAt, pending.n + 1);
  // A follow-up approved late never makes the next one leave the same day.
  const nextDue = next ? Math.max(next, nowMs + 3 * DAY_MS) : null;
  await update(db, orderId, claimed, {
    state: next ? 'scheduled' : 'done',
    sent: pending.n,
    pending: null,
    dueAt: nextDue,
    lastSentAt: nowMs,
  }, { event: 'sent', n: pending.n, by, body: pending.body, provider: sent[0]?.provider || null }, nowMs, nextDue);
  return { ok: true, sent: pending.n };
}

/** The candidate's decision from the follow-up page. */
export async function decideFollowup({ db, orderId, n, decision, nowMs, sendCascade }) {
  const snapshot = await followupRefFor(db, orderId).get();
  const followup = snapshot.data();
  if (followup?.state !== 'awaiting_candidate' || Number(followup.pending?.n) !== Number(n)) return { ok: false, error: 'not_pending' };
  if (decision === 'skip') return stop(db, orderId, followup, 'candidate_stopped', nowMs);
  if (decision === 'send') return sendFollowup({ db, orderId, nowMs, sendCascade, by: 'candidate' });
  return { ok: false, error: 'invalid_decision' };
}

/** What the follow-up page shows (af1 link). */
export function followupReviewPayload({ order, draft, followup, n }) {
  const pending = followup?.pending && Number(followup.pending.n) === Number(n) ? followup.pending : null;
  const sentItem = (followup?.history || []).find((item) => item.event === 'sent' && Number(item.n) === Number(n));
  const state = pending && followup.state === 'awaiting_candidate' ? 'awaiting_candidate'
    : sentItem ? 'sent'
      : followup?.state === 'stopped' ? 'stopped' : followup?.state || 'unknown';
  return {
    ok: true,
    kind: 'followup',
    n: Number(n),
    of: MAX_FOLLOWUPS,
    state,
    locale: order?.locale || 'it',
    deadlineAt: state === 'awaiting_candidate' ? pending.deadlineAt : null,
    body: pending?.body || sentItem?.body || '',
    job: { title: draft?.job?.title || order?.jobTitle || '', company: order?.companyName || '' },
    can: { send: state === 'awaiting_candidate', skip: state === 'awaiting_candidate' },
  };
}

async function processFollowup({ db, orderId, nowMs, codex, sendCascade, getSecret }) {
  const context = await loadContext(db, orderId);
  const { order, followup } = context;
  if (!followup || ['done', 'stopped'].includes(followup.state)) {
    await orderRefFor(db, orderId).set({ followupDueAt: null }, { merge: true });
    return { ok: true, idle: true };
  }
  if (order.submissionStatus !== 'submitted') return stop(db, orderId, followup, 'order_not_submitted', nowMs);
  if (employerReplied(context.inbox, followup.submittedAt)) return stop(db, orderId, followup, 'employer_replied', nowMs);
  if (Number(followup.dueAt) > nowMs) {
    await orderRefFor(db, orderId).set({ followupDueAt: followup.dueAt }, { merge: true });
    return { ok: true, notDue: true };
  }
  if (followup.state === 'scheduled') return draftFollowup({ db, orderId, context, nowMs, codex, sendCascade, getSecret });
  if (followup.state === 'awaiting_candidate') return sendFollowup({ db, orderId, nowMs, sendCascade, by: 'deadline' });
  if (followup.state === 'sending' && nowMs - Number(followup.sendingSince || 0) > SENDING_STALE_MS) {
    // A send interrupted half-way has an unknown outcome: never sent twice.
    return stop(db, orderId, followup, 'send_ambiguous', nowMs);
  }
  return { ok: true, waiting: followup.state };
}

/**
 * Scheduled every 30 minutes (functions/index.js), behind the automation flag.
 * @param {{db, nowMs?:number, codex:Function, sendCascade:Function, getSecret?:Function, isEnabled?:Function, limit?:number}} deps
 */
export async function runFollowupSweep({ db, nowMs = Date.now(), codex, sendCascade, getSecret = getReviewTokenSecret, isEnabled = isAutomationEnabled, limit = 5 }) {
  if (!(await isEnabled())) return { skipped: 'flag_off' };
  const snapshot = await db.collection(ASSISTED_APPLICATIONS_COLLECTION).where('followupDueAt', '<=', nowMs).limit(limit).get();
  const results = [];
  for (const doc of snapshot.docs || []) {
    try {
      results.push({ orderId: doc.id, ...(await processFollowup({ db, orderId: doc.id, nowMs, codex, sendCascade, getSecret })) });
    } catch (error) {
      console.warn('[followupSweep]', doc.id, error instanceof Error ? error.message.slice(0, 120) : String(error));
      results.push({ orderId: doc.id, ok: false, error: 'exception' });
    }
  }
  return { processed: results.length, results };
}
