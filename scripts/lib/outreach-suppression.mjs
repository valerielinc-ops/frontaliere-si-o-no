/**
 * outreach-suppression.mjs — SINGLE SOURCE of the suppression write shape used by
 * the STOP-reply auto-suppress path.
 *
 * The Firestore collection `employer_outreach_suppression` (doc id = companyKey)
 * is READ by scripts/send-cold-emails.mjs (loadFirestoreSuppression) and already
 * WRITTEN by functions/src/outreachUnsubscribe.js for the one-click path. This
 * helper mirrors that exact write shape so a STOP reply suppresses a company the
 * same way a one-click unsubscribe does — no parallel/divergent schema
 * (AGENTS.md Non-Negotiable #6).
 *
 * Doc fields (must stay in sync with outreachUnsubscribe.js):
 *   companyKey  — string, also the doc id
 *   suppressedAt — server/ISO timestamp
 *   source      — provenance tag ('stop-reply' here vs 'one-click' there)
 */

export const SUPPRESSION_COLLECTION = 'employer_outreach_suppression';

/**
 * Resolve an inbound sender email to a companyKey using the contacts registry
 * (the same { [companyKey]: { email } } map send-cold-emails.mjs sends to).
 * Returns the FIRST matching companyKey or '' if the address is unknown.
 *
 * @param {string} senderEmail lower-cased bare address
 * @param {Record<string, {email?: string, emailInferred?: string}>} contacts
 * @returns {string}
 */
export function resolveCompanyKeyByEmail(senderEmail, contacts) {
  const addr = String(senderEmail || '').trim().toLowerCase();
  if (!addr || !contacts) return '';
  for (const [key, c] of Object.entries(contacts)) {
    const verified = String(c?.email || '').trim().toLowerCase();
    const inferred = String(c?.emailInferred || '').trim().toLowerCase();
    if (verified === addr || inferred === addr) return key;
  }
  return '';
}

/**
 * Write a suppression doc to Firestore for `companyKey`, mirroring the one-click
 * path's shape. `db` is the firebase-admin Firestore handle; `serverTimestamp`
 * is passed in so this stays free of a hard firebase-admin import (the CF Email
 * Worker uses its own binding). Idempotent (merge:true) — a repeat STOP just
 * refreshes the timestamp.
 *
 * @param {object} args
 * @param {import('firebase-admin/firestore').Firestore} args.db
 * @param {string} args.companyKey
 * @param {*} args.serverTimestamp value to store in suppressedAt (FieldValue or ISO string)
 * @param {string} [args.source='stop-reply']
 * @param {string} [args.fromEmail] optional sender address, stored for audit
 * @returns {Promise<void>}
 */
export async function writeSuppression({ db, companyKey, serverTimestamp, source = 'stop-reply', fromEmail }) {
  const key = String(companyKey || '').trim();
  if (!key) throw new Error('writeSuppression: companyKey required');
  const doc = {
    companyKey: key,
    suppressedAt: serverTimestamp,
    source,
  };
  if (fromEmail) doc.suppressedFrom = String(fromEmail).trim().toLowerCase();
  await db.collection(SUPPRESSION_COLLECTION).doc(key).set(doc, { merge: true });
}
