/**
 * outreach-unsubscribe-token.mjs — shared HMAC token + URL builder for the
 * cold-email (employer outreach) one-click unsubscribe (RFC 8058).
 *
 * Mirrors the job-alert unsubscribe scheme (functions/src/jobAlertUnsubscribe.js
 * → generateAlertUnsubToken): same secret (NEWSLETTER_SECRET), same algo
 * (HMAC-SHA256, hex digest), distinct domain-separation prefix.
 *
 * The Cloud Function functions/src/outreachUnsubscribe.js MUST verify against
 * the IDENTICAL scheme — keep `outreach_unsub:<companyKey>` in sync with the
 * `generateOutreachUnsubToken` there. Any drift breaks one-click verification.
 */

import { createHmac } from 'node:crypto';

export const BASE_URL = 'https://frontaliereticino.ch';
// Trailing slash: site canonical convention (see AGENTS.md). Worker proxies this
// apex path to the outreachUnsubscribe Cloud Function (locale-router.js).
export const OUTREACH_UNSUB_PATH = '/disiscrivi-outreach/';

/**
 * HMAC token over the company key. Domain-separation prefix avoids collision
 * with job-alert / newsletter tokens that share NEWSLETTER_SECRET.
 */
export function makeUnsubToken(companyKey, secret = process.env.NEWSLETTER_SECRET) {
  if (!secret) throw new Error('NEWSLETTER_SECRET not set — cannot sign outreach unsubscribe token');
  return createHmac('sha256', secret)
    .update(`outreach_unsub:${String(companyKey).trim()}`)
    .digest('hex');
}

/**
 * Public one-click unsubscribe URL for a company key:
 *   https://frontaliereticino.ch/disiscrivi-outreach/?c=<enc>&t=<token>
 * Returns the site home as a safe fallback if the secret is missing (parity
 * with send-job-alerts.mjs which degrades to a non-functional link rather than
 * emitting an unsigned/forgeable one).
 */
export function buildUnsubUrl(companyKey, secret = process.env.NEWSLETTER_SECRET) {
  if (!secret) return `${BASE_URL}/`;
  const token = makeUnsubToken(companyKey, secret);
  return `${BASE_URL}${OUTREACH_UNSUB_PATH}?c=${encodeURIComponent(String(companyKey).trim())}&t=${token}`;
}
