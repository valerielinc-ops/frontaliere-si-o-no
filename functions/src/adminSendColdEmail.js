/**
 * adminSendColdEmail.js — admin-gated, web-UI cold-email sender.
 *
 * Lets the owner send one cold-outreach touch to a company straight from the
 * admin dashboard (AdminPanel → Insights Aziende) instead of the CLI, so every
 * send is centrally tracked in employer_outreach_sends (same collection the CLI
 * writes) and visible in the dashboard.
 *
 * Safeguards (all enforced server-side, never trusting the client):
 *   1. Admin gate — Firebase ID token + ADMIN_EMAIL_ALLOWLIST (reuses assertAdmin).
 *   2. Verified email only — never sends to an inferred/guessed address.
 *   3. Suppression — refuses if the company opted out (employer_outreach_suppression).
 *   4. Dedup — refuses to re-send a touch already logged, unless `force: true`.
 *   5. Single source — body built from the shared buildSequence (byte-identical
 *      to the CLI send and the dashboard preview).
 *
 * The actual transport is injected (`sendEmail`) so the core is unit-testable
 * without hitting Resend; functions/index.js supplies the Resend-backed sender.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { buildSequence, bodyToHtml } from './coldEmailSequence.js';
import { buildInsightsUrl } from './employerInsights.js';
import { buildUnsubUrl } from './outreachUnsubscribe.js';

const INSIGHTS_COLLECTION = 'employer_insights';
const CONTACTS_COLLECTION = 'employer_contacts';
const SENDS_COLLECTION = 'employer_outreach_sends';
const SUPPRESSION_COLLECTION = 'employer_outreach_suppression';
// Matches the CLI default (send-cold-emails.mjs --days-label) so the preview,
// the CLI send and the web-UI send phrase the period identically.
const PERIOD_LABEL = 'negli ultimi 3 mesi';
const VALID_TOUCHES = new Set([1, 2, 3, 4]);

async function getDoc(db, collection, id) {
  try {
    const snap = await db.collection(collection).doc(id).get();
    return snap && snap.exists ? (snap.data() || {}) : null;
  } catch {
    return null;
  }
}

/**
 * Core handler — `db` and `sendEmail` are injectable for unit tests.
 * Returns { status, body }. `sendEmail({ from, to, subject, text, html, unsubUrl })`
 * must resolve to { messageId } or throw.
 *
 * @param {{ companyKey?: string, touch?: number, force?: boolean,
 *           secret?: string, db: any,
 *           sendEmail: (msg: { from: string, to: string, subject: string, text: string,
 *                              html: string, unsubUrl: string }) => Promise<{ messageId?: string }> }} args
 */
export async function handleAdminSendColdEmail({ companyKey, touch, force, secret, db, sendEmail }) {
  const key = String(companyKey || '').trim();
  const touchNum = Number(touch);
  if (!key) return { status: 400, body: { ok: false, error: 'missing_company_key' } };
  if (!VALID_TOUCHES.has(touchNum)) return { status: 400, body: { ok: false, error: 'invalid_touch' } };
  if (!secret) return { status: 503, body: { ok: false, error: 'secret_not_configured' } };

  const insights = await getDoc(db, INSIGHTS_COLLECTION, key);
  if (!insights) return { status: 404, body: { ok: false, error: 'no_insights' } };

  // Verified address only — an inferred guess must never be auto-sent.
  const contact = (await getDoc(db, CONTACTS_COLLECTION, key)) || {};
  const toEmail = String(contact.email || '').trim();
  if (!toEmail) return { status: 422, body: { ok: false, error: 'no_verified_email' } };

  // Opt-out wins over everything.
  const suppressed = await getDoc(db, SUPPRESSION_COLLECTION, key);
  if (suppressed) return { status: 409, body: { ok: false, error: 'suppressed' } };

  // Dedup: don't re-send a touch already logged (confirmed or pending) unless
  // explicitly forced. pendingTouches covers the window between the pre-send
  // marker write and the confirmed write: if Resend succeeds but the Firestore
  // confirmed write fails, the pending marker keeps dedup active for any retry.
  const sends = (await getDoc(db, SENDS_COLLECTION, key)) || {};
  const sentTouches = Array.isArray(sends.touches)
    ? sends.touches.map((x) => Number(x && x.touch)).filter(Boolean)
    : [];
  const pendingTouches = Array.isArray(sends.pendingTouches)
    ? sends.pendingTouches.map(Number).filter(Boolean)
    : [];
  if (!force && (sentTouches.includes(touchNum) || pendingTouches.includes(touchNum))) {
    return { status: 409, body: { ok: false, error: 'already_sent', touch: touchNum } };
  }

  const totals = insights.totals || {};
  const sequence = buildSequence({
    company: insights.companyName || contact.companyName || key,
    candidates: Number(totals.candidates || 0),
    periodLabel: PERIOD_LABEL,
    contactName: contact.contactName || '',
    topRole: contact.topRole || '',
  });
  const message = sequence.find((m) => m.touch === touchNum);
  if (!message) return { status: 500, body: { ok: false, error: 'touch_not_built' } };

  const insightsUrl = buildInsightsUrl(key, secret);
  const unsubUrl = buildUnsubUrl(key, secret);
  const text = message.body
    .split('{{INSIGHTS_URL}}').join(insightsUrl)
    .split('{{UNSUB_URL}}').join(unsubUrl);
  // Same html part the CLI sends (send-cold-emails.mjs), so the web-UI send
  // gains real <a href> links too instead of raw plain-text URLs.
  const html = bodyToHtml(message.body)
    .split('{{INSIGHTS_URL}}').join(insightsUrl)
    .split('{{UNSUB_URL}}').join(unsubUrl);

  // Write a pre-send marker so the dedup gate stays active even if the
  // confirmed write below fails (Resend out → Firestore down → no touches
  // entry → retry not blocked → duplicate unsolicited email). If this write
  // fails, proceed — no email has gone out yet so dedup is not weakened.
  try {
    await db.collection(SENDS_COLLECTION).doc(key).set({
      companyKey: key,
      pendingTouches: FieldValue.arrayUnion(touchNum),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch {
    // pre-send write failed; email not yet sent — safe to continue
  }

  let result;
  try {
    result = await sendEmail({
      from: 'Valerie <valerie@frontaliereticino.ch>',
      html,
      to: toEmail,
      subject: message.subject,
      text,
      unsubUrl,
    });
  } catch (err) {
    // Remove the pending marker so a retry is not incorrectly blocked.
    // Best-effort: a stale pending marker is preferable to a duplicate email.
    try {
      await db.collection(SENDS_COLLECTION).doc(key).set({
        pendingTouches: FieldValue.arrayRemove(touchNum),
      }, { merge: true });
    } catch { /* ignore cleanup failure */ }
    return { status: 502, body: { ok: false, error: 'send_failed', detail: err && err.message ? err.message : String(err) } };
  }

  const messageId = (result && result.messageId) || '';
  const sentAt = new Date().toISOString();
  try {
    await db.collection(SENDS_COLLECTION).doc(key).set({
      companyKey: key,
      lastTouch: touchNum,
      lastSentAt: sentAt,
      pendingTouches: FieldValue.arrayRemove(touchNum),
      touches: FieldValue.arrayUnion({
        touch: touchNum, sentAt, provider: 'resend', messageId,
        subject: message.subject, via: 'web-ui',
      }),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch {
    // Email sent but confirmed write failed. The pending marker is still set
    // (arrayRemove above was part of the same failed write), so dedup will
    // block any retry. tracked:false flags the missing confirmed record.
    return { status: 200, body: { ok: true, touch: touchNum, to: toEmail, messageId, tracked: false } };
  }

  return { status: 200, body: { ok: true, touch: touchNum, to: toEmail, messageId, tracked: true } };
}
