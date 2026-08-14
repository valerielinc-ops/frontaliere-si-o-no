#!/usr/bin/env node
/**
 * newsletter-confirmation-followups.mjs — the runner that CLOSES a double
 * opt-in nobody answered (#5692).
 *
 * The owner's rule: at most three confirmation requests, one per day, the
 * first one included; after the third goes unanswered the record moves to the
 * terminal status `expired` and is KEPT. The policy itself is
 * functions/src/lib/confirmationFollowup.js — this file only walks the
 * collection, asks it about each document, prints the plan, and (with
 * `--apply`) writes the terminal transitions.
 *
 * Usage:
 *   node scripts/newsletter-confirmation-followups.mjs             # DRY-RUN, no writes, no mail
 *   node scripts/newsletter-confirmation-followups.mjs --apply     # send what is due, close what is finished
 *   node scripts/newsletter-confirmation-followups.mjs --apply --no-send   # close only, send nothing
 *   node scripts/newsletter-confirmation-followups.mjs --epoch 2026-09-01T00:00:00Z
 *   node scripts/newsletter-confirmation-followups.mjs --json      # machine-readable summary
 *   node scripts/newsletter-confirmation-followups.mjs --show-emails
 *
 * Dry-run is the DEFAULT, like scripts/newsletter-sunset.mjs: the write here is
 * a terminal state, and a terminal state written by accident is not undone by
 * running the script again. Neither is a delivered email.
 *
 * ── IT SENDS MAIL SINCE #5692, AND THAT IS A DECLARATION TOO ────────────────
 *
 * It did not, until the owner wrote the reminder copy on 2026-08-13. The
 * decision was to reuse the confirmation email verbatim and change only the
 * frame — see functions/src/lib/confirmationEmailContent.js for why that is the
 * conservative choice and not the lazy one — so requests #2 and #3 leave from
 * here with the same body and the same link as request #1.
 *
 * The predecessor of this block explained what the wiring would cost, and it was
 * right: importing `sendEmailCascade` puts this file in the sender population
 * tests/helpers/senders.ts derives from disk, and both
 * tests/no-channel-mails-unconfirmed.test.ts and
 * tests/no-channel-mails-opted-out.test.ts now carry an explicit verdict for it.
 * The verdict is `consent-request` in both, a value neither file had before: it
 * is not `gated`, because the entire point is that this recipient has NOT
 * confirmed; and it is not a broadcast, because it carries no content, no
 * offer, and one link — the one their own signup asked for. What it must never
 * do is reach somebody who already answered, and that is asserted in three
 * places rather than promised here.
 *
 * The cascade is imported from `functions/src/emailCascade.js` and NOT from the
 * `scripts/lib/email-cascade.mjs` shim, for the same reason the Cloud Functions
 * senders do: the shim's post-send link audit is for mass channels and requires
 * an unsubscribe link in every body (MASS_EMAIL_CHANNELS). This mail has none
 * and must have none — the recipient has no subscription to leave, and the only
 * link it may contain is the confirm link. That is a boundary, not an evasion:
 * the scan that matters, the one in tests/helpers/senders.ts, matches this file
 * either way and does.
 *
 * ── WHY THE PLAN IS RECOMPUTED, NEVER STORED ───────────────────────────────
 *
 * Issue rule 6. A queue built yesterday mails somebody who confirmed,
 * unsubscribed, complained or bounced overnight — a `pending` document is the
 * most volatile row in this collection. `decideConfirmationFollowup` is pure
 * and cheap, so every run re-derives every answer from the document as it is
 * at that instant, and nothing is persisted between runs except the outcome.
 *
 * ── THE 31 WHO WERE NEVER ASKED AT ALL ─────────────────────────────────────
 *
 * They do not get a reminder from here, and that is the rule working. Every one
 * of them predates DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH (none was created in the
 * 30 days before it was measured), so they are `backlog` — the owner scoped the
 * cadence to future signups. What they need is a FIRST confirmation email, which
 * is a different act with a different sender, so the summary counts them under
 * `never_asked_backlog` instead of quietly folding them into `backlog`: a
 * decision to reach them is a decision somebody makes on purpose, with the
 * number in front of them.
 */
import { pathToFileURL } from 'node:url';
import {
  decideConfirmationFollowup,
  buildConfirmationExpiryFields,
  buildConfirmationSentFields,
  buildConfirmationSentEvent,
  confirmationAttemptsUsed,
  confirmationFirstSentAt,
  DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH,
  CONFIRMATION_EXPIRED_STATUS,
  MAX_CONFIRMATION_ATTEMPTS,
} from '../functions/src/lib/confirmationFollowup.js';
import {
  CONFIRMATION_FROM_EMAIL,
  buildConfirmationRequestEmail,
  confirmationConfirmUrl,
  confirmationFrameForAttempt,
} from '../functions/src/lib/confirmationEmailContent.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from '../functions/src/emailCascade.js';
import {
  mintNewsletterActionToken,
  resolveNewsletterTokenPolicy,
  TOKEN_SCOPES,
} from '../functions/src/lib/newsletterActionToken.js';
import { normalizeLocale } from '../functions/src/emailI18n.js';
import { hasConfirmationProof } from '../services/subscriberConsent.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';

const COLLECTION = 'newsletter_subscribers';

function argValue(flag, argv = process.argv) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * `a***@example.com`.
 *
 * The default because this runs in CI logs and every row here is a person who
 * never confirmed anything — the one population whose address we have the
 * least standing to print. `--show-emails` is for a local operator who needs
 * to check a specific document.
 *
 * @param {string} email
 * @returns {string}
 */
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Ask the policy about every document and group the answers.
 *
 * Exported and side-effect-free so the runner can be driven from a test
 * without a Firestore, which is also why `main()` below is guarded rather than
 * called at module scope the way its siblings are: importing
 * scripts/newsletter-sunset.mjs RUNS it, and that is precisely why
 * tests/no-channel-mails-unconfirmed.test.ts had to settle for a source scan.
 *
 * @param {Array<{id: string, data: Record<string, any>, ref?: unknown}>} docs
 * @param {{now: number, epochMs: number}} ctx
 */
export function planConfirmationFollowups(docs, { now, epochMs }) {
  const expire = [];
  const send = [];
  const skippedByReason = new Map();
  let neverAskedBacklog = 0;

  for (const doc of docs) {
    const decision = decideConfirmationFollowup(doc.data, { now, epochMs });
    if (decision.action === 'expire') {
      expire.push({ ...doc, decision });
    } else if (decision.action === 'send') {
      send.push({ ...doc, decision });
    } else {
      skippedByReason.set(decision.reason, (skippedByReason.get(decision.reason) || 0) + 1);
      // The 31, counted separately from the rest of the backlog. `pending`,
      // before the epoch, no proof of consent and no request ever recorded:
      // people who submitted a form and were never written to at all. The
      // cadence does not cover them (see the docblock), so the only thing this
      // runner owes them is a number that does not disappear into a bucket of
      // 400. `hasConfirmationProof` is the shared gate, asked here for the same
      // reason it is asked in the policy: `pending` alone does not mean
      // "never consented".
      if (
        decision.reason === 'backlog' &&
        confirmationAttemptsUsed(doc.data) === 0 &&
        !hasConfirmationProof(doc.data)
      ) {
        neverAskedBacklog += 1;
      }
    }
  }

  return {
    total: docs.length,
    expire,
    send,
    neverAskedBacklog,
    skipped: Object.fromEntries([...skippedByReason.entries()].sort((a, b) => b[1] - a[1])),
  };
}

/**
 * Compose one confirmation request for a document the plan says is due.
 *
 * Exported and pure so a test can read the words that would actually be sent —
 * the frame, the subject, the date in the banner — without a Firestore, a
 * provider or a secret worth protecting. Every piece of it comes from the same
 * modules the Cloud Function uses for request #1.
 *
 * @param {{id: string, data: Record<string, any>, decision: {attempt: number}}} item
 * @param {{secret: string, tokenPolicy?: object}} ctx
 * @returns {{payload: Record<string, unknown>, recipient: {email: string}, meta: Record<string, unknown>}}
 */
export function buildFollowupRequest(item, { secret, tokenPolicy } = {}) {
  const email = item.id;
  const locale = normalizeLocale(item.data?.preferred_locale || item.data?.signup_locale || 'it');
  const token = mintNewsletterActionToken(email, TOKEN_SCOPES.CONFIRM, {
    secret,
    policy: tokenPolicy,
  });
  const frame = confirmationFrameForAttempt(item.decision.attempt);
  const { subject, html, tags } = buildConfirmationRequestEmail({
    locale,
    confirmUrl: confirmationConfirmUrl({ email, token }),
    frame,
    // Strictly the FIRST send, never the last one — the banner states a date to
    // somebody who has not consented to hear from us, so it is either right or
    // absent. `confirmationFirstSentAt` returns null on a document that has no
    // anchor and the copy falls back to an undated wording.
    firstSentAt: confirmationFirstSentAt(item.data),
  });
  return {
    payload: { from: CONFIRMATION_FROM_EMAIL, to: email, subject, html, tags },
    recipient: { email },
    meta: { id: email, locale, frame, attemptsBefore: item.decision.attempts, ref: item.ref },
  };
}

/**
 * Send the requests the plan says are due, then record each one.
 *
 * The ledger writes come from lib/confirmationFollowup.js — the same two
 * builders the Cloud Function uses for request #1 — and they run over what
 * actually left, never over the plan: a request the cascade could not deliver
 * must not consume one of the three. A failure therefore costs a day, not an
 * attempt, and the next run offers it again.
 *
 * ── `ambiguousDelivery` COUNTS, AND THAT ASYMMETRY IS THE POINT ─────────────
 *
 * The cascade distinguishes "never sent" from "the provider may already have
 * sent it and then failed on the response" (#4911). Treating the ambiguous case
 * as a non-send is the intuitive choice and the wrong one here: the ledger would
 * say two while the person has three messages in their inbox, and the cycle
 * would go on to send a fourth. Counting it instead costs at most one reminder
 * that a person who never consented does not receive — which is the direction
 * this whole feature errs in by design. `confirmation_message_id` stays null, so
 * the two cases remain distinguishable afterwards.
 *
 * ── ONE BATCH, NOT TWO PASSES (#5843, item 2) ──────────────────────────────
 *
 * The counter and its event used to be written by two sequential
 * `commitInChunks` calls, because the helper's contract was one operation per
 * item. Between those two calls there was a window: a process killed there
 * left `confirmation_attempts` incremented and the matching
 * `confirmation_email_sent` event missing from the subcollection — the counter
 * says three, the evidence says two, and the evidence is the half that gets
 * shown to an authority. Nothing raised, nothing logged, nothing to find
 * afterwards except a document that disagrees with its own history.
 *
 * They are now ONE operation pair in ONE batch per recipient, and a Firestore
 * batch commits atomically: either both writes land or neither does. Neither
 * is the safe end of that fork — the cascade already refuses to send again
 * inside the same day, so an uncounted send costs at most one repeated
 * reminder, while a counted send with no event costs the record of it.
 *
 * Exported for tests/newsletter-confirmation-ledger-atomicity.test.ts, which
 * drives it against a Firestore double whose commit dies mid-run and asserts
 * that no document is ever left holding one of the two.
 *
 * @param {unknown} db
 * @param {Array<object>} due
 * @param {{nowIso: string, secret: string, tokenPolicy?: object}} ctx
 * @returns {Promise<{sent: number, ambiguous: number, failed: number}>}
 */
export async function sendConfirmationRequests(db, due, { nowIso, secret, tokenPolicy }) {
  const items = due.map((it) => buildFollowupRequest(it, { secret, tokenPolicy }));
  const { sent, failed } = await sendEmailCascade(items);

  const ambiguous = failed.filter((f) => f.ambiguousDelivery);
  const definitelyNotSent = failed.filter((f) => !f.ambiguousDelivery);
  const counted = [...sent, ...ambiguous];

  if (counted.length) {
    // ONE pass, two writes per recipient, same batch. commitInChunks evaluates
    // its chunk boundary only between items, so these two never end up on
    // opposite sides of a commit.
    await commitInChunks(db, counted, (batch, s) => {
      batch.set(
        s.meta.ref,
        buildConfirmationSentFields({
          attemptsBefore: s.meta.attemptsBefore,
          isCycleSend: true,
          messageId: s.messageId || null,
          locale: s.meta.locale,
          stamp: nowIso,
        }),
        { merge: true },
      );
      batch.set(
        s.meta.ref.collection('events').doc(),
        buildConfirmationSentEvent({
          email: s.meta.id,
          attemptsBefore: s.meta.attemptsBefore,
          isCycleSend: true,
          messageId: s.messageId || null,
          locale: s.meta.locale,
          occurredAt: nowIso,
        }),
      );
    });
  }

  for (const f of ambiguous) {
    console.warn(`[confirmation-followups] ambiguous delivery, attempt COUNTED to avoid a fourth: ${maskEmail(f.recipient?.email)} — ${f.error}`);
  }
  for (const f of definitelyNotSent) {
    console.warn(`[confirmation-followups] not delivered, attempt NOT counted: ${maskEmail(f.recipient?.email)} — ${f.error}`);
  }
  return { sent: sent.length, ambiguous: ambiguous.length, failed: definitelyNotSent.length };
}

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return a.firestore();
}

async function main() {
  const apply = process.argv.includes('--apply');
  // Closing a record and mailing a person are different risks, so they have
  // different switches: `--no-send` lets an operator drain the terminal
  // transitions during an incident without putting anything on the wire.
  const noSend = process.argv.includes('--no-send');
  const asJson = process.argv.includes('--json');
  const showEmails = process.argv.includes('--show-emails');
  const limitRaw = argValue('--limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : null;
  const epochIso =
    argValue('--epoch') || process.env.CONFIRMATION_FOLLOWUP_EPOCH || DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH;
  const epochMs = Date.parse(epochIso);
  if (Number.isNaN(epochMs)) {
    console.error(`[confirmation-followups] unparseable --epoch: ${epochIso}`);
    process.exit(2);
  }

  const db = await initFirebase();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // The whole collection, not a `where('status','==','pending')` query: the
  // skip reasons are the measure this issue is judged on (how many `pending`
  // documents are re-probes, how many are backlog), and a query that filtered
  // them out server-side would report a plan with no denominator.
  const snap = await db.collection(COLLECTION).get();
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data(), ref: d.ref }));

  const plan = planConfirmationFollowups(docs, { now, epochMs });
  const expiring = limit ? plan.expire.slice(0, limit) : plan.expire;

  const summary = {
    ran_at: nowIso,
    epoch: new Date(epochMs).toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    documents: plan.total,
    to_expire: plan.expire.length,
    expiring_now: expiring.length,
    // Renamed from `would_send` by #5692: it is no longer hypothetical.
    due_now: plan.send.length,
    send_breakdown: plan.send.reduce((acc, it) => {
      const key = `attempt_${it.decision.attempt}_of_${MAX_CONFIRMATION_ATTEMPTS}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    expire_breakdown: plan.expire.reduce((acc, it) => {
      acc[it.decision.reason] = (acc[it.decision.reason] || 0) + 1;
      return acc;
    }, {}),
    skipped: plan.skipped,
    // Broken out of `skipped.backlog` on purpose — see the docblock. These are
    // the people who were never written to at all, and they need a FIRST
    // confirmation email, not a reminder.
    never_asked_backlog: plan.neverAskedBacklog,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[confirmation-followups] ${summary.mode} · ${summary.documents} documents · epoch ${summary.epoch}`);
    console.log(`  → ${CONFIRMATION_EXPIRED_STATUS}: ${summary.to_expire} ${JSON.stringify(summary.expire_breakdown)}`);
    console.log(`  → due now: ${summary.due_now} ${JSON.stringify(summary.send_breakdown)}`);
    console.log(`  → skipped: ${JSON.stringify(summary.skipped)}`);
    console.log(`  → never asked, before the epoch (need a FIRST email, not a reminder): ${summary.never_asked_backlog}`);
    for (const it of expiring.slice(0, 20)) {
      const who = showEmails ? it.id : maskEmail(it.id);
      console.log(`     ${who} · ${it.decision.attempts} attempt(s) · ${it.decision.reason}`);
    }
  }

  if (!apply) {
    console.log('[confirmation-followups] DRY-RUN — nothing sent, nothing written. Re-run with --apply.');
    return;
  }

  // ── The sends, before the closures ────────────────────────────────────────
  // Order matters on the day a document is both: a third request that goes out
  // this morning must not be closed by the same run that sent it — and it
  // cannot be, because `expire` and `send` are disjoint buckets of one pass. The
  // ordering is here for the operator reading the log: what left, then what
  // stopped.
  const secret = process.env.NEWSLETTER_SECRET;
  const tokenPolicy = resolveNewsletterTokenPolicy(process.env);
  if (plan.send.length && !noSend) {
    // FAIL-CLOSED on both halves. An unsigned link is a link that cannot
    // confirm, and a message with no provider behind it is a wasted attempt —
    // and an attempt, once counted, is not given back.
    if (!secret) {
      console.error('[confirmation-followups] NEWSLETTER_SECRET is unset — no confirmation link can be signed. Sending nothing.');
      process.exitCode = 1;
    } else if (!PROVIDERS.some((p) => isProviderConfigured(p.id))) {
      console.error('[confirmation-followups] no email provider configured. Sending nothing.');
      process.exitCode = 1;
    } else {
      const requests = limit ? plan.send.slice(0, limit) : plan.send;
      const result = await sendConfirmationRequests(db, requests, { nowIso, secret, tokenPolicy });
      console.log(
        `✉️  confirmation requests sent: ${result.sent}, ambiguous (counted): ${result.ambiguous}, not delivered: ${result.failed}`,
      );
    }
  } else if (plan.send.length) {
    console.log(`✉️  ${plan.send.length} request(s) due and skipped by --no-send.`);
  }

  if (!expiring.length) {
    console.log('[confirmation-followups] nothing to close.');
    return;
  }

  // Two passes HERE BY CHOICE, and no longer by limitation — commitInChunks
  // can now carry both writes of one record in a single atomic batch, and the
  // send path above uses exactly that. The closure keeps its split for the
  // reason it always had: the status transition is the half that must not be
  // lost, so it goes first and stands on its own even if the evidence write
  // never happens. Merging the two would make a crash lose the closure as
  // well — recoverable (the next run re-derives it) but a different tradeoff
  // than the one the owner's rule was written around. Changing it is a
  // decision, not a cleanup.
  await commitInChunks(db, expiring, (batch, it) => {
    batch.set(it.ref, buildConfirmationExpiryFields(it.decision, nowIso), { merge: true });
  });

  // The per-record evidence, in the subcollection that survives every later
  // overwrite of the flat fields — the same place each `confirmation_email_sent`
  // lands, so "asked three times, then stopped" reads as one sequence.
  await commitInChunks(db, expiring, (batch, it) => {
    batch.set(it.ref.collection('events').doc(), {
      email: it.id,
      event_type: 'confirmation_expired',
      source_channel: 'newsletter_confirmation',
      confirmation_attempts: it.decision.attempts,
      confirmation_attempts_max: MAX_CONFIRMATION_ATTEMPTS,
      reason: it.decision.reason,
      occurred_at: nowIso,
    });
  });

  console.log(`🔒 Closed ${expiring.length} → ${CONFIRMATION_EXPIRED_STATUS} (kept, not deleted).`);
}

// Guarded entrypoint: importing this module must not run it. Every sibling
// runner calls main() at module scope, and that is exactly why they can only
// ever be source-scanned instead of driven.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[confirmation-followups] fatal:', err?.stack || err?.message || err);
    process.exit(1);
  });
}
