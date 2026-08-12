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
 * The token is minted by lib/newsletterActionToken.js and is SCOPED TO THE
 * ACTION of the link it rides in (#5704): the string in an unsubscribe URL is
 * not the string in a preferences URL, and neither is the one in the
 * confirmation email. It used to be one HMAC over the bare address, accepted by
 * every action the Cloud Function exposes — see that module's header for what
 * that credential could do. When the secret is absent the link still degrades
 * gracefully to an unsigned URL, identical to the historical inline behavior.
 *
 * `policy` on every builder: Cloud Functions have no NEWSLETTER_TOKEN_* in
 * process.env (the same gap wrapAuthenticatedHrefs documents for `scheme`), so a
 * CF-side caller that omits it mints the defaults no matter what Remote Config
 * says — including through a rollback. The scripts/ senders read the policy from
 * process.env via scripts/load-rc-env.mjs and need no argument.
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
import { mintAutologinCode } from './autologinCode.js';
import { mintNewsletterActionToken, normalizeEmail, TOKEN_SCOPES } from './newsletterActionToken.js';

// Canonical prod domain (no www) — matches BASE_URL in send-newsletter.mjs.
const BASE_URL = 'https://frontaliereticino.ch';

// Dedicated path proxied straight to the newsletterManageSubscription Cloud
// Function by the CF Worker (infra/cloudflare-worker/locale-router.js) — bypasses
// the SPA/index.html catch-all and its `ac` autologin requirement entirely, so
// both a mail client's automated POST and a manual GET click work end-to-end.
const ONE_CLICK_BASE_URL = `${BASE_URL}/disiscrivi-newsletter/`;

/**
 * The signed token for ONE action's link.
 *
 * The address is normalised HERE, with the same function the verifier uses
 * (newsletterActionToken.js `normalizeEmail`), and the callers below put the
 * SAME normalised string in the URL. Three of the four builders used to sign
 * `email.toLowerCase()` and emit the raw address, while the confirmation email
 * signed `.toLowerCase().trim()` and the Cloud Function verified
 * `.trim().toLowerCase()` — so a stored address with stray whitespace was signed
 * over one string and verified against another, and its unsubscribe link
 * answered "Link non valido" for ever. One normalisation, one derivation.
 *
 * @param {string} email
 * @param {string} scope one of TOKEN_SCOPES
 * @param {{secret?: string, scheme?: 'legacy'|'v1', policy?: object, now?: number}} [opts]
 */
function signedActionToken(email, scope, { secret, scheme, policy, now } = {}) {
  const resolved = secret || process.env.NEWSLETTER_SECRET;
  if (!resolved) return null;
  return mintNewsletterActionToken(email, scope, {
    secret: resolved,
    scheme,
    policy,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * @param {string} email
 * @param {{secret?: string, scheme?: 'legacy'|'v1', policy?: object, now?: number}} [opts]
 * `secret` is the explicit override for the Cloud Functions runtime, where
 * NEWSLETTER_SECRET is resolved via getNewsletterSecrets() instead of
 * process.env; omit it for the scripts/ call-time process.env behavior.
 * `policy`/`scheme` pick the token format (lib/newsletterActionToken.js) and
 * matter for the same reason: a Cloud Functions caller that omits them mints the
 * built-in defaults whatever Remote Config says. `now` pins the issue stamp,
 * for tests and for a whole send.
 * @returns {string} unsubscribe URL for links the SPA processes client-side
 * (e.g. the email body footer link, which gets the `ac` autologin code
 * injected separately at send time). NOT a valid List-Unsubscribe header
 * target — use makeOneClickUnsubscribeUrl for that.
 */
export function makeUnsubscribeUrl(email, { secret, scheme, policy, now } = {}) {
  const normalized = normalizeEmail(email);
  const token = signedActionToken(normalized, TOKEN_SCOPES.UNSUBSCRIBE, { secret, scheme, policy, now });
  const base = `${BASE_URL}/?action=unsubscribe&email=${encodeURIComponent(normalized)}`;
  return token ? `${base}&token=${token}` : base;
}

/**
 * @param {string} email
 * @param {{secret?: string, scheme?: 'legacy'|'v1', policy?: object, now?: number}} [opts] see makeUnsubscribeUrl.
 * @returns {string} the actual RFC 8058 List-Unsubscribe one-click target —
 * routed directly to the Cloud Function (GET and POST), no SPA/autologin
 * dependency. Use this for the List-Unsubscribe header only.
 */
export function makeOneClickUnsubscribeUrl(email, { secret, scheme, policy, now } = {}) {
  const normalized = normalizeEmail(email);
  const token = signedActionToken(normalized, TOKEN_SCOPES.UNSUBSCRIBE, { secret, scheme, policy, now });
  const base = `${ONE_CLICK_BASE_URL}?action=unsubscribe&email=${encodeURIComponent(normalized)}`;
  return token ? `${base}&token=${token}` : base;
}

/**
 * @param {string} email
 * @param {{secret?: string, scheme?: 'legacy'|'v1', policy?: object, now?: number}} [opts] see makeUnsubscribeUrl.
 * @returns {string} one-click resubscribe / "stay subscribed" URL
 */
export function makeResubscribeUrl(email, { secret, scheme, policy, now } = {}) {
  const normalized = normalizeEmail(email);
  const token = signedActionToken(normalized, TOKEN_SCOPES.RESUBSCRIBE, { secret, scheme, policy, now });
  const base = `${BASE_URL}/?action=resubscribe&email=${encodeURIComponent(normalized)}`;
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
 * Authenticated newsletter action link the SPA accepts: carries `email` and the
 * `ac` autologin code so App.tsx can sign the recipient in.
 *
 * ONE credential, deliberately. A draft of #5685 also appended the plain email
 * HMAC as `token`, reasoning that the exit needed a second credential once `ac`
 * starts expiring. It does not, and the addition was a straight loss:
 *
 *  - it is not needed. `verifyOptOutCredential` accepts an AUTHENTIC `ac` of any
 *    age, any revocation state, `autologin_enabled:false` included, precisely so
 *    the exit survives expiry (newsletterSubscriptionManagement.js). The
 *    fallback in App.tsx hands it the `ac` it already has;
 *  - `token` is the WIDER credential, not the narrower one. It is the gate on
 *    the entire preferences API — get_full_status (keywords, locations, sectors,
 *    cadence), create/update/delete_alert, toggle_newsletter_subscription,
 *    toggle_autologin, revoke_autologin. When #5685 was written it was ALSO one
 *    string for all of them, eternal, with no revocation watermark and no opt-out.
 *    Adding it to a link would have widened the exposure #5685 is about, in the
 *    same commit that narrows `ac`. Since #5704 the string is scoped to one
 *    action, which is what makes each of the two links below carry only the power
 *    it needs — but a preferences token is still the preference centre, so it
 *    still does not belong in a link whose job is unsubscribing.
 *
 * Where `token` legitimately belongs is the links whose ONLY power is the one it
 * grants: makeOneClickUnsubscribeUrl (RFC 8058) and makePreferencesUrl, which is
 * the preference centre by definition.
 *
 * @param {'resubscribe'|'unsubscribe'} action
 * @param {string} email
 * @param {{secret?: string, scheme?: 'legacy'|'v1', policy?: object, now?: number}} [opts] see makeUnsubscribeUrl.
 * @returns {string}
 */
export function makeAuthenticatedActionUrl(action, email, { secret } = {}) {
  const code = generateAutologinCode(email, { secret });
  const base = `${BASE_URL}/?action=${action}&email=${encodeURIComponent(email)}&utm_medium=newsletter`;
  return code ? `${base}&ac=${code}` : base;
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
 * `scheme` exists because this is the ONE minter that runs inside Cloud
 * Functions (newsletterWelcomeEmail.js), where the policy is NOT in process.env
 * — `NEWSLETTER_AC_*` is not in EMAIL_CASCADE_RC_KEYS and there is no .env in
 * functions/, so a call without it mints `legacy` forever no matter what Remote
 * Config says. Left implicit, the welcome email would have kept minting legacy
 * past NEWSLETTER_AC_LEGACY_SUNSET: every newly confirmed subscriber clicking a
 * link in the one email most of them ever get would land un-authenticated, in
 * silence, with the CI green. The caller passes the resolved policy's
 * mintScheme; the scripts/ senders read the same three parameters from
 * process.env via scripts/load-rc-env.mjs and need no argument.
 *
 * @param {string} html
 * @param {string} email
 * @param {{secret?: string, utmCampaign?: string|null, scheme?: 'legacy'|'v1'}} [opts]
 * @returns {string}
 */
export function wrapAuthenticatedHrefs(html, email, { secret, utmCampaign, scheme } = {}) {
  if (!html || !email) return html;
  const autologinCode = generateAutologinCode(email, { secret, scheme });
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
 * @param {{secret?: string, scheme?: 'legacy'|'v1', policy?: object, now?: number, fallbackUnsigned?: boolean}} [opts]
 * `secret`/`scheme`/`policy`/`now` as in makeUnsubscribeUrl.
 * `fallbackUnsigned` (default false, matching the
 * welcome-email Cloud Function's "never ship an unverifiable link" posture)
 * — set true to instead return the unsigned base URL when there's no secret,
 * matching the historical inline behavior of the weekly newsletter and job
 * alert senders (scripts/send-newsletter.mjs, scripts/send-job-alerts.mjs),
 * one of which string-concatenates this return value unguarded.
 * @returns {string|null} newsletter-preferences URL; null when there's no
 * secret and `fallbackUnsigned` is false.
 */
export function makePreferencesUrl(email, locale, { secret, scheme, policy, now, fallbackUnsigned = false } = {}) {
  // The `email` param must carry the SAME normalized form the token is signed
  // over, otherwise the handler verifies an HMAC of the lowercased address
  // against a differently-cased param. Both pre-consolidation implementations
  // (scripts/send-newsletter.mjs, scripts/send-job-alerts.mjs) normalized here;
  // dropping it would have silently broken the link for any stored address
  // that is not already lowercase. Since #5704 the normalisation is the
  // verifier's own (newsletterActionToken.js) and the other three builders share
  // it, so the two sides cannot drift apart again.
  const normalized = normalizeEmail(email);
  const token = signedActionToken(normalized, TOKEN_SCOPES.PREFERENCES, { secret, scheme, policy, now });
  const slug = PREFERENCES_SLUG[locale] || PREFERENCES_SLUG.it;
  const prefix = localePathPrefix(locale);
  const base = `${BASE_URL}${prefix}/${slug}?email=${encodeURIComponent(normalized)}`;
  if (!token) return fallbackUnsigned ? base : null;
  return `${base}&token=${token}`;
}
