/**
 * Shared newsletter action URLs (unsubscribe / resubscribe).
 *
 * Single source of truth for the HMAC-signed one-click links, so every sender
 * (send-newsletter.mjs, the win-back/sunset runner) builds byte-identical URLs
 * and the token scheme can never drift between them.
 *
 * The token is HMAC-SHA256 over the lowercased email keyed by NEWSLETTER_SECRET;
 * when the secret is absent (local/dev) the link degrades gracefully to an
 * unsigned URL — identical to the historical inline behavior.
 */
import { createHmac } from 'node:crypto';

// Canonical prod domain (no www) — matches BASE_URL in send-newsletter.mjs.
const BASE_URL = 'https://frontaliereticino.ch';

function signedEmailToken(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(email.toLowerCase()).digest('hex');
}

/**
 * @param {string} email
 * @returns {string} one-click unsubscribe URL (RFC 8058 List-Unsubscribe target)
 */
export function makeUnsubscribeUrl(email) {
  const token = signedEmailToken(email);
  const base = `${BASE_URL}/?action=unsubscribe&email=${encodeURIComponent(email)}`;
  return token ? `${base}&token=${token}` : base;
}

/**
 * @param {string} email
 * @returns {string} one-click resubscribe / "stay subscribed" URL
 */
export function makeResubscribeUrl(email) {
  const token = signedEmailToken(email);
  const base = `${BASE_URL}/?action=resubscribe&email=${encodeURIComponent(email)}`;
  return token ? `${base}&token=${token}` : base;
}

/**
 * Deterministic, never-expiring autologin code (HMAC over `autologin:<email>`).
 * The SPA's unsubscribe/resubscribe action handler (App.tsx) REQUIRES this `ac`
 * credential to authenticate the recipient — a bare email+token link is rejected
 * with "Link non valido". Mirrors generateAutologinCode in send-newsletter.mjs.
 * @param {string} email
 * @returns {string|null} 64-char hex code, or null when NEWSLETTER_SECRET is unset
 */
export function generateAutologinCode(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update('autologin:' + email.toLowerCase().trim()).digest('hex');
}

/**
 * Authenticated newsletter action link the SPA accepts: carries `email` + the
 * `ac` autologin code so App.tsx can sign the recipient in and apply the action.
 * @param {'resubscribe'|'unsubscribe'} action
 * @param {string} email
 * @returns {string}
 */
export function makeAuthenticatedActionUrl(action, email) {
  const code = generateAutologinCode(email);
  const base = `${BASE_URL}/?action=${action}&email=${encodeURIComponent(email)}&utm_medium=newsletter`;
  return code ? `${base}&ac=${code}` : base;
}
