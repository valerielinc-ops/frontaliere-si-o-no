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
 *   node scripts/newsletter-confirmation-followups.mjs             # DRY-RUN, no writes
 *   node scripts/newsletter-confirmation-followups.mjs --apply     # write the `expired` transitions
 *   node scripts/newsletter-confirmation-followups.mjs --epoch 2026-09-01T00:00:00Z
 *   node scripts/newsletter-confirmation-followups.mjs --json      # machine-readable summary
 *   node scripts/newsletter-confirmation-followups.mjs --show-emails
 *
 * Dry-run is the DEFAULT, like scripts/newsletter-sunset.mjs: the write here is
 * a terminal state, and a terminal state written by accident is not undone by
 * running the script again.
 *
 * ── IT DOES NOT SEND MAIL, AND THAT IS A DECLARATION, NOT AN OVERSIGHT ──────
 *
 * The text of the two reminders is the owner's to write (#5692: «Il testo dei
 * due solleciti: blocked: lo decide il proprietario»), and the scheduled
 * workflow that would run this daily needs a scope this branch does not have.
 * So the `send` decisions are PRINTED and never executed.
 *
 * If you are the person wiring the sends: the moment this file imports
 * `sendEmailCascade` it joins the sender population that
 * tests/helpers/senders.ts derives from disk, and BOTH
 * tests/no-channel-mails-unconfirmed.test.ts and
 * tests/no-channel-mails-opted-out.test.ts will fail until it has an explicit
 * verdict in each. That is the intended path — those files are how a new
 * channel is forced to answer "did this address ever opt in" and "has it since
 * opted out" — and the verdict is neither `gated` (the whole point is that the
 * recipient has NOT confirmed yet) nor a broadcast: it is a transactional
 * request the recipient's own signup asked for, minutes or hours earlier. Say
 * so there in those words. Do not route the send through another module to
 * keep this file out of the scan; the scan is the contract.
 *
 * ── WHY THE PLAN IS RECOMPUTED, NEVER STORED ───────────────────────────────
 *
 * Issue rule 6. A queue built yesterday mails somebody who confirmed,
 * unsubscribed, complained or bounced overnight — a `pending` document is the
 * most volatile row in this collection. `decideConfirmationFollowup` is pure
 * and cheap, so every run re-derives every answer from the document as it is
 * at that instant, and nothing is persisted between runs except the outcome.
 */
import { pathToFileURL } from 'node:url';
import {
  decideConfirmationFollowup,
  buildConfirmationExpiryFields,
  DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH,
  CONFIRMATION_EXPIRED_STATUS,
  MAX_CONFIRMATION_ATTEMPTS,
} from '../functions/src/lib/confirmationFollowup.js';
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

  for (const doc of docs) {
    const decision = decideConfirmationFollowup(doc.data, { now, epochMs });
    if (decision.action === 'expire') {
      expire.push({ ...doc, decision });
    } else if (decision.action === 'send') {
      send.push({ ...doc, decision });
    } else {
      skippedByReason.set(decision.reason, (skippedByReason.get(decision.reason) || 0) + 1);
    }
  }

  return {
    total: docs.length,
    expire,
    send,
    skipped: Object.fromEntries([...skippedByReason.entries()].sort((a, b) => b[1] - a[1])),
  };
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
    would_send: plan.send.length,
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
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[confirmation-followups] ${summary.mode} · ${summary.documents} documents · epoch ${summary.epoch}`);
    console.log(`  → ${CONFIRMATION_EXPIRED_STATUS}: ${summary.to_expire} ${JSON.stringify(summary.expire_breakdown)}`);
    console.log(`  → would request: ${summary.would_send} ${JSON.stringify(summary.send_breakdown)}`);
    console.log(`  → skipped: ${JSON.stringify(summary.skipped)}`);
    for (const it of expiring.slice(0, 20)) {
      const who = showEmails ? it.id : maskEmail(it.id);
      console.log(`     ${who} · ${it.decision.attempts} attempt(s) · ${it.decision.reason}`);
    }
  }

  if (plan.send.length) {
    console.log(
      `✉️  ${plan.send.length} confirmation request(s) are due and are NOT being sent: the reminder text ` +
        'and the scheduled workflow are the owner\'s (#5692). This runner only closes records.',
    );
  }

  if (!apply) {
    console.log('[confirmation-followups] DRY-RUN — nothing written. Re-run with --apply.');
    return;
  }

  if (!expiring.length) {
    console.log('[confirmation-followups] nothing to close.');
    return;
  }

  // Two passes because commitInChunks contracts for at most ONE operation per
  // item. The status transition first: if the event write fails afterwards the
  // record is still closed, which is the half that must not be lost.
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
