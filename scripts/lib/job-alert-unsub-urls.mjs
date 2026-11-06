/**
 * Job-alert unsubscribe URL builders — ONE home (issue #5012 phase 2).
 *
 * Extracted from scripts/send-job-alerts.mjs when the CompanyAlert immediate
 * sender (scripts/send-company-alerts.mjs) needed the same links. Copy-pasting
 * them would have put the HMAC derivation in two files, and the verifier lives
 * in a third (functions/src/jobAlertUnsubscribe.js) — the exact shape of defect
 * #5151 spent its whole review extracting: two sides of one token computed by
 * two functions, drifting silently, with the user's unsubscribe click failing
 * as an "invalid token" instead of an error anybody sees.
 *
 * Non-Negotiable #6: a literal duplicated in ≥2 files becomes one module.
 *
 * NOTE on `process.env.NEWSLETTER_SECRET`: read INSIDE each function, never
 * hoisted to a module constant. scripts/ load their secrets via
 * `node scripts/load-rc-env.mjs` at runtime, so a module-level capture would
 * bind `undefined` at import time and silently degrade every link to the
 * unsigned fallback in production (documented at
 * functions/src/lib/newsletterUrls.js:25-39).
 */

import { createHmac } from 'node:crypto';

export const BASE_URL = 'https://frontaliereticino.ch';

/**
 * One-click unsubscribe endpoint (RFC 8058). MUST live on the sending domain
 * (frontaliereticino.ch) or the URL↔sending-domain mismatch trips spam
 * filters — the raw
 * europe-west6-frontaliere-ticino.cloudfunctions.net/jobAlertUnsubscribe host
 * differs from the From domain (alerts@frontaliereticino.ch). This apex path
 * is transparently proxied to that Cloud Function by the locale-router Worker
 * (infra/cloudflare-worker/locale-router.js — method + query + body preserved,
 * so the List-Unsubscribe-Post one-click POST still reaches the function).
 * Trailing slash is canonical (site convention) and dodges a no-slash→slash
 * 301 on POST.
 */
export const JOB_ALERT_UNSUB_URL = `${BASE_URL}/disiscrivi-alert/`;

/** Fallback when NEWSLETTER_SECRET is absent — a real page, never a dead link. */
const UNSIGNED_FALLBACK = `${BASE_URL}/cerca-lavoro-ticino/`;

/**
 * Per-alert one-click unsubscribe link.
 *
 * @param {string} alertId Firestore alert subdoc id.
 * @param {string} email   Recipient address (raw; normalised for the HMAC).
 * @returns {string}
 */
export function makeAlertUnsubscribeUrl(alertId, email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return UNSIGNED_FALLBACK;
  const token = createHmac('sha256', secret)
    .update(`job_alert_unsub:${alertId}:${email.toLowerCase().trim()}`)
    .digest('hex');
  return `${JOB_ALERT_UNSUB_URL}?alertId=${encodeURIComponent(alertId)}&email=${encodeURIComponent(email)}&token=${token}`;
}

/**
 * "Stop every job alert" link (the footer escape hatch).
 *
 * @param {string} email
 * @returns {string}
 */
export function makeAllAlertsUnsubscribeUrl(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return UNSIGNED_FALLBACK;
  const token = createHmac('sha256', secret)
    .update(`job_alert_unsub_all:${email.toLowerCase().trim()}`)
    .digest('hex');
  return `${JOB_ALERT_UNSUB_URL}?email=${encodeURIComponent(email)}&token=${token}&action=unsubscribe_all`;
}
