/**
 * Pure decision logic shared by the batch backfill script
 * (`scripts/backfill-jobalerts-from-newsletter.mjs`, via the
 * `scripts/lib/jobalert-backfill-core.mjs` shim) and the real-time
 * `onDocumentWritten` trigger (`jobAlertBackfillTrigger.js`) that fires on
 * every `newsletter_subscribers/{email}` write going forward.
 *
 * Canonical here (not in `services/`) because Cloud Functions have no
 * bundler and cannot import anything outside `functions/`.
 *
 * REGISTRATION RELATIONSHIP — READ THIS BEFORE THE TIER DOCUMENTATION BELOW
 * -----------------------------------------------------------------------
 * Measured on production 2026-08-12: of 7.745 documents in the `alerts`
 * subcollection, 7.167 were created by this module and 578 by a person using
 * `createAlert` (services/jobAlertService.ts). 6.308 of the inferred ones were
 * still active, and 71 were created on that same day — this was not a historic
 * one-off, it was still running.
 *
 * The four signal tiers below are **context**, not separate consent events.
 * They determine the initial criteria and provenance for the base job-alert
 * relationship established by the registration terms. Every terms-based
 * registration gets one `backfill-newsletter` alert, including a broad
 * empty-filter alert when no signal is available yet. The alert is then
 * progressively ranked and enriched by searches, visited jobs and clicks.
 * Explicit global or address-level suppression remains a hard stop.
 *
 * Why `onDocumentWritten`, not `onDocumentCreated`: on every social sign-in
 * (Google/Facebook/LinkedIn/One-Tap), `saveUserProfileToFirestore`
 * (services/authService.ts) fires an un-awaited `setDoc(..., {merge:true})`
 * with only auth fields (no job/location signal), racing the full
 * `upsertNewsletterSubscriber` write that carries the real signal fields —
 * and the bare write structurally tends to land first (fewer awaits, no
 * pre-read). A one-shot `onDocumentCreated` would see zero signal at create
 * time and skip the subscriber permanently, since the later merge is an
 * UPDATE the create-hook never sees. `signalTierChanged` (below) lets the
 * write-hook re-evaluate on every write cheaply (pure field diff, no
 * Firestore read) and only do real work when eligibility actually flips —
 * which both catches the delayed signal and keeps routine engagement writes
 * (open/click tracking) a no-op.
 *
 * Signal tiers, cheapest-first:
 *  1. `job_category`/`job_location`/`sector_interest` — explicit job-search
 *     intent, whether captured with job-page context (job_gate unlock,
 *     JobBoard social sign-in with a job in progress) or from a standalone
 *     sector pick with no job in progress (e.g. a newsletter-signup sector
 *     selector). `sector_interest` alone used to fall through to
 *     'no-signal' and skip alert creation entirely — same strength of
 *     intent as `job_category`, so it belongs in tier 1, not a weaker
 *     fallback. `buildAlertProfile` (services/jobAlertMatching.mjs) turns
 *     all three into soft keyword/sector tokens automatically.
 *  2. `location_interest`/`geo_city` — generic location signal with no job
 *     context (IP-geolocated city, a location preference picked elsewhere).
 *     Live count against prod newsletter_subscribers (2026-07-03) found this
 *     tier adds only ~5 subscribers beyond tier 1 — most no-signal docs have
 *     no geo data at all — but it's a correct, zero-cost fallback so it's
 *     kept: `buildAlertProfile` already reads these same fields into
 *     preferredLocations/preferredCantons as a SOFT ranking signal, so a
 *     tier-2 alert becomes a broad "jobs near you" digest rather than a
 *     precise match — never a hard filter (`cantonFilter` stays null).
 *  3. `personalization-fallback` — when tiers 1/2 are both empty, fall back to
 *     the `private/personalization` subcollection (services/behaviorTracker.ts:
 *     `viewedJobs[]`, on-site `filterUsage`), via the same no-clobber
 *     `derivePersonalizationPatch` (`lib/subscriberPersonalization.js`) the
 *     daily send-job-alerts.mjs enrichment already uses for subscribers who
 *     HAVE an alert — this tier just lets it also decide whether to CREATE
 *     the first one. Real, structured signal (a job's actual category/city
 *     the subscriber viewed), not a generic proximity fallback like tier 2 —
 *     found live (2026-07-03) on subscribers who signed up outside any job
 *     context (calculator, generic popup) but later browsed jobs while
 *     logged in, e.g. a specific job-detail page visit that never populated
 *     `job_category`/`job_location` at signup time. The derived patch is
 *     merged onto the subscriber doc (see `jobAlertBackfillTrigger.js`) so
 *     `buildAlertProfile` benefits from it immediately, not just on the next
 *     manual enrichment pass. A patch carrying ONLY `job_search_query` (no
 *     category/location resolved from it) still counts — `buildAlertProfile`
 *     (services/jobAlertMatching.mjs) actively folds it into soft keyword
 *     tokens, it's not write-only data.
 *  4. `url-fallback` — weakest tier, tried only when tier 3 also finds
 *     nothing: derive a canton from `consent_source_url`/`source_page` when
 *     it points at a single-canton job-board page (`/cerca-lavoro-ticino/…`,
 *     `/fr/trouver-emploi-valais/…`). Live (2026-07-03): 151 of the 523
 *     remaining no-signal subscribers landed on exactly such a page — signup
 *     happened via a generic channel (auth popup, newsletter box) on top of
 *     a job listing, so the canton is right there in the URL and never made
 *     it into a flat field. Written as a bare lowercase 2-letter code
 *     (`location_interest: 'ti'`), the shape `buildAlertProfile` already
 *     recognizes as a canton via its own `SWISS_CANTONS` check — a soft
 *     ranking signal like tier 2, never a hard `cantonFilter`. Half-canton
 *     URL groups (`jobs-im-tessin`'s siblings `APPENZELLO`/`BASILEA`) and the
 *     Switzerland-wide aggregator are deliberately skipped as too ambiguous
 *     or too broad — see `lib/jobBoardUrlCanton.js`.
 */

import { isCrossChannelStop, isNewsletterExcluded } from './lib/emailSuppression.js';
import { isNewsletterOptOutBinding } from './lib/newsletterOptOut.js';
import { derivePersonalizationPatch } from './lib/subscriberPersonalization.js';
import { deriveCantonFromJobBoardUrl } from './lib/jobBoardUrlCanton.js';
import { resolveSubscriberLocale } from './lib/subscriberLocale.js';

export const MAX_ALERTS_PER_USER = 10; // mirrors services/jobAlertService.ts (#5012)
export const ALERT_ID = 'backfill-newsletter';

export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {'signal'|'location-fallback'|'none'}
 */
export function getSignalTier(data) {
  const category = String(data?.job_category || '').trim();
  const location = String(data?.job_location || '').trim();
  const sector = String(data?.sector_interest || '').trim();
  if (category || location || sector) return 'signal';
  const locationInterest = String(data?.location_interest || '').trim();
  const geoCity = String(data?.geo_city || '').trim();
  if (locationInterest || geoCity) return 'location-fallback';
  return 'none';
}

/**
 * True when the signal tier differs between the doc's prior and new state —
 * i.e. this write is the one that actually made (or unmade) eligibility,
 * not an unrelated field update (auth profile fields, engagement tracking).
 * `beforeData` is null on doc creation (treated as tier 'none').
 *
 * Flat-field only (does not consider `private/personalization`) — that
 * subcollection is a separate document the parent-doc trigger never sees;
 * its own eligibility path is `backfillJobAlertOnPersonalizationSync`
 * (functions/index.js), gated separately since it fires on a different path.
 * @param {Record<string, unknown>|null} beforeData
 * @param {Record<string, unknown>|null|undefined} afterData
 * @returns {boolean}
 */
export function signalTierChanged(beforeData, afterData) {
  const beforeTier = beforeData ? getCheapSignalTier(beforeData) : 'none';
  return getCheapSignalTier(afterData) !== beforeTier;
}

/**
 * Tiers 1/2/4 — everything resolvable WITHOUT a `private/personalization`
 * read (tier 3 needs that subdoc, fetched separately, see
 * `backfillJobAlertOnPersonalizationSync`). Used only to gate the flat-doc
 * write trigger cheaply; never for tier SELECTION — `resolveSignalTier`
 * below keeps tier 3 (personalization, richer signal) checked ahead of
 * tier 4 (URL, weaker) regardless of what this function returns.
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {'signal'|'location-fallback'|'url-fallback'|'none'}
 */
function getCheapSignalTier(data) {
  const tier = getSignalTier(data);
  if (tier !== 'none') return tier;
  return deriveCantonFromJobBoardUrl(data?.consent_source_url) || deriveCantonFromJobBoardUrl(data?.source_page)
    ? 'url-fallback'
    : 'none';
}

/**
 * Tier resolution with the weaker fallbacks layered on top of
 * `getSignalTier`: when the flat fields carry nothing, try the
 * `private/personalization` subdoc (tier 3), then the job-board URL the
 * subscriber landed on (tier 4). Returns the patch too so callers can merge
 * it onto the subscriber doc — see tier rationale in the file header.
 * @param {Record<string, unknown>|null|undefined} data
 * @param {Record<string, unknown>|null|undefined} [personalization]
 * @returns {{tier: 'signal'|'location-fallback'|'personalization-fallback'|'url-fallback'|'none', patch: Record<string, string>|null}}
 */
export function resolveSignalTier(data, personalization) {
  const tier = getSignalTier(data);
  if (tier !== 'none') return { tier, patch: null };

  // `derivePersonalizationPatch` already guarantees a non-null return has at
  // least one non-blank field (see its own `Object.keys(patch).length > 0`
  // check) — so `if (patch)` alone is correct and complete. A prior version
  // of this check instead named 4 of the 6 `PERSONALIZATION_FIELDS`
  // (`job_category`/`location_interest`/`geo_city`/`job_search_query`),
  // silently dropping any patch whose ONLY derived field was `job_company` or
  // `sector_interest` — e.g. a subscriber who clicked a specific employer's
  // job (the strongest signal this module derives, `CLICK_WEIGHT`) but has no
  // location/category signal at all would fall through to a weaker tier or
  // 'none', losing real derived data instead of using it.
  const patch = derivePersonalizationPatch({ subscriber: data, personalization, alerts: [] });
  if (patch) {
    return { tier: 'personalization-fallback', patch };
  }

  const urlCanton = deriveCantonFromJobBoardUrl(data?.consent_source_url) || deriveCantonFromJobBoardUrl(data?.source_page);
  if (urlCanton) {
    return { tier: 'url-fallback', patch: { location_interest: urlCanton } };
  }

  return { tier: 'none', patch: null };
}

/**
 * The acts, as recorded in `consent_act` (services/consentTexts.ts), that are
 * the data subject's own affirmative request.
 *
 * `authentication` is excluded because signing in to use a service is not an
 * opt-in to mail — the register says so in the entries themselves ("nessuna
 * casella di consenso è stata proposta"). `email_link_click` is excluded
 * because a click is evidence of a fetch, not of a human: measured on this
 * domain, corporate anti-phishing scanners opened 35 links on one send, 25 of
 * them inside 7 seconds (see `resubscribeLink` in that register).
 */
export const AFFIRMATIVE_CONSENT_ACTS = Object.freeze([
  'typed_email_submit',
  'email_checkbox_submit',
]);

/**
 * Phrases that name the job-alert CHANNEL — the thing being subscribed to.
 *
 * Deliberately NOT "annunci/offerte di lavoro" (job ads / job offers): those
 * name the CONTENT a page shows, and appear in gate formulas about unlocking a
 * listing, which is not a request to be mailed daily. Fail-closed means the
 * phrase has to name the mailing, not its subject matter.
 *
 * Matched after `normalizeConsentText` below, so hyphenated and typographic
 * variants ("Job-Alerts", "alertes d’emploi") need no separate entry.
 */
const JOB_ALERT_CONSENT_PHRASES = Object.freeze([
  'avvisi di lavoro', // it
  'avviso di lavoro',
  'job alert', // en, and de "Job-Alerts" once hyphens are spaces
  'stellenbenachrichtigung', // de, covers the -en plural
  'job benachrichtigung',
  'alertes emploi', // fr
  "alertes d'emploi",
  "alerte d'emploi",
]);

/**
 * Lowercase, unify the apostrophes and the dash family, collapse whitespace.
 * Non-strings collapse to '' so every caller fails closed on a missing field.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeConsentText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[-‐-―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the verbatim disclosure stored on the subscriber document names
 * the job-alert channel. Scope check only — it says nothing about whether the
 * person agreed, which is what `hasAffirmativeJobAlertConsent` adds.
 * @param {unknown} rawText the stored `consent_text`
 * @returns {boolean}
 */
export function consentNamesJobAlerts(rawText) {
  const text = normalizeConsentText(rawText);
  if (!text) return false;
  return JOB_ALERT_CONSENT_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * Historical telemetry helper for the former job-alert gate (#5705).
 *
 * This predicate is deliberately no longer called by the live trigger or any
 * sender. Registration terms establish the base relationship; keeping this
 * helper lets audits distinguish old records that carried an affirmative,
 * job-alert-specific act from the new terms-based registrations.
 *
 * The old predicate had five conditions, every one of them fail-closed:
 *
 *  1. `consent_given === true` — an affirmative opt-in was recorded.
 *     `captureNewsletterSubscriber` (services/newsletterSubscribers.ts)
 *     defaults this to `false`, and `consentProof` deliberately does not hand
 *     callers a `consentGiven` to set, precisely so the flag stays countable.
 *  2. `consent_text` names the job-alert channel — a formula that does not
 *     disclose it cannot authorize this channel.
 *  3. `consent_text_displayed === true` — nobody can agree to a sentence they
 *     were never shown. Historical channel-specific entries remain
 *     `displayed: false`; the live unified `communicationsOptIn` entry is
 *     displayed and is the only formula intended to pass this condition.
 *  4. `consent_act` is one of `AFFIRMATIVE_CONSENT_ACTS` — an authentication
 *     or a link fetch is not a request.
 *  5. `preferences.jobs === true` — the unified relationship enables the jobs
 *     category; a historical text alone is not enough.
 *
 * @param {Record<string, unknown>|null|undefined} data a `newsletter_subscribers` doc
 * @returns {boolean}
 */
export function hasAffirmativeJobAlertConsent(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.consent_given !== true) return false;
  if (data.consent_text_displayed !== true) return false;
  if (!AFFIRMATIVE_CONSENT_ACTS.includes(String(data.consent_act ?? ''))) return false;
  // A generic newsletter capture may name the job-alert category without
  // activating it. The jobs preference is the explicit signal that this
  // particular relationship may govern job-alert delivery.
  if (data.preferences?.jobs !== true) return false;
  return consentNamesJobAlerts(data.consent_text);
}

const BACKFILL_MARKER_FIELDS = Object.freeze(['backfilled_from', 'backfilledFrom']);
const JOB_ALERT_PROOF_ACTS = Object.freeze([
  'typed_email_submit',
  'job_alert_activation_click',
  'communications_banner_confirm_click',
]);
const JOB_ALERT_PROOF_ORIGINS = Object.freeze([
  'backfill_upgraded_by_explicit_act',
  'communications_consent_banner',
]);

function firstNonBlank(data, fields) {
  if (!data || typeof data !== 'object') return null;
  for (const field of fields) {
    const value = data[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * True only for alerts manufactured from a newsletter subscriber profile.
 * Explicit alerts created through the job-alert UI have no such marker and
 * keep their own consent basis; the sender must not make newsletter consent a
 * prerequisite for those alerts.
 */
export function isBackfilledJobAlert(data) {
  return firstNonBlank(data, BACKFILL_MARKER_FIELDS) != null;
}

/**
 * A proof written on an existing backfilled alert by an explicit activation or
 * communications-banner act, or carried by a genuine alert-specific signup.
 * A bare `consent_text` is not enough: it may describe another channel, and
 * treating it as job-alert consent would recreate the original inference.
 */
export function hasStoredJobAlertConsent(data) {
  if (!data || typeof data !== 'object') return false;
  const text = firstNonBlank(data, ['consent_text', 'consentText']);
  if (!text || data.consent_text_displayed !== true) return false;

  const act = String(data.consent_act ?? data.consentAct ?? '').trim();
  if (!JOB_ALERT_PROOF_ACTS.includes(act)) return false;

  // A typed signup must name the job-alert channel. The two explicit upgrade
  // paths carry a server-defined origin and the communications sentence points
  // to the page that names every channel, including job alerts.
  const origin = String(data.consent_origin ?? data.consentOrigin ?? '').trim();
  return consentNamesJobAlerts(text) || JOB_ALERT_PROOF_ORIGINS.includes(origin);
}

/**
 * Sender-side authorization for one alert. Each sender still applies its
 * shared cross-channel and channel-local suppression predicates separately.
 * Registration terms establish the base relationship; this helper only
 * prevents delivery after an explicit global/address-level stop and labels
 * the alert's provenance for diagnostics.
 */
export function evaluateJobAlertConsent({ alert, subscriber }) {
  // The registration terms establish the base relationship. This function is
  // no longer a consent gate: it only protects the sender from an explicit
  // global/address-level stop when the subscriber document is available.
  if (subscriber && isCrossChannelStop(subscriber)) {
    return { allowed: false, reason: 'cross-channel-stop' };
  }
  return {
    allowed: true,
    reason: isBackfilledJobAlert(alert) ? 'backfill-registration-terms' : 'explicit-alert',
  };
}

/**
 * Pure eligibility check for one `newsletter_subscribers` doc. Pass
 * `personalization` (the `private/personalization` subdoc, if read) to also
 * consider the browsing-derived fallback tier; omit it to check flat fields
 * only — safe default, since deriving from an absent doc naturally yields
 * no patch and behaves exactly like the flat-field-only check.
 *
 * The registration terms create the base relationship; only suppression remains
 * a creation gate. A no-signal registration intentionally creates a broad
 * backfill alert so later behaviour can refine it.
 * @returns {'invalid-email'|'suppressed'|null} skip reason, null = eligible.
 */
export function shouldSkipSubscriber(email, data, personalization = null) {
  if (!email || !email.includes('@')) return 'invalid-email';
  // An explicit newsletter opt-out, hard address signal or legacy stop-all
  // prevents a new base relationship from being created. An opt-out does not
  // delete an already-created concrete job alert; the alert sender applies the
  // same shared stop before delivery.
  if (
    isNewsletterExcluded(data?.status)
    || isNewsletterOptOutBinding(data)
    || isCrossChannelStop(data)
  ) return 'suppressed';
  return null;
}

/**
 * Pure payload builder — no Firestore I/O, no serverTimestamp (callers stamp
 * `createdAt`/`backfilled_at`/`updated_at` after this returns, so the shape
 * stays testable without mocking firebase-admin).
 *
 * `existingBackfill` is the full prior `backfill-newsletter` doc data (or
 * null on first creation). Its `active` flag is carried forward as-is so a
 * re-run/re-trigger never undoes a user's explicit unsubscribe (`deleteAlert`
 * sets `active: false`) — only a brand-new doc defaults to `active: true`.
 *
 * `frequency` is carried forward for the same reason, and it was NOT (#5684).
 * The caller merges this payload onto the existing alert doc, so a hardcoded
 * `'daily'` silently overwrote whatever cadence the reader had chosen in the
 * preference centre — and because the centre also sets `frequencyOverride:
 * true` (which this payload does not carry and merge therefore preserves),
 * scripts/lib/jobAlertEngagementTier.mjs then read the pair as "the user
 * pinned daily on purpose" and stopped adapting. A re-trigger needs no new
 * subscription: getCheapSignalTier derives its tier from `consent_source_url`,
 * which a plain login rewrites to the current page URL. Net effect measured
 * from the source: set "weekly" in the centre, log in from a job-board page,
 * receive daily. Only a brand-new doc defaults to 'daily'.
 *
 * Pass `personalization` to also consider the tier-3 fallback (see
 * `resolveSignalTier`); omit it for flat-field-only tiers 1/2.
 */
export function buildAlertPayload(email, data, existingBackfill, personalization = null) {
  const { tier } = resolveSignalTier(data, personalization);
  const channel = data?.source_channel || 'unknown';
  const hasJobContext = Boolean(
    data?.job_search_query
    || data?.job_category
    || data?.job_title
    || data?.job_location
    || data?.job_slug
  );
  const isJobBoardRegistration = String(channel).toLowerCase() === 'job_gate'
    || String(channel).toLowerCase().includes('job_board')
    || hasJobContext;
  const contextKeywords = isJobBoardRegistration
    ? [...new Set([
      data?.job_search_query,
      data?.job_category,
      data?.job_title,
    ].map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  const contextLocations = isJobBoardRegistration && data?.job_location
    ? [String(data.job_location).trim()]
    : [];
  const contextSectors = isJobBoardRegistration && data?.sector_interest
    ? [String(data.sector_interest).trim()]
    : [];
  const existingKeywords = Array.isArray(existingBackfill?.keywords) ? existingBackfill.keywords : [];
  const existingLocations = Array.isArray(existingBackfill?.locations) ? existingBackfill.locations : [];
  const existingSectors = Array.isArray(existingBackfill?.sectors) ? existingBackfill.sectors : [];
  const tierSuffix =
    tier === 'location-fallback' || tier === 'personalization-fallback' || tier === 'url-fallback'
      ? `:${tier}`
      : '';
  return {
    email,
    userId: data?.user_id || null,
    // A job-board registration starts from the exact job/search context that
    // opened the gate. Newsletter registrations intentionally stay broad and
    // use the evolving profile/personalization signals instead.
    keywords: existingKeywords.length > 0 ? existingKeywords : contextKeywords,
    locations: existingLocations.length > 0 ? existingLocations : contextLocations,
    contractTypes: [],
    sectors: existingSectors.length > 0 ? existingSectors : contextSectors,
    cantonFilter: null,
    frequency: typeof existingBackfill?.frequency === 'string' && existingBackfill.frequency
      ? existingBackfill.frequency
      : 'daily',
    locale: resolveSubscriberLocale(data),
    sourceJobSlug: data?.job_slug || null,
    sourceJobUrl: null,
    sourceJobTitle: data?.job_title || null,
    specificJobId: null,
    specificCompanyKey: null,
    active: existingBackfill ? existingBackfill.active !== false : true,
    matchCount: existingBackfill?.matchCount || 0,
    lastMatchedAt: existingBackfill?.lastMatchedAt || null,
    // Provenance — lets a future audit tell inferred alerts apart from
    // explicit ones, see which signup channel triggered it, and which
    // signal tier it was built from.
    backfilled_from: `newsletter_subscribers:${channel}${tierSuffix}`,
  };
}
