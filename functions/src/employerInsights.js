/**
 * employerInsights.js — HMAC-gated read API for the per-company "stats proof"
 * page (/azienda/<companyKey>/) linked from cold-outreach emails.
 *
 * GET ?c=<companyKey>&t=<token> → verifies the HMAC token, then returns the
 * employer_insights/{companyKey} document as JSON. The token gate keeps each
 * company's data private (a company can only see its own stats via its emailed
 * link); the Firestore collection is not publicly readable.
 *
 * Token scheme MUST stay byte-identical to scripts/lib/employer-insights-token.mjs:
 *   token = HMAC-SHA256(secret, `employer_insights:${companyKey}`) hex digest,
 *   secret = NEWSLETTER_SECRET. Distinct prefix avoids replay as an unsubscribe
 *   token (which uses `outreach_unsub:`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getAdminDb } from './newsletterResendWebhookCore.js';

const INSIGHTS_COLLECTION = 'employer_insights';
// Canonical prod domain (AGENTS.md). Kept in lockstep with the scripts-side
// builder scripts/lib/employer-insights-token.mjs (BASE_URL + INSIGHTS_PATH).
const BASE_URL = 'https://frontaliereticino.ch';
const INSIGHTS_PATH = '/azienda/';

export function generateInsightsToken(companyKey, secret) {
  return createHmac('sha256', secret)
    .update(`employer_insights:${String(companyKey).trim()}`)
    .digest('hex');
}

/**
 * Per-company stats-page URL — MUST stay byte-identical to
 * scripts/lib/employer-insights-token.mjs `buildInsightsUrl` so a link minted by
 * the web-UI sender (adminSendColdEmail) verifies the same as one from the CLI.
 * Falls back to the site home when the secret is missing (never emit an unsigned
 * link). A cross-boundary parity test guards the two builders against drift.
 */
export function buildInsightsUrl(companyKey, secret) {
  if (!secret) return `${BASE_URL}/`;
  const key = String(companyKey).trim();
  const token = generateInsightsToken(key, secret);
  return `${BASE_URL}${INSIGHTS_PATH}${encodeURIComponent(key)}/?t=${token}`;
}

export function verifyInsightsToken(companyKey, token, secret) {
  if (!secret || !companyKey || !token) return false;
  const expected = generateInsightsToken(companyKey, secret);
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Core handler — `db` injectable for unit tests. Returns { status, body } where
 * body is a plain object (the caller JSON-serializes).
 */
export async function handleEmployerInsights({ companyKey, token, secret, db: injectedDb }) {
  const key = String(companyKey || '').trim();
  if (!key) return { status: 400, body: { error: 'missing_company' } };
  if (!verifyInsightsToken(key, token, secret)) return { status: 403, body: { error: 'invalid_token' } };

  const db = injectedDb || getAdminDb();
  const snap = await db.collection(INSIGHTS_COLLECTION).doc(key).get();
  if (!snap.exists) return { status: 404, body: { error: 'not_found', companyKey: key } };

  const data = snap.data() || {};
  // Drop the server-side updatedAt sentinel (not JSON-serializable / not needed client-side).
  delete data.updatedAt;
  return { status: 200, body: data };
}
