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
 * (send-newsletter.mjs, send-job-alerts.mjs, send-onboarding-drip.mjs,
 * blast-publisher-ads.mjs, preview-welcome-email.mjs, winbackEmail.mjs,
 * dormantWinbackStage1Email.mjs, ...) keeps resolving to the exact same
 * module, zero edits required.
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
import { mintAutologinCode } from './autologinCode.js';

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
 * The `ac` autologin code. The SPA's unsubscribe/resubscribe action handler
 * (App.tsx) uses this credential to authenticate the recipient.
 *
 * Format and lifetime now live in lib/autologinCode.js (#5685). It used to be a
 * deterministic, never-expiring HMAC over `autologin:<email>` — a permanent
 * password mailed to the recipient and copied verbatim into the provider's
 * click log, into every anti-phishing scanner's log, into every forward and
 * every mail archive. Which scheme is minted is a Remote Config policy
 * (NEWSLETTER_AC_SCHEME) that defaults to `legacy`, so this call stays
 * byte-identical to the pre-#5685 implementation until the policy is flipped.
 *
 * @param {string} email
 * @param {{secret?: string, scheme?: 'legacy'|'v1', now?: number}} [opts] see
 *   makeUnsubscribeUrl for `secret`; `scheme`/`now` are policy overrides used by
 *   tests and by senders pinning one code for a whole send.
 * @returns {string|null} the code, or null when NEWSLETTER_SECRET is unset
 */
export function generateAutologinCode(email, { secret, scheme, now } = {}) {
  const resolved = secret || process.env.NEWSLETTER_SECRET;
  if (!resolved) return null;
  return mintAutologinCode(email, { secret: resolved, scheme, ...(now === undefined ? {} : { now }) });
}

/**
 * Authenticated newsletter action link the SPA accepts: carries `email`, the
 * `ac` autologin code so App.tsx can sign the recipient in, AND the plain email
 * HMAC as `token`.
 *
 * `token` is there for the separation of powers (#5685). `ac` is a
 * session-minting credential with a lifetime; `token` only ever proves "this
 * address was sent this link" and is what the Cloud Function accepts to record
 * an opt-out. Carrying both is what lets App.tsx fall back to the Cloud Function
 * when the autologin exchange refuses — expired, revoked, or
 * `autologin_enabled:false` — instead of showing "Link non valido" to somebody
 * trying to leave. Without it the four callers of this builder (win-back,
 * dormant win-back, onboarding drip, publisher blast) would have had no second
 * credential once `ac` starts expiring.
 *
 * @param {'resubscribe'|'unsubscribe'} action
 * @param {string} email
 * @param {{secret?: string}} [opts] see makeUnsubscribeUrl.
 * @returns {string}
 */
export function makeAuthenticatedActionUrl(action, email, { secret } = {}) {
  const code = generateAutologinCode(email, { secret });
  const token = signedEmailToken(email, secret);
  const base = `${BASE_URL}/?action=${action}&email=${encodeURIComponent(email)}&utm_medium=newsletter`;
  return `${base}${code ? `&ac=${code}` : ''}${token ? `&token=${token}` : ''}`;
}

/**
 * True when an href should carry autologin credentials: our own site only,
 * never mailto/tel/anchors, never static assets.
 * @param {string} rawHref
 * @returns {boolean}
 */
export function shouldWrapAuthenticatedHref(rawHref) {
  if (!rawHref) return false;
  if (rawHref.startsWith('mailto:') || rawHref.startsWith('tel:') || rawHref.startsWith('#')) return false;
  let url;
  try { url = new URL(rawHref, BASE_URL); } catch { return false; }
  if (url.hostname.replace(/^www\./, '') !== 'frontaliereticino.ch') return false;
  if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/icons/')) return false;
  return true;
}

/**
 * Add autologin credentials to one of our own URLs so the recipient lands
 * signed in. `ne`/`ac` are deliberately short: Mailgun silently drops click
 * tracking for href values >= 1000 characters.
 *
 * utm_medium defaults to 'newsletter' because GA4's Email channel grouping keys
 * on it; pass utmCampaign to keep campaigns separable within that channel.
 * Job alerts override both: they use 'email' (medium = channel, source =
 * identifier) and must keep the utm_medium their utmBase already set.
 *
 * @param {string} targetUrl absolute or site-relative
 * @param {string} email
 * @param {object} [opts]
 * @param {string} [opts.secret] signing secret; falls back to
 *   process.env.NEWSLETTER_SECRET, read at call time.
 * @param {string|null} [opts.autologinCode] reuse a code already generated for
 *   this recipient instead of computing another HMAC.
 * @param {string|null} [opts.utmCampaign] added as utm_campaign when set.
 * @param {string} [opts.utmMedium='newsletter'] value written to utm_medium.
 * @param {boolean} [opts.preserveExistingUtmMedium=false] when true, leave a
 *   utm_medium already present on targetUrl untouched.
 * @returns {string}
 */
export function makeAuthenticatedUrl(
  targetUrl,
  email,
  { secret, autologinCode, utmCampaign, utmMedium = 'newsletter', preserveExistingUtmMedium = false } = {},
) {
  const url = new URL(targetUrl, BASE_URL);
  const code = autologinCode === undefined ? generateAutologinCode(email, { secret }) : autologinCode;
  url.searchParams.set('ne', String(email || '').toLowerCase());
  if (code) url.searchParams.set('ac', code);
  // Job alerts build their links from a utmBase that already carries a
  // utm_medium; overwriting it would lose that attribution. The newsletter and
  // the welcome email have no such base and always want the GA4 Email channel
  // value, so overwrite stays the default.
  if (!(preserveExistingUtmMedium && url.searchParams.has('utm_medium'))) {
    url.searchParams.set('utm_medium', utmMedium);
  }
  if (utmCampaign) url.searchParams.set('utm_campaign', utmCampaign);
  return url.toString();
}

/**
 * Rewrite every eligible href in an email body to its autologin form. One
 * code is generated per recipient and reused across every link in the message,
 * so this costs a single HMAC regardless of link count. The v1 code's issue
 * stamp is day-granular precisely so that stays true (lib/autologinCode.js).
 *
 * @param {string} html
 * @param {string} email
 * @param {{secret?: string, utmCampaign?: string|null}} [opts]
 * @returns {string}
 */
export function wrapAuthenticatedHrefs(html, email, { secret, utmCampaign } = {}) {
  if (!html || !email) return html;
  const autologinCode = generateAutologinCode(email, { secret });
  return html.replace(/href="([^"]+)"/g, (whole, rawHref) => {
    const href = rawHref.replace(/&amp;/g, '&');
    if (!shouldWrapAuthenticatedHref(href)) return whole;
    const wrapped = makeAuthenticatedUrl(href, email, { secret, autologinCode, utmCampaign });
    return `href="${wrapped.replace(/&/g, '&amp;')}"`;
  });
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
 * @param {{secret?: string, fallbackUnsigned?: boolean}} [opts] `secret` as
 * in makeUnsubscribeUrl. `fallbackUnsigned` (default false, matching the
 * welcome-email Cloud Function's "never ship an unverifiable link" posture)
 * — set true to instead return the unsigned base URL when there's no secret,
 * matching the historical inline behavior of the weekly newsletter and job
 * alert senders (scripts/send-newsletter.mjs, scripts/send-job-alerts.mjs),
 * one of which string-concatenates this return value unguarded.
 * @returns {string|null} newsletter-preferences URL; null when there's no
 * secret and `fallbackUnsigned` is false.
 */
export function makePreferencesUrl(email, locale, { secret, fallbackUnsigned = false } = {}) {
  // The `email` param must carry the SAME normalized form the token is signed
  // over, otherwise the handler verifies an HMAC of the lowercased address
  // against a differently-cased param. Both pre-consolidation implementations
  // (scripts/send-newsletter.mjs, scripts/send-job-alerts.mjs) normalized here;
  // dropping it would have silently broken the link for any stored address
  // that is not already lowercase.
  const normalized = String(email || '').toLowerCase().trim();
  const token = signedEmailToken(normalized, secret);
  const slug = PREFERENCES_SLUG[locale] || PREFERENCES_SLUG.it;
  const prefix = localePathPrefix(locale);
  const base = `${BASE_URL}${prefix}/${slug}?email=${encodeURIComponent(normalized)}`;
  if (!token) return fallbackUnsigned ? base : null;
  return `${base}&token=${token}`;
}
