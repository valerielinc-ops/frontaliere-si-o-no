/**
 * newsletterUrls.js — SINGLE SOURCE of the HMAC-signed newsletter action URLs
 * (unsubscribe / resubscribe / preferences) and the one-click List-Unsubscribe
 * link shape, so every sender — the weekly newsletter script, the onboarding
 * drip, the win-back/sunset runners, and the welcome-email Cloud Function —
 * builds byte-identical URLs and the token scheme can never drift between
 * them.
 *
 * Canonical home is functions/src/lib/ (not services/) because the welcome
 * email is built inside a Cloud Function and firebase.json's `source:
 * "functions"` means functions/src/** can only import from within functions/
 * — no bundler, no reach into the repo-root services/ tree (same deploy
 * boundary documented in functions/src/lib/welcomeEmailTemplate.js and
 * functions/src/lib/newsletterUrlPaths.js). services/newsletterUrls.mjs
 * re-exports the builders below so every scripts/ and services/ importer
 * (send-newsletter.mjs, send-onboarding-drip.mjs, blast-publisher-ads.mjs,
 * preview-welcome-email.mjs, winbackEmail.mjs, dormantWinbackStage1Email.mjs,
 * ...) keeps resolving to the exact same module, zero edits required.
 *
 * The token is HMAC-SHA256 over the lowercased email keyed by
 * NEWSLETTER_SECRET; when the secret is absent the link degrades gracefully
 * to an unsigned URL — identical to the historical inline behavior.
 *
 * Secret resolution — two call sites, two timings:
 *  - scripts/ callers (send-newsletter.mjs etc.) import this module BEFORE
 *    scripts/load-rc-env.mjs populates process.env, so every builder below
 *    reads process.env.NEWSLETTER_SECRET INSIDE the function body, at call
 *    time — NOT hoisted to a module-level const. Hoisting it would silently
 *    make every scripts/ sender emit token-less, non-functional unsubscribe
 *    links in production while local tests keep passing.
 *  - the welcome-email Cloud Function (functions/src/newsletterWelcomeEmail.js)
 *    has no process.env.NEWSLETTER_SECRET — it's not in EMAIL_CASCADE_RC_KEYS
 *    (functions/src/remoteConfigSecrets.js), so it's never bridged into
 *    process.env at CF runtime — and instead resolves the secret
 *    asynchronously via getNewsletterSecrets(). Every builder below accepts
 *    an OPTIONAL `{ secret }` override that takes priority over the
 *    process.env read; when omitted, behavior is byte-identical to the
 *    original process.env-only implementation.
 */
import { createHmac } from 'node:crypto';

// Canonical prod domain (no www) — matches BASE_URL in send-newsletter.mjs.
const BASE_URL = 'https://frontaliereticino.ch';

// Dedicated path proxied straight to the newsletterManageSubscription Cloud
// Function by the CF Worker (infra/cloudflare-worker/locale-router.js) — bypasses
// the SPA/index.html catch-all and its `ac` autologin requirement entirely, so
// both a mail client's automated POST and a manual GET click work end-to-end.
const ONE_CLICK_BASE_URL = `${BASE_URL}/disiscrivi-newsletter/`;

function signedEmailToken(email, explicitSecret) {
  const secret = explicitSecret || process.env.NEWSLETTER_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(email.toLowerCase()).digest('hex');
}

/**
 * @param {string} email
 * @param {{secret?: string}} [opts] explicit secret override (Cloud Functions
 * runtime, where NEWSLETTER_SECRET is resolved via getNewsletterSecrets()
 * instead of process.env). Omit for the scripts/ call-time process.env
 * behavior.
 * @returns {string} unsubscribe URL for links the SPA processes client-side
 * (e.g. the email body footer link, which gets the `ac` autologin code
 * injected separately at send time). NOT a valid List-Unsubscribe header
 * target — use makeOneClickUnsubscribeUrl for that.
 */
export function makeUnsubscribeUrl(email, { secret } = {}) {
  const token = signedEmailToken(email, secret);
  const base = `${BASE_URL}/?action=unsubscribe&email=${encodeURIComponent(email)}`;
  return token ? `${base}&token=${token}` : base;
}

/**
 * @param {string} email
 * @param {{secret?: string}} [opts] see makeUnsubscribeUrl.
 * @returns {string} the actual RFC 8058 List-Unsubscribe one-click target —
 * routed directly to the Cloud Function (GET and POST), no SPA/autologin
 * dependency. Use this for the List-Unsubscribe header only.
 */
export function makeOneClickUnsubscribeUrl(email, { secret } = {}) {
  const token = signedEmailToken(email, secret);
  const base = `${ONE_CLICK_BASE_URL}?action=unsubscribe&email=${encodeURIComponent(email)}`;
  return token ? `${base}&token=${token}` : base;
}

/**
 * @param {string} email
 * @param {{secret?: string}} [opts] see makeUnsubscribeUrl.
 * @returns {string} one-click resubscribe / "stay subscribed" URL
 */
export function makeResubscribeUrl(email, { secret } = {}) {
  const token = signedEmailToken(email, secret);
  const base = `${BASE_URL}/?action=resubscribe&email=${encodeURIComponent(email)}`;
  return token ? `${base}&token=${token}` : base;
}

/**
 * Deterministic, never-expiring autologin code (HMAC over `autologin:<email>`).
 * The SPA's unsubscribe/resubscribe action handler (App.tsx) REQUIRES this `ac`
 * credential to authenticate the recipient — a bare email+token link is rejected
 * with "Link non valido". Mirrors generateAutologinCode in send-newsletter.mjs.
 * @param {string} email
 * @param {{secret?: string}} [opts] see makeUnsubscribeUrl.
 * @returns {string|null} 64-char hex code, or null when NEWSLETTER_SECRET is unset
 */
export function generateAutologinCode(email, { secret } = {}) {
  const resolved = secret || process.env.NEWSLETTER_SECRET;
  if (!resolved) return null;
  return createHmac('sha256', resolved).update('autologin:' + email.toLowerCase().trim()).digest('hex');
}

/**
 * Authenticated newsletter action link the SPA accepts: carries `email` + the
 * `ac` autologin code so App.tsx can sign the recipient in and apply the action.
 * @param {'resubscribe'|'unsubscribe'} action
 * @param {string} email
 * @param {{secret?: string}} [opts] see makeUnsubscribeUrl.
 * @returns {string}
 */
export function makeAuthenticatedActionUrl(action, email, { secret } = {}) {
  const code = generateAutologinCode(email, { secret });
  const base = `${BASE_URL}/?action=${action}&email=${encodeURIComponent(email)}&utm_medium=newsletter`;
  return code ? `${base}&ac=${code}` : base;
}

// ── Preferences URL — Cloud-Functions-only. Part of the newsletterWelcomeEmail
// extraction (AGENTS.md Non-Negotiable #6, docs/AGENTS-HISTORY.md#sibling-pattern-fix).
// The per-locale slug table below is a RUNTIME COPY of services/routeSlugs.data.ts's
// `newsletterPreferences` column — Cloud Functions cannot import that file (it's
// TypeScript, and firebase.json's `source: "functions"` deploy has no build/
// transpile step for anything outside functions/), so unlike the token/URL
// builders above this copy cannot be made impossible-by-construction. It is
// instead guarded by an automated drift test — see
// "functions-side newsletter preferences slug table" in
// tests/route-slugs-no-drift.test.ts — which imports BOTH this table and
// services/routeSlugs.data.ts's SLUG_TABLES and asserts they agree for all 4
// locales; a slug rename in one without the other fails CI.
export const PREFERENCES_SLUG = {
  it: 'preferenze-newsletter',
  en: 'newsletter-preferences',
  de: 'newsletter-einstellungen',
  fr: 'preferences-newsletter',
};

const localePathPrefix = (locale) => (locale === 'it' ? '' : `/${locale}`);

/**
 * @param {string} email
 * @param {string} locale
 * @param {{secret?: string}} [opts] see makeUnsubscribeUrl.
 * @returns {string|null} newsletter-preferences URL, or null (caller should
 * omit the link entirely) when there's no secret to sign a valid token with —
 * never ships an unverifiable link.
 */
export function makePreferencesUrl(email, locale, { secret } = {}) {
  const token = signedEmailToken(email, secret);
  if (!token) return null;
  const slug = PREFERENCES_SLUG[locale] || PREFERENCES_SLUG.it;
  const prefix = localePathPrefix(locale);
  const base = `${BASE_URL}${prefix}/${slug}?email=${encodeURIComponent(email)}`;
  return `${base}&token=${token}`;
}
