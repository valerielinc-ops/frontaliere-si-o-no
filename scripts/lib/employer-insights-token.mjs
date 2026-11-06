/**
 * employer-insights-token.mjs — shared HMAC token + URL builder for the
 * per-company "stats proof" landing page linked from cold-outreach emails.
 *
 * Mirrors the outreach-unsubscribe scheme (scripts/lib/outreach-unsubscribe-token.mjs):
 * same secret (NEWSLETTER_SECRET), same algo (HMAC-SHA256 hex), distinct
 * domain-separation prefix `employer_insights:<companyKey>` so a stats token can
 * never be replayed as an unsubscribe token (or vice-versa).
 *
 * The Cloud Function functions/src/employerInsights.js MUST verify against the
 * IDENTICAL scheme — keep the prefix in sync. Any drift breaks the page gate.
 */

import { createHmac } from 'node:crypto';

export const BASE_URL = 'https://frontaliereticino.ch';
// Trailing slash: site canonical convention (AGENTS.md). The SPA route
// /azienda/<companyKey>/ renders the insights page; ?t=<token> gates the data.
export const INSIGHTS_PATH = '/azienda/';

export function makeInsightsToken(companyKey, secret = process.env.NEWSLETTER_SECRET) {
  if (!secret) throw new Error('NEWSLETTER_SECRET not set — cannot sign employer insights token');
  return createHmac('sha256', secret)
    .update(`employer_insights:${String(companyKey).trim()}`)
    .digest('hex');
}

/**
 * Public stats-page URL for a company key:
 *   https://frontaliereticino.ch/azienda/<enc-key>/?t=<token>
 * Returns the site home as a safe fallback if the secret is missing (parity with
 * buildUnsubUrl — never emit an unsigned/forgeable link).
 */
export function buildInsightsUrl(companyKey, secret = process.env.NEWSLETTER_SECRET) {
  if (!secret) return `${BASE_URL}/`;
  const key = String(companyKey).trim();
  const token = makeInsightsToken(key, secret);
  return `${BASE_URL}${INSIGHTS_PATH}${encodeURIComponent(key)}/?t=${token}`;
}
