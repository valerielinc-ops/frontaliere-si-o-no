/**
 * outreachReplyTrack.js — server-side recording of ANY inbound cold-email reply
 * so the admin dashboard can show "ha risposto sì/no" per company.
 *
 * The Cloudflare Email Worker (infra/cloudflare-email-worker/stop-reply-handler.js)
 * POSTs every inbound reply { from, subject } here, gated by the shared secret
 * (NEWSLETTER_SECRET) in the `x-stop-secret` header — same gate as
 * outreachStopReply. STOP-intent replies still go to outreachStopReply for
 * suppression; this endpoint is purely additive reply telemetry.
 *
 * It reverse-maps the sender → companyKey (shared with outreachStopReply, no
 * drift) and upserts `employer_outreach_replies/{companyKey}` with the last
 * reply + a running count. Sender that maps to no company → no write.
 *
 * POST-only, secret-gated, never writes for an unidentifiable/unknown sender.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
// Single source for sender parsing + company reverse-map (AGENTS.md #6 — no drift).
import { extractSenderEmail, resolveCompanyKey } from './outreachStopReply.js';

const REPLIES_COLLECTION = 'employer_outreach_replies';

/**
 * Core handler — `db` injectable for unit tests. Returns { status, body }.
 * @param {{ from?: string, subject?: string, secret?: string,
 *           providedSecret?: string, db?: any }} args
 */
export async function handleOutreachReplyTrack({ from, subject, secret, providedSecret, db: injectedDb }) {
  // Secret gate (mirrors outreachStopReply): never let an unauthenticated caller
  // write reply telemetry.
  if (!secret || String(providedSecret || '') !== String(secret)) {
    return { status: 403, body: 'forbidden' };
  }

  const senderEmail = extractSenderEmail(from);
  if (!senderEmail) return { status: 200, body: 'no-sender' };

  const db = injectedDb || getAdminDb();
  const companyKey = await resolveCompanyKey(db, senderEmail);
  if (!companyKey) return { status: 200, body: 'unknown-sender' };

  const now = new Date().toISOString();
  await db.collection(REPLIES_COLLECTION).doc(companyKey).set({
    companyKey,
    replied: true,
    lastRepliedAt: now,
    lastReplyFrom: senderEmail,
    lastReplySubject: String(subject || '').slice(0, 200),
    replyCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { status: 200, body: 'recorded' };
}
