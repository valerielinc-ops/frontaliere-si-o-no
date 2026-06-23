/**
 * outreachStopReply.js — server-side auto-suppress from a STOP / UNSUBSCRIBE
 * reply to a cold-email (employer outreach) campaign (follow-up #2620, item 2).
 *
 * The Cloudflare Email Worker (infra/cloudflare-email-worker/stop-reply-handler.js)
 * receives the inbound reply (all @frontaliereticino.ch mail is routed through
 * Cloudflare Email Routing) and POSTs the parsed { from, subject, body } here.
 * This handler:
 *   1. Confirms the body/subject expresses a STOP intent.
 *   2. Reverse-maps the sender address to a companyKey via the Firestore
 *      `employer_contacts` collection (the admin-editable contacts registry —
 *      same source send-cold-emails.mjs overlays).
 *   3. Writes `employer_outreach_suppression/{companyKey}` with source
 *      'stop-reply', BYTE-IDENTICAL in shape to the one-click path
 *      (outreachUnsubscribe.js) so send-cold-emails.mjs honours it next touch.
 *
 * Auth: the Worker sends a shared secret (NEWSLETTER_SECRET, already provisioned)
 * in the `x-stop-secret` header. Without it the request is rejected — this
 * endpoint must never be a public write to the suppression list.
 *
 * Detection lives in scripts/lib/stop-reply-detect.mjs (the single source shared
 * with scripts/process-stop-replies.mjs); the heuristic is re-implemented here as
 * a tiny self-contained copy because Cloud Functions deploy from functions/ and
 * cannot import the scripts/ tree at runtime. Keep the two in lockstep
 * (AGENTS.md Non-Negotiable #6) — both are covered by unit tests.
 */

import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';

const SUPPRESSION_COLLECTION = 'employer_outreach_suppression';
const CONTACTS_COLLECTION = 'employer_contacts';

// MIRROR of scripts/lib/stop-reply-detect.mjs STOP_INTENT_PATTERNS. Keep in sync.
const STOP_INTENT_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bunsub\b/i,
  /\bdisiscriv\w*/i,
  /\brimuovet?em?i\b/i,
  /\bcancellat?em?i\b/i,
  /\bcancellate(?:mi|ci)?\b/i,
  /\bremove\s+me\b/i,
  /\bopt[\s-]?out\b/i,
  /non\s+(?:mi\s+)?(?:scriv|contatt|invi|mandat?)\w*\s+pi[uù]/i,
  /annull\w*\s+l\W?iscrizione/i,
];

export function isStopReply({ subject = '', body = '', text = '' } = {}) {
  const haystack = `${subject || ''}\n${body || text || ''}`;
  if (!haystack.trim()) return false;
  return STOP_INTENT_PATTERNS.some((re) => re.test(haystack));
}

// MIRROR of scripts/lib/stop-reply-detect.mjs extractSenderEmail. Keep in sync.
export function extractSenderEmail(fromHeader) {
  const raw = String(fromHeader || '').trim();
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim();
  const m = candidate.match(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/);
  return m ? m[0].toLowerCase().replace(/[).,;]+$/, '') : '';
}

/**
 * Resolve a sender address to a companyKey by scanning employer_contacts.
 * Returns '' if no contact has that email (verified or inferred).
 */
async function resolveCompanyKey(db, senderEmail) {
  const addr = String(senderEmail || '').trim().toLowerCase();
  if (!addr) return '';
  const snap = await db.collection(CONTACTS_COLLECTION).get();
  let found = '';
  snap.forEach((doc) => {
    if (found) return;
    const d = doc.data() || {};
    const verified = String(d.email || '').trim().toLowerCase();
    const inferred = String(d.emailInferred || '').trim().toLowerCase();
    if (verified === addr || inferred === addr) found = (d.companyKey || doc.id || '').trim();
  });
  return found;
}

/**
 * Core handler. `db` is injectable for unit tests.
 * Returns { status, body, companyKey? }.
 */
export async function handleOutreachStopReply({ from, subject, body, secret, providedSecret, db: injectedDb }) {
  if (!secret || providedSecret !== secret) {
    return { status: 403, body: 'forbidden' };
  }
  if (!isStopReply({ subject, body })) {
    // Not an opt-out — nothing to do, but a 200 so the Worker doesn't retry.
    return { status: 200, body: 'no-stop-intent' };
  }
  const fromEmail = extractSenderEmail(from);
  if (!fromEmail) {
    return { status: 200, body: 'no-sender' };
  }

  const db = injectedDb || getAdminDb();
  const companyKey = await resolveCompanyKey(db, fromEmail);
  if (!companyKey) {
    // Unknown sender: we can't safely map to a company. Record nothing in the
    // suppression list (keyed by companyKey), but signal so the Worker logs it.
    return { status: 200, body: 'unknown-sender' };
  }

  await db.collection(SUPPRESSION_COLLECTION).doc(companyKey).set({
    companyKey,
    suppressedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'stop-reply',
    suppressedFrom: fromEmail,
  }, { merge: true });

  return { status: 200, body: 'suppressed', companyKey };
}
