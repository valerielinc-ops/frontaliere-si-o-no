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
 * @param {{secret?: string}} [opts] `secret` only, and deliberately: this
 * builder mints no `token` at all (see the note above), so the token format
 * options the other builders take would document a parameter that does not
 * exist. The `ac` scheme is the autologin policy's, threaded by
 * generateAutologinCode.
 * @returns {string}
 */
export function makeAuthenticatedActionUrl(action, email, { secret } = {}) {
  const code = generateAutologinCode(email, { secret });
  const base = `${BASE_URL}/?action=${action}&email=${encodeURIComponent(email)}&utm_medium=newsletter`;
  return code ? `${base}&ac=${code}` : base;
}

/**
 * True when an href is one of ours and may be REWRITTEN at all — our own site,
 * never mailto/tel/anchors, never static assets.
 *
 * This is the old `shouldWrapAuthenticatedHref` body, and it is deliberately no
 * longer the credential rule (#5725). Rewriting a link and handing it a
 * credential are two different questions that used to be one:
 *
 *  - "may I touch this href?" → this predicate. It still governs the utm_medium
 *    / utm_campaign rewrite, because GA4's Email channel grouping keys on
 *    utm_medium and dropping it from every content link would move the whole
 *    newsletter into `direct`;
 *  - "does this destination need a session?" → {@link autologinDestination},
 *    the fail-closed allowlist below. That is the one that decides `ne`/`ac`.
 *
 * @param {string} rawHref
 * @returns {boolean}
 */
export function isOwnRewritableHref(rawHref) {
  if (!rawHref) return false;
  if (rawHref.startsWith('mailto:') || rawHref.startsWith('tel:') || rawHref.startsWith('#')) return false;
  let url;
  try { url = new URL(rawHref, BASE_URL); } catch { return false; }
  if (url.hostname.replace(/^www\./, '') !== 'frontaliereticino.ch') return false;
  if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/icons/')) return false;
  return true;
}

/**
 * True when an href's DESTINATION needs the `ac` autologin credential.
 *
 * Kept under its historical name because that is what the name always claimed —
 * "wrap **authenticated**" — but the answer now comes from the allowlist
 * (AUTOLOGIN_DESTINATIONS), not from "is it a link of ours". See
 * {@link autologinDestination} for the whole reasoning.
 *
 * @param {string} rawHref
 * @returns {boolean}
 */
export function shouldWrapAuthenticatedHref(rawHref) {
  return autologinDestination(rawHref) !== null;
}

/**
 * Rewrite one of our own URLs for an email: campaign attribution always, the
 * `ne`/`ac` autologin pair ONLY when the destination needs a session.
 *
 * ── The perimeter (#5725) ───────────────────────────────────────────────────
 *
 * Until #5725 this function attached the credential to whatever it was handed.
 * #5719 had given `ac` a lifetime; it had not given it a perimeter, so every
 * link in a message — article, hub, search page, home page — carried a code
 * that mints a Firebase session, towards pages that do nothing with one. A TTL
 * shortens how long each copy is useful; it does not reduce how MANY copies are
 * deposited in the provider's click log, in the recipient's anti-phishing
 * scanner, in every forward and every corporate mail archive.
 *
 * So the credential is now fail-closed. It rides along in exactly two cases:
 *
 *  1. the destination is in AUTOLOGIN_DESTINATIONS — the allowlist at the
 *     bottom of this file, which is DATA, one entry per destination class with
 *     the reason it needs a session written next to it;
 *  2. the caller passes `sessionGated: '<reason>'` — a non-empty string, not a
 *     boolean, so the justification is greppable and shows up in review.
 *
 * Anything else — including a destination nobody has thought about yet — gets
 * utm_* and nothing else. That asymmetry is the whole point: with the old
 * denylist a NEW page was born carrying the credential and someone had to
 * notice; with the allowlist it is born without one and someone has to decide.
 *
 * `sessionGated` exists because one class of destination genuinely needs the
 * session and cannot be recognised from its path here: a job DETAIL page. It
 * sits behind `hasAccess` in components/community/JobBoard.tsx
 * (`isLoggedIn || emailAccessGranted || isCrawlerVisitor`), and its own render
 * path holds a skeleton while an autologin exchange is in flight precisely so
 * the sign-in gate never flashes for a reader arriving from an alert. Its URL
 * is `<locale>/<canton job-board section>/<slug>`, and the 26x4 section table
 * lives in data/canton-url-slugs.json — unreachable from functions/ (no
 * bundler, no repo-root reads, the same boundary that put PREFERENCES_SLUG
 * below in this file as a runtime copy). The senders that build those links
 * DO know what they are building, so they say so.
 *
 * `ne`/`ac` are deliberately short: Mailgun silently drops click tracking for
 * href values >= 1000 characters.
 *
 * utm_medium defaults to 'newsletter' because GA4's Email channel grouping keys
 * on it; pass utmCampaign to keep campaigns separable within that channel.
 * Job alerts override both: they use 'email' (medium = channel, source =
 * identifier) and must keep the utm_medium their utmBase already set. The
 * attribution rewrite is deliberately NOT gated on the perimeter — dropping
 * utm_medium from every content link would move the whole email channel into
 * GA4's `direct` bucket, which is a reporting outage traded for nothing.
 *
 * @param {string} targetUrl absolute or site-relative
 * @param {string} email
 * @param {object} [opts]
 * @param {string} [opts.secret] signing secret; falls back to
 *   process.env.NEWSLETTER_SECRET, read at call time.
 * @param {string|null} [opts.autologinCode] reuse a code already generated for
 *   this recipient instead of computing another HMAC. Only consulted when the
 *   destination is inside the perimeter — an out-of-perimeter link never emits
 *   the code it was handed.
 * @param {string|null} [opts.utmCampaign] added as utm_campaign when set.
 * @param {string} [opts.utmMedium='newsletter'] value written to utm_medium.
 * @param {boolean} [opts.preserveExistingUtmMedium=false] when true, leave a
 *   utm_medium already present on targetUrl untouched.
 * @param {string} [opts.sessionGated] non-empty reason string that opts ONE
 *   call site into the credential for a destination the allowlist cannot
 *   recognise. A boolean, an empty string or a whitespace-only string is
 *   ignored on purpose: `sessionGated: true` would be a switch, and this has to
 *   be an argument.
 * @returns {string}
 */
export function makeAuthenticatedUrl(
  targetUrl,
  email,
  {
    secret,
    autologinCode,
    utmCampaign,
    utmMedium = 'newsletter',
    preserveExistingUtmMedium = false,
    sessionGated,
  } = {},
) {
  const url = new URL(targetUrl, BASE_URL);
  // The declaration widens the perimeter by one DESTINATION, never past the
  // host: a reason string is a statement about one of our pages, and an href
  // that left our domain is the worst case in #5725, not a case a comment can
  // authorise. `autologinDestination` applies the same host/asset guard to the
  // allowlist branch, so both roads go through it.
  const ownDestination = isOwnRewritableHref(url.toString());
  const declaredByCaller =
    ownDestination && typeof sessionGated === 'string' && sessionGated.trim().length > 0;
  const insidePerimeter = declaredByCaller || autologinDestination(url) !== null;
  if (insidePerimeter) {
    // Resolved INSIDE the branch: an out-of-perimeter link must not even mint a
    // code, so a sender that stopped needing one stops paying for the HMAC too.
    const code = autologinCode === undefined ? generateAutologinCode(email, { secret }) : autologinCode;
    // `ne` goes with `ac`, not with the link. On its own it is the recipient's
    // address in a query string that the provider's click log, Cloud Run's
    // request log (#5746) and every scanner keep verbatim, in exchange for
    // nothing: no page reads `ne` without a credential beside it
    // (services/newsletterAutologinSignal.ts needs both).
    url.searchParams.set('ne', String(email || '').toLowerCase());
    if (code) url.searchParams.set('ac', code);
  }
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
    // isOwnRewritableHref, not shouldWrapAuthenticatedHref: this decides whether
    // the href may be touched at all (utm_*), and makeAuthenticatedUrl decides
    // on its own whether the destination is inside the credential perimeter
    // (#5725). A body-level rewrite has no idea what any given href is for, and
    // "no idea" resolves to "no credential" by construction — there is no
    // sessionGated argument here and there deliberately cannot be one.
    if (!isOwnRewritableHref(href)) return whole;
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

// ── The autologin perimeter (#5725) ─────────────────────────────────────────
//
// #5719 gave the `ac` code a LIFETIME. This is its PERIMETER, and the two are
// orthogonal: a TTL shortens how long a leaked copy is useful, an allowlist
// reduces how many copies are created. Measured on `main` before this change, a
// job-alert message deposited a session-minting credential on up to twelve
// links, eleven of which pointed at pages that do nothing with a session.
//
// It is an ALLOWLIST, and that direction is the whole fix. The old rule was a
// denylist — "ours, and not mailto/tel/#/images" — under which a page that did
// not exist yet was born WITH the credential and stayed that way until somebody
// noticed. Under an allowlist it is born without one, and adding it is a
// deliberate edit to the table below, in a diff a reviewer reads.
//
// Membership is not "is this page ours" and not "is this page important". It is
// exactly one question: DOES THIS DESTINATION DO SOMETHING DIFFERENT FOR A
// SIGNED-IN READER? Every entry answers it in its own `why`, and every `why`
// names the code that proves it. A destination whose answer is "it renders the
// same either way" — an article, a search page, a canton hub, a job-board
// landing, the home page — belongs outside, however central it is to the email.
//
// The table is data on purpose. #5725 asks for "la lista dei percorsi
// autenticati come dato esplicito e non come effetto collaterale di una regex",
// because the previous shape hid the decision inside a boolean expression that
// no test could enumerate. tests/newsletter-autologin-perimeter.test.ts walks
// this array.

/**
 * Locale prefixes the site serves. IT is at the root, so it has no prefix —
 * same rule makePreferencesUrl's `localePathPrefix` applies.
 */
const LOCALE_PREFIXES = new Set(['en', 'de', 'fr']);

/**
 * RUNTIME COPY of services/routeSlugs.data.ts's `followedCompanies` column,
 * here for the same reason PREFERENCES_SLUG is: Cloud Functions cannot import
 * a TypeScript module from the repo root. scripts/send-company-alerts.mjs holds
 * a third copy of the `it` slug alone, with its own drift assertion in
 * tests/company-alert.test.ts. Guarded here by "followed-companies slug table"
 * in tests/newsletter-autologin-perimeter.test.ts, which imports this table and
 * SLUG_TABLES and fails when they disagree — a rename in one without the other
 * would not 404, it would silently drop the page out of the perimeter, which is
 * strictly worse because the link still works and just stops signing anyone in.
 */
export const FOLLOWED_COMPANIES_SLUG = {
  it: 'aziende-seguite',
  en: 'followed-companies',
  de: 'gefolgte-unternehmen',
  fr: 'entreprises-suivies',
};

/** Path segments, lowercased, empties dropped. */
function pathSegments(pathname) {
  return String(pathname || '')
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/**
 * The site root, in any locale: `/`, `/en/`, `/de`, … A trailing slash is not
 * significant and neither is case; both appear in the wild because these URLs
 * are assembled by string concatenation in several senders.
 */
function isSiteRoot(pathname) {
  const segments = pathSegments(pathname);
  return segments.length === 0 || (segments.length === 1 && LOCALE_PREFIXES.has(segments[0]));
}

/** Last path segment, lowercased — `''` for the root. */
function lastSegment(pathname) {
  const segments = pathSegments(pathname);
  return segments.length ? segments[segments.length - 1] : '';
}

/**
 * The allowlist. One entry per destination class; `matches` receives a parsed
 * URL already known to be on our host.
 *
 * @type {ReadonlyArray<{id: string, why: string, matches: (url: URL) => boolean}>}
 */
export const AUTOLOGIN_DESTINATIONS = Object.freeze([
  Object.freeze({
    id: 'spa-action',
    why:
      'The site root with ?action=unsubscribe|resubscribe is decided client-side by '
      + 'App.tsx, which reads the credential out of the query string via '
      + 'parseNewsletterAutologin and refuses the link without it ("Link non valido"). '
      + 'The server answers 200 with the home page either way, so this is also the one '
      + 'destination whose breakage no HTTP check can ever see — emailLinkAudit.js '
      + 'reports it statically as `spa_action_without_ac`. Bare `/` is NOT in: the '
      + 'home page with no action is the single most linked public page in every send.',
    matches: (url) => isSiteRoot(url.pathname) && url.searchParams.has('action'),
  }),
  Object.freeze({
    id: 'newsletter-preferences',
    why:
      'The preference centre is the subscriber\'s own record — keywords, locations, '
      + 'cadence, per-channel switches, autologin, revocation. It is the destination '
      + '#5685 and #5725 both name as legitimately needing the credential, and the one '
      + 'link in a job alert (send-job-alerts.mjs, `manageUrl`) that keeps it.',
    matches: (url) => Object.values(PREFERENCES_SLUG).includes(lastSegment(url.pathname)),
  }),
  Object.freeze({
    id: 'followed-companies',
    why:
      'components/pages/FollowedCompaniesPage.tsx lists what the SIGNED-IN user '
      + 'follows; signed out it has nothing to render. scripts/send-company-alerts.mjs '
      + 'points its «gestisci le aziende seguite» link here precisely because the '
      + 'credential makes the deep link land on the page the email is about instead of '
      + 'on the preference centre.',
    matches: (url) => Object.values(FOLLOWED_COMPANIES_SLUG).includes(lastSegment(url.pathname)),
  }),
]);

/**
 * Which allowlist entry claims this href, or null.
 *
 * Fail-closed at every step: an href we cannot parse, one on somebody else's
 * host, an asset, a `mailto:`/`tel:`/`#` — all null, so an external absolute URL
 * can never receive the credential no matter which builder is handed it. That
 * case is the worst one to get wrong and therefore the first one asserted.
 *
 * @param {string|URL} hrefOrUrl
 * @returns {{id: string, why: string}|null}
 */
export function autologinDestination(hrefOrUrl) {
  let url;
  if (hrefOrUrl instanceof URL) {
    url = hrefOrUrl;
  } else {
    if (!isOwnRewritableHref(hrefOrUrl)) return null;
    try { url = new URL(hrefOrUrl, BASE_URL); } catch { return null; }
  }
  if (url.hostname.replace(/^www\./, '') !== 'frontaliereticino.ch') return null;
  if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/icons/')) return null;
  const entry = AUTOLOGIN_DESTINATIONS.find((d) => {
    try { return d.matches(url); } catch { return false; }
  });
  return entry ? { id: entry.id, why: entry.why } : null;
}
