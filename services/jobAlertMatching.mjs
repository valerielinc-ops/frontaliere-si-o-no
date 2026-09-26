/**
 * Job-alert targeted matching heuristic.
 *
 * Upgrades the legacy binary substring matcher (scripts/send-job-alerts.mjs)
 * into a multi-signal relevance score that combines EVERY piece of intent we
 * already store about a subscriber — not just the keywords they typed:
 *
 *   1. Explicit alert keywords      → HARD filter (legacy contract preserved).
 *   2. Source-job intent            → tokens from `sourceJobTitle` / `sourceJobSlug`,
 *                                      i.e. the job the user was viewing when they
 *                                      one-tap-subscribed. Stored since FRO-333 but
 *                                      previously UNUSED for matching.
 *   3. Newsletter subscriber profile → `job_company`, `job_category`,
 *                                      `job_search_query`, `sector_interest`,
 *                                      `location_interest`, `job_location`,
 *                                      `geo_city`, and the city `preferences`
 *                                      flags (lugano/bellinzona/mendrisio/chiasso).
 *   4. Progressive-enrichment profile → `workPosition` (soft tokens, same
 *                                      treatment as `sourceJobTitle`) and
 *                                      `municipality` (resolved to its
 *                                      commute-canton affinity — soft
 *                                      `preferredCantons` signal only).
 *
 * Why this matters: a "one-tap" subscriber (no typed keywords, just a
 * `sourceJobSlug`) used to match EVERY recent job — keywords were the only
 * filter, and an empty keyword list disabled it. Their daily email was a random
 * dump. By deriving soft keywords + company + sector from the job they engaged
 * with (and from their newsletter profile), we now require at least one targeted
 * signal before a job surfaces, and we rank the closest matches to the top.
 *
 * The functions here are PURE (no Firestore / IO) so they can be unit-tested
 * directly — see tests/job-alert-matching.test.ts.
 */

import { extractKeywords } from './newsletter-content.mjs';
import {
  expandKeywordsWithSynonymPhrases,
  professionSynonymText,
} from './professionSynonymsCore.mjs';
import {
  canonicalCompanyProfileSlug,
  companyDisplayIdentityKeys,
} from '../build-plugins/shared/companyProfileSlug.mjs';
import { normalizeLocToken } from './locToken.mjs';
import { municipalityToCantons } from './provinceCantonAffinity.ts';
import {
 activeApplicationIntentJobKeys,
 buildApplicationIntentJobKey,
 ALERT_APPLICATION_INTENT_BOOST,
} from './applicationIntentRanking.mjs';

/** @typedef {Set<string>} TokenSet */

/**
 * The 26 Swiss canton codes (lowercased). Used to recognize a 2-letter canton
 * token among the profile's preferred-location signals (a source/clicked job's
 * geography is stored as `[location, canton]`, so "ti" arrives as a raw signal
 * and must resolve to itself, not be looked up as a city).
 *
 * Deliberately a small local copy, not an import of the canonical
 * `TARGET_CANTONS` (scripts/lib/crawler-location-config.mjs): that 600-line
 * crawler-config module would pull a cross-layer (services → scripts/lib)
 * dependency into the matcher for one fixed fact. The set of cantons is
 * constant (zero drift risk), so duplication is safe here.
 */
const SWISS_CANTONS = new Set([
  'zh', 'be', 'lu', 'ur', 'sz', 'ow', 'nw', 'gl', 'zg', 'fr', 'so', 'bs', 'bl',
  'sh', 'ar', 'ai', 'sg', 'gr', 'ag', 'tg', 'ti', 'vd', 'vs', 'ne', 'ge', 'ju',
]);

/**
 * Minimum number of in-area matches required before {@link partitionByGeoPreference}
 * drops out-of-area jobs entirely. Below this floor the email is padded with
 * out-of-area matches so a subscriber with few local jobs is never starved.
 */
export const GEO_PREFERENCE_MIN_LOCAL = 5;

/**
 * Freshness-boost windows for {@link freshnessBoost}. The 48h outer window
 * deliberately matches the "✨ NUOVA" badge window in the alert email
 * (send-job-alerts.mjs) so a boosted job and a badged job are the same thing.
 */
export const FRESHNESS_BOOST_24H_MS = 24 * 60 * 60 * 1000;
export const FRESHNESS_BOOST_48H_MS = 48 * 60 * 60 * 1000;

/**
 * Relevance bonus for GENUINELY new jobs, keyed on `firstSeenAt` — the only
 * recency field the crawlers set once and never refresh (`crawledAt` updates on
 * every re-crawl, `postedDate` is employer-declared and often missing/stale).
 *
 * Why: the alert sender's candidate pool is a rolling `crawledAt` window, which
 * re-admits the ENTIRE re-crawled inventory every day (~16k jobs vs ~400
 * actually new). Score ties were previously broken by `firstSeenAt` recency,
 * but a stale job with a marginally higher relevance score still headlined the
 * email over a just-published equally-relevant one. This graduated boost
 * (+2 within 24h, +1 within 48h) lets truly fresh listings win those near-ties
 * without letting an irrelevant-but-new job outrank a strong old match.
 *
 * Pure: caller supplies `nowMs`. Returns 0 for jobs with no parseable
 * `firstSeenAt` (never resurrects a 0-score job — callers must only add the
 * boost to already-positive scores).
 *
 * @param {object} job    Job from data/jobs.json.
 * @param {number} nowMs  Current epoch ms.
 * @returns {0|1|2}
 */
export function freshnessBoost(job, nowMs) {
  const ts = Date.parse(String(job?.firstSeenAt || ''));
  if (!Number.isFinite(ts)) return 0;
  const age = nowMs - ts;
  if (age < 0) return 0; // malformed future timestamp — no boost
  if (age <= FRESHNESS_BOOST_24H_MS) return 2;
  if (age <= FRESHNESS_BOOST_48H_MS) return 1;
  return 0;
}

/**
 * @typedef {object} AlertProfile
 * @property {TokenSet}  hardKeywords  Explicit user keywords (hard filter when non-empty).
 * @property {TokenSet}  softTokens    Intent tokens from source job + newsletter profile.
 * @property {string}    company       Normalized company affinity token ('' when none).
 * @property {string[]}  locations     Lowercased location signals (soft — ranking only).
 * @property {string[]}  alertLocations Lowercased locations the user explicitly set ON THE ALERT.
 *                                       HARD filter when non-empty: a job outside these (and the
 *                                       cantons) is dropped even if keywords match.
 * @property {string[]}  cantons       Lowercased canton codes (cantonFilter) — HARD geo filter too.
 * @property {string[]}  sectors       Lowercased sector / category signals.
 * @property {string[]}  contractTypes Lowercased contract-type signals.
 * @property {string[]}  specificJobIds    Exact job ids this alert is pinned to (hard scope).
 * @property {string}    specificCompanyKey Canonical employer profile key this alert is pinned to ('' when none).
 * @property {string[]}  preferredLocations High-confidence geo signals (home city + explicit
 *                                       on-site filters + clicked/source job) for the graduated
 *                                       geo PREFERENCE — see {@link partitionByGeoPreference}.
 * @property {string[]}  preferredCantons  Cantons resolved from preferredLocations (graduated preference).
 */

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

function normalizedCriteria(values) {
  return (values || []).map((value) => String(value || '').trim().toLowerCase());
}

function sameCriteriaOrder(left, right) {
  const a = normalizedCriteria(left);
  const b = normalizedCriteria(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Remove only the source-context criteria that the newsletter backfill writer
 * generated before it learned to keep a recovered offer title soft. Explicit
 * or edited alert criteria remain hard: an extra, removed, or reordered value
 * means the array no longer matches one of the writer's exact legacy forms.
 *
 * `backfill-newsletter-job-context.mjs` uses `job_search_query` for a recovered
 * offer title. When that marker is present, even that one value is source-job
 * intent rather than a typed query. The writer's earlier forms are retained
 * here so existing alerts self-heal at read time without a destructive data
 * migration.
 */
function hardKeywordValuesForAlert(alert, subscriber) {
  const values = Array.isArray(alert?.keywords) ? alert.keywords : [];
  const marker = String(alert?.backfilled_from || alert?.backfilledFrom || '').trim();
  if (!marker.startsWith('newsletter_subscribers:') || values.length === 0) return values;

  const sub = subscriber || {};
  const query = String(sub.job_search_query || '').trim();
  const category = String(sub.job_category || '').trim();
  const title = String(sub.job_title || alert?.sourceJobTitle || '').trim();
  const recoveredSourceJobContext = Boolean(
    String(sub.job_context_backfill_source || '').trim()
      || String(sub.job_context_backfill_slug || '').trim(),
  );
  const legacyContext = uniq([query, category, title]);
  const legacyWriterContext = legacyContext.filter((value) => {
    const normalized = value.toLowerCase();
    return normalized !== category.toLowerCase()
      || normalized === query.toLowerCase()
      || normalized === title.toLowerCase();
  });
  const generatedForms = [legacyContext, legacyWriterContext, uniq([query])]
    .filter((form) => form.length > 0);
  if (!generatedForms.some((form) => sameCriteriaOrder(values, form))) return values;

  const generatedValues = new Set(normalizedCriteria([query, category, title]));
  const explicitQuery = recoveredSourceJobContext ? '' : query.toLowerCase();
  return values.filter((value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === explicitQuery || !generatedValues.has(normalized);
  });
}

/**
 * Normalize a company display name / key into a compact, canonical token:
 * lowercased, accent-stripped, alphanumerics only, with declared brand aliases
 * folded by the shared company profile slug. This reconciles the newsletter
 * `job_company` display name ("Board International") with the canonical
 * employer key stored on the alert. The job-side pinned comparison deliberately
 * uses the display name only: a crawler key can cover several employer labels.
 * Returns '' for values too short to be a reliable signal (avoids matching on
 * stray 1-2 char fragments like legal-form suffixes).
 * @param {string} value
 * @returns {string}
 */
function normalizeCompanyToken(value) {
  const t = canonicalCompanyProfileSlug(value, value).replace(/-/g, '');
  return t.length >= 3 ? t : '';
}

/**
 * Company token for the PINNED-employer comparison, with declared brand aliases
 * folded onto their canonical employer key. Both sides are compared by exact
 * equality; crawler keys are intentionally not an identity fallback.
 *
 * @param {string} value
 * @returns {string}
 */
function canonicalCompanyToken(value) {
  return normalizeCompanyToken(value);
}

/**
 * Resolve the exact canonical display identities accepted by a company pin.
 * The shared crawler key is intentionally absent: one key can cover several
 * employer labels, while legal-form and declared-brand variants are resolved
 * by the shared display-identity helper.
 *
 * @param {object|null|undefined} job
 * @returns {string[]}
 */
function pinnedCompanyIdentityKeys(job) {
  return companyDisplayIdentityKeys(job?.company).map(canonicalCompanyToken);
}

/**
 * Explain why a job cannot safely enter a company-pinned comparison.
 *
 * A job-specific pin may rely on its stable job id alone. A company pin,
 * however, needs a resolvable canonical company identity; an absent/garbled
 * key is quarantined by the sender rather than guessed from display text.
 *
 * @param {object|null|undefined} job
 * @param {AlertProfile|null|undefined} profile
 * @returns {string|null}
 */
export function jobCompanyIdentityQuarantineReason(job, profile) {
  if (!profile?.specificCompanyKey) return null;
  return pinnedCompanyIdentityKeys(job).length > 0
    ? null
    : 'unresolved-job-company-key';
}

/**
 * Map the newsletter city-preference booleans to lowercase city tokens.
 * @param {Record<string, unknown> | null | undefined} preferences
 * @returns {string[]}
 */
function preferenceCities(preferences) {
  if (!preferences || typeof preferences !== 'object') return [];
  const cities = ['lugano', 'bellinzona', 'mendrisio', 'chiasso'];
  return cities.filter((c) => preferences[c] === true);
}

/**
 * @typedef {object} AlertProfileExtras
 * @property {string[]} [behaviorLocations] Locations the subscriber actually
 *   browsed — `filterUsage.location` keys + `viewedJobs[].location` from the
 *   `newsletter_subscribers/{email}/private/personalization` subdoc. Folded into
 *   the SOFT location set (ranking only): the precise location signal the issue
 *   #2993 asks us to use, which the matcher previously never read (it lives in a
 *   sibling subcollection, not the flat subscriber doc).
 * @property {string[]} [behaviorTokens]   Free-text intent from browsing —
 *   `searches[].query` + `viewedJobs[].category`. Folded into SOFT tokens.
 * @property {string[]} [sourceJobLocations] Location + canton of the job the
 *   user one-tap-subscribed from. A one-tap alert carries no explicit
 *   location/canton, so a "nurse in Ticino" subscription used to match nurse
 *   jobs across all of Switzerland. Folding the source job's geography into the
 *   SOFT location set ranks same-area jobs to the top without hard-dropping the
 *   rest (which could zero out a sparse match set).
 * @property {string[]} [strongLocations] HIGH-CONFIDENCE geo signals that drive
 *   the in-area / out-area split in {@link partitionByGeoPreference}: the
 *   locations the user EXPLICITLY filtered by on-site (`filterUsage.location`
 *   keys) plus the geography of the job they clicked / one-tap-subscribed from.
 *   Unlike `behaviorLocations` these exclude passive viewed-job cities, so a
 *   single curiosity click on a far-away role can't widen the preference.
 * @property {Record<string,string>|Map<string,string>} [cityToCanton] Lowercased
 *   city → canton index (built from the full jobs dataset) used to resolve the
 *   preferred cities to their cantons for the geo-preference split.
 * @property {Record<string,unknown>|null} [applicationIntent] Bounded private
 *   exact-job intent projection; opted-out or expired entries score zero.
 * @property {number} [now] Fixed epoch for deterministic retention checks/tests.
 */

/**
 * Build the matching profile for one alert, enriched with the subscriber's
 * newsletter document (may be null when the user has no newsletter record) and
 * optional behaviour/source-job signals.
 *
 * @param {object} alert       job_alert_subscribers/{email}/alerts/{id} document.
 * @param {object|null} [subscriber] newsletter_subscribers/{email} document.
 * @param {AlertProfileExtras} [extras] Behaviour + source-job soft signals.
 * @returns {AlertProfile}
 */
export function buildAlertProfile(alert, subscriber = null, extras = {}) {
  const a = alert || {};
  const sub = subscriber || {};
  const ex = extras || {};

  // 1. Explicit user keywords — hard requirement when present (legacy contract).
  const hardKeywordInputs = [];
  for (const kw of hardKeywordValuesForAlert(a, sub)) {
    const t = String(kw || '').toLowerCase().trim();
    if (t) hardKeywordInputs.push(t);
  }
  // The alert's hard-filter contract stays intact (at least one profession
  // keyword must match), but cross-locale aliases now count as the same
  // profession. Without this, an English "nurse" alert could never match an
  // Italian "infermiere" listing even though the shared job-search taxonomy
  // already knows both terms.
  const hardKeywords = new Set(expandKeywordsWithSynonymPhrases(hardKeywordInputs));

  // 2. Soft intent tokens — boost relevance and, for keyword-less alerts, act as
  //    the matching filter. Sourced from the job the user engaged with plus the
  //    newsletter onboarding context.
  const softTokens = new Set();
  const addTokens = (text) => {
    if (!text) return;
    for (const t of extractKeywords(text)) softTokens.add(t);
    // Source-job titles and profile queries are also cross-locale intent. Add
    // the aliases for the complete phrase so multi-word professions (for
    // example "chef de partie") expand before token scoring.
    const aliases = professionSynonymText(text);
    for (const t of extractKeywords(aliases)) softTokens.add(t);
  };
  addTokens(a.sourceJobTitle);
  addTokens(a.sourceJobSlug);
  addTokens(sub.job_search_query);
  addTokens(sub.job_category);
  addTokens(sub.sector_interest);
  addTokens(sub.job_slug);
  // Profile-enrichment signal (services/profileEnrichmentGating.ts):
  // the job title/role the subscriber entered on their profile — same
  // token treatment as sourceJobTitle above.
  addTokens(sub.workPosition);
  // Browsing-derived intent (searches + viewed-job categories) from the
  // personalization subdoc.
  for (const t of ex.behaviorTokens || []) addTokens(t);

  // 3. Company affinity — same employer the user already engaged with.
  const company = normalizeCompanyToken(sub.job_company);

  // 4. Location signals.
  //    `alertLocations` = the locations the user explicitly picked ON THE ALERT
  //    → HARD geo filter (see scoreJobForAlert). `locations` = that set PLUS
  //    soft profile-derived signals (newsletter geo/interest + pref cities),
  //    used only for the +2 ranking boost so a profile city never silently
  //    constrains an alert the user scoped differently.
  const alertLocations = uniq((a.locations || []).map((l) => String(l || '').toLowerCase()));
  const locations = uniq([
    ...alertLocations,
    String(sub.location_interest || '').toLowerCase(),
    String(sub.job_location || '').toLowerCase(),
    String(sub.geo_city || '').toLowerCase(),
    ...preferenceCities(sub.preferences),
    // Browsing-derived locations (filter usage + viewed-job cities) and the
    // one-tap source job's geography. SOFT only — they rank same-area jobs up
    // but never hard-drop, so a sparse alert is never starved.
    ...(ex.behaviorLocations || []).map((l) => String(l || '').toLowerCase()),
    ...(ex.sourceJobLocations || []).map((l) => String(l || '').toLowerCase()),
  ]);

  const cantons = uniq((a.cantonFilter || []).map((c) => String(c || '').toLowerCase()));

  // 5. Sector signals.
  const sectors = uniq([
    ...(a.sectors || []).map((s) => String(s || '').toLowerCase()),
    String(sub.sector_interest || '').toLowerCase(),
    String(sub.job_category || '').toLowerCase(),
  ]);

  const contractTypes = uniq((a.contractTypes || []).map((c) => String(c || '').toLowerCase()));

  // 6. Job-specific scope — "notify me about THIS job/company". When set, it is a
  //    HARD filter (only the pinned job(s)/company surface); used for the
  //    per-job alert and to verify the canary loop. Accepts a single id/string
  //    or an array.
  const specificJobIds = uniq(
    [].concat(a.specificJobId || [], a.specificJobIds || []).map((v) => String(v || '').trim()),
  );
  // Folded, not merely normalised — see canonicalCompanyToken.
  const specificCompanyKey = canonicalCompanyToken(a.specificCompanyKey);

  // 7. Profile-derived geo PREFERENCE (issue #2993). When the alert carries no
  //    explicit location/canton scope, these HIGH-CONFIDENCE signals — the
  //    subscriber's resolved home city (location_interest / geo_city /
  //    job_location), the locations they EXPLICITLY filtered by on-site, and the
  //    geography of the job they clicked / one-tap-subscribed from — let the
  //    send loop prefer same-area jobs (partitionByGeoPreference). Kept distinct
  //    from the soft `locations` set above on purpose: that one also folds in
  //    PASSIVE viewed-job cities (noisier, e.g. a single curiosity click on a
  //    German-CH role) and only nudges ranking; the preference drives an actual
  //    in-area / out-area split, so we restrict it to the strong signals.
  const preferredLocations = uniq([
    String(sub.location_interest || '').toLowerCase(),
    String(sub.geo_city || '').toLowerCase(),
    String(sub.job_location || '').toLowerCase(),
    ...preferenceCities(sub.preferences),
    ...(ex.strongLocations || []).map((l) => String(l || '').toLowerCase()),
  ]);
  const cityToCanton = ex.cityToCanton && typeof ex.cityToCanton === 'object' ? ex.cityToCanton : {};
  const lookupCanton = (loc) => {
    const t = String(loc || '').toLowerCase();
    if (!t) return '';
    // A raw 2-letter canton code (from a source/clicked job's geography) resolves
    // to itself; a city is mapped through the jobs-derived city→canton index.
    if (t.length === 2 && SWISS_CANTONS.has(t)) return t;
    const mapped = cityToCanton instanceof Map ? cityToCanton.get(t) : cityToCanton[t];
    return mapped ? String(mapped).toLowerCase() : '';
  };
  const preferredCantons = uniq([
    ...preferredLocations.map(lookupCanton),
    // Profile-enrichment signal (services/profileEnrichmentGating.ts): the
    // subscriber's Italian residence municipality, resolved to its
    // cross-border-commute canton(s) (services/provinceCantonAffinity.ts) —
    // soft-only, same graduated preference as the other preferredCantons signals.
    ...municipalityToCantons(sub.municipality).map((c) => c.toLowerCase()),
  ]);

  // A raw 2-letter canton code (from a clicked/source job's geography) is
  // already fully captured by preferredCantons above via lookupCanton.
  // Leaving it in preferredLocations too would make partitionByGeoPreference's
  // locTokenHit() treat the bare code as a city name — a redundant surface
  // that could theoretically collide with an unrelated 2-letter token in a
  // job's location text. Canton-level matching already covers this signal,
  // so drop bare codes here instead of reasoning about token collisions
  // downstream (review nit on PR #3146, issue #3155).
  const preferredLocationNames = preferredLocations.filter(
    (l) => !(l.length === 2 && SWISS_CANTONS.has(l)),
  );

  return {
    hardKeywords, softTokens, company, locations, alertLocations, cantons, sectors, contractTypes,
    specificJobIds, specificCompanyKey, preferredLocations: preferredLocationNames, preferredCantons,
    applicationIntentJobKeys: activeApplicationIntentJobKeys(ex.applicationIntent, ex.now),
  };
}

/**
 * Apply the profile-derived geo PREFERENCE to a ranked job list (issue #2993).
 *
 * The matcher hard-filters geography ONLY on the locations/cantons the user set
 * ON THE ALERT. A keyword-only alert ("infermiere", no location) therefore
 * surfaced matching jobs across ALL of Switzerland even when the subscriber's
 * profile clearly pointed at one area (Bellinzona / Chiasso / Mendrisio) — the
 * "use the location fields for precise alerts" the issue asks for. This adds a
 * GRADUATED preference (deliberately NOT a hard filter, so a sparse alert is
 * never starved):
 *
 *   • no-op when the alert already has an explicit geo scope (the hard filter
 *     in scoreJobForAlert already ran — never second-guess an explicit choice);
 *   • no-op when the profile carries no preferred location/canton signal;
 *   • otherwise split the ranked jobs into in-area (canton ∈ preferredCantons OR
 *     location hits a preferredLocation) and the rest, returning in-area FIRST.
 *     The rest is appended ONLY when fewer than `minLocal` in-area jobs exist,
 *     so a user with plenty of local matches gets a local-only email while a
 *     user with few never ends up with an empty / too-thin one.
 *
 * Pure (no IO); order WITHIN each partition is preserved (the caller already
 * sorted by score then recency).
 *
 * @param {object[]} jobs        Ranked jobs (best first).
 * @param {AlertProfile} profile Output of {@link buildAlertProfile}.
 * @param {{minLocal?: number}} [opts]
 * @returns {object[]}
 */
export function partitionByGeoPreference(jobs, profile, { minLocal = GEO_PREFERENCE_MIN_LOCAL } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!profile) return list;
  // An explicit alert geo scope is already a HARD filter upstream.
  if ((profile.alertLocations?.length || 0) > 0 || (profile.cantons?.length || 0) > 0) return list;
  const prefLoc = profile.preferredLocations || [];
  const prefCanton = profile.preferredCantons || [];
  if (prefLoc.length === 0 && prefCanton.length === 0) return list;

  // `locTokenHit(jobLoc, l)` for every preferred location, with the needles
  // normalized once per call and the job side once per job (#9314).
  const prefLocNeedles = paddedLocNeedles(prefLoc);
  const inArea = [];
  const rest = [];
  for (const job of list) {
    const jobCanton = String(job?.canton || '').toLowerCase();
    const hit = (prefCanton.length > 0 && jobCanton && prefCanton.includes(jobCanton))
      || (prefLocNeedles.length > 0 && includesAny(
        paddedLocHaystack(`${job?.location || ''} ${job?.addressLocality || ''} ${job?.addressRegion || ''} ${job?.canton || ''}`),
        prefLocNeedles,
      ));
    (hit ? inArea : rest).push(job);
  }
  return inArea.length >= minLocal ? inArea : inArea.concat(rest);
}

/**
 * The job-side half of {@link scoreJobForAlert}: every string/token set that
 * depends ONLY on the job and the recipient locale, never on the alert.
 *
 * Computing these is most of the scorer's cost (lower-casing a ~2.5 KB
 * description, tokenising the title, canonicalising the company) and the daily
 * sender repeats it for every alert x every job — 4,353 alerts x 3,567 jobs in
 * run 35422626497, ~4.5 of the ~9 minutes of the matching loop. Pure: same job
 * + locale in, same features out.
 *
 * @param {object} job
 * @param {string} [locale]
 */
export function jobMatchFeatures(job, locale) {
  const localizedTitles = locale
    ? String((job.titleByLocale || {})[locale] || '')
    : Object.values(job.titleByLocale || {}).join(' ');
  const titleText = `${job.title || ''} ${localizedTitles}`.toLowerCase();
  return {
    titleText,
    fullText: `${titleText} ${(job.description || '').toLowerCase()}`,
    jobTokens: extractKeywords(
      `${job.title || ''} ${localizedTitles} ${job.category || ''} ${job.sector || ''}`,
    ),
    jobCompany: normalizeCompanyToken(job.companyKey || job.company),
    jobLoc: `${job.location || ''} ${job.addressLocality || ''} ${job.addressRegion || ''} ${job.canton || ''}`.toLowerCase(),
    jobCanton: String(job.canton || '').toLowerCase(),
    jobSector: `${job.sector || ''} ${job.category || ''}`.toLowerCase(),
    jobContract: String(job.contract || '').toLowerCase(),
  };
}

/**
 * Location haystack in the exact shape `locTokenHit` compares against:
 * normalized and space-padded, so `padded.includes(' needle ')` answers
 * `locTokenHit(jobLoc, needle)` without normalizing the job side again.
 * An empty normalization pads to two spaces, which no padded needle (at least
 * three characters) can be found in — the same `false` locTokenHit returns.
 *
 * @param {string} jobLoc
 * @returns {string}
 */
function paddedLocHaystack(jobLoc) {
  return ` ${normalizeLocToken(jobLoc)} `;
}

/**
 * The profile side of `locTokenHit`, normalized once per alert instead of once
 * per job: empty normalizations are dropped (locTokenHit answers `false` for
 * them), the rest are space-padded for {@link paddedLocHaystack}.
 *
 * @param {string[]} needles
 * @returns {string[]}
 */
function paddedLocNeedles(needles) {
  const out = [];
  for (const needle of needles || []) {
    const n = normalizeLocToken(needle);
    if (n) out.push(` ${n} `);
  }
  return out;
}

/**
 * Whether `haystack` contains any of the padded `needles`
 * ({@link paddedLocHaystack} / {@link paddedLocNeedles}).
 *
 * @param {string} haystack
 * @param {string[]} needles
 * @returns {boolean}
 */
function includesAny(haystack, needles) {
  for (let i = 0; i < needles.length; i++) if (haystack.includes(needles[i])) return true;
  return false;
}

/**
 * Two bitmaps over an index space: `known` says the answer was computed, `hit`
 * holds it. Grown on demand, so the memo never needs to know the pool size up
 * front.
 */
function createSubstringMemo() {
  return { known: new Uint32Array(64), hit: new Uint32Array(64) };
}

/** @returns {-1|0|1} unknown, miss, hit */
function memoRead(memo, index) {
  const word = index >>> 5;
  if (word >= memo.known.length) return -1;
  const bit = 1 << (index & 31);
  if ((memo.known[word] & bit) === 0) return -1;
  return (memo.hit[word] & bit) !== 0 ? 1 : 0;
}

function memoWrite(memo, index, found) {
  const word = index >>> 5;
  if (word >= memo.known.length) {
    let size = memo.known.length;
    while (size <= word) size *= 2;
    const known = new Uint32Array(size);
    known.set(memo.known);
    const hit = new Uint32Array(size);
    hit.set(memo.hit);
    memo.known = known;
    memo.hit = hit;
  }
  const bit = 1 << (index & 31);
  memo.known[word] |= bit;
  if (found) memo.hit[word] |= bit;
}

/**
 * `features.fullText.includes(keyword)` for one cache entry, answered at most
 * once per (locale, keyword, job) — and the description scan at most once per
 * (keyword, job) across locales.
 *
 * `fullText` is `titleText + ' ' + description`, and only `titleText` depends
 * on the locale. An occurrence of the keyword therefore lies inside the title,
 * inside the description, or across the joining space; the three checks below
 * cover exactly those cases, so the answer is the plain `includes` answer.
 *
 * @param {{features: {titleText: string, fullText: string}, index: number, jobIndex: number}} entry
 * @param {ReturnType<typeof createSubstringMemo>} localeMemo (locale, keyword) memo over entry indexes
 * @param {ReturnType<typeof createSubstringMemo>} descriptionMemo keyword memo over job indexes
 * @param {string} keyword
 * @returns {boolean}
 */
function memoKeywordInFullText(entry, localeMemo, descriptionMemo, keyword) {
  const known = memoRead(localeMemo, entry.index);
  if (known !== -1) return known === 1;
  const { titleText, fullText } = entry.features;
  const join = titleText.length; // fullText[join] is the joining space
  let found = titleText.includes(keyword);
  if (!found) {
    const inDescription = memoRead(descriptionMemo, entry.jobIndex);
    if (inDescription !== -1) {
      found = inDescription === 1;
    } else {
      found = fullText.includes(keyword, join + 1);
      memoWrite(descriptionMemo, entry.jobIndex, found);
    }
  }
  if (!found) {
    found = fullText
      .slice(Math.max(0, join - keyword.length + 1), join + keyword.length)
      .includes(keyword);
  }
  memoWrite(localeMemo, entry.index, found);
  return found;
}

/**
 * Memo of {@link jobMatchFeatures} for one scoring pass over an IMMUTABLE job
 * pool (keyed by object identity, then locale). Opt-in via the 4th argument of
 * {@link scoreJobForAlert}: a caller that mutates a job between two scores must
 * not pass one, and the default (no cache) recomputes exactly as before.
 *
 * Besides the features it memoises, per job/locale, the other answers that
 * depend only on the job and never on the alert (#9314): the normalized
 * location haystack, the pinned-company identity keys, and — per locale and
 * hard keyword — whether `fullText` contains that keyword. Since #9471 every
 * alert is scored against the recipient's whole catch-up window (~19K rows in
 * production), and #9695 expands each profession keyword into its 8-27
 * cross-locale aliases: the same `fullText.includes(alias)` scan over a ~2.4 KB
 * description was repeated for every alert that shares the alias. The memo is
 * a pair of bitmaps per (locale, keyword) plus one per keyword for the
 * locale-independent description, a few KB each.
 */
export function createJobFeatureCache() {
  const byJob = new WeakMap();
  const pinnedKeysByJob = new WeakMap();
  const jobIndexByJob = new WeakMap();
  let jobCount = 0;
  /** @type {Map<string, ReturnType<typeof createSubstringMemo>>} */
  const descriptionMemos = new Map();
  /** @type {Map<string, {size: number, keywordMemos: Map<string, ReturnType<typeof createSubstringMemo>>}>} */
  const spaces = new Map();
  const spaceFor = (key) => {
    let space = spaces.get(key);
    if (!space) {
      space = { size: 0, keywordMemos: new Map() };
      spaces.set(key, space);
    }
    return space;
  };
  const entry = (job, locale) => {
    let byLocale = byJob.get(job);
    if (!byLocale) {
      byLocale = new Map();
      byJob.set(job, byLocale);
    }
    const key = locale || '';
    let found = byLocale.get(key);
    if (!found) {
      let jobIndex = jobIndexByJob.get(job);
      if (jobIndex === undefined) {
        jobIndex = jobCount++;
        jobIndexByJob.set(job, jobIndex);
      }
      const features = jobMatchFeatures(job, locale);
      found = { features, index: spaceFor(key).size++, jobIndex, locHaystack: null };
      byLocale.set(key, found);
    }
    return found;
  };
  return {
    get(job, locale) {
      return entry(job, locale).features;
    },
    /**
     * Internal to {@link createAlertScorer}: the cache entry of `job` in
     * `locale` — its features, its index in that locale's keyword bitmaps and
     * its lazily normalized location haystack.
     */
    entry,
    /**
     * Internal to {@link createAlertScorer}: `(entry) => fullText.includes(keyword)`
     * for `locale`, memoised as described on {@link memoKeywordInFullText}.
     */
    keywordTest(locale, keyword) {
      const space = spaceFor(locale || '');
      let localeMemo = space.keywordMemos.get(keyword);
      if (!localeMemo) {
        localeMemo = createSubstringMemo();
        space.keywordMemos.set(keyword, localeMemo);
      }
      let descriptionMemo = descriptionMemos.get(keyword);
      if (!descriptionMemo) {
        descriptionMemo = createSubstringMemo();
        descriptionMemos.set(keyword, descriptionMemo);
      }
      return (entry) => memoKeywordInFullText(entry, localeMemo, descriptionMemo, keyword);
    },
    /** Internal to {@link createAlertScorer}: {@link pinnedCompanyIdentityKeys}, once per job. */
    pinnedKeys(job) {
      let keys = pinnedKeysByJob.get(job);
      if (!keys) {
        keys = pinnedCompanyIdentityKeys(job);
        pinnedKeysByJob.set(job, keys);
      }
      return keys;
    },
  };
}

/**
 * Compile the per-alert half of {@link scoreJobForAlert} once, so the send
 * loop can score a whole candidate window with it (#9314). Returns
 * `(job) => score` with exactly the result of
 * `scoreJobForAlert(job, profile, locale, featureCache)`; the latter is now a
 * one-shot call of this function, so there is one implementation only.
 *
 * What moves out of the per-job path, without changing any answer:
 *   - the profile's location needles are normalized once per alert, the job's
 *     location once per job/locale (cache) — `locTokenHit` normalized both
 *     sides on every call;
 *   - with a cache, each hard-keyword `fullText.includes` is answered at most
 *     once per (locale, keyword, job) for the whole run;
 *   - the hard geo filter runs before the hard keyword filter. Both are
 *     necessary conditions that return 0, the checks are pure, so the order
 *     changes only how cheaply a non-matching job is rejected (a location
 *     string of ~30 chars instead of a ~2.4 KB description).
 *
 * @param {AlertProfile|null|undefined} profile Output of {@link buildAlertProfile}.
 * @param {string} [locale] See {@link scoreJobForAlert}.
 * @param {ReturnType<typeof createJobFeatureCache>|null} [featureCache] See {@link scoreJobForAlert}.
 * @returns {(job: object) => number}
 */
export function createAlertScorer(profile, locale, featureCache = null, options = {}) {
  if (!profile) return () => 0;
  const applicationIntentEnabled = options.applicationIntentRankingEnabled === true;
  const applicationIntentJobKeys = applicationIntentEnabled
    ? profile.applicationIntentJobKeys || new Set()
    : new Set();
  const applicationIntentBoost = (job) => (
    applicationIntentJobKeys.size > 0
      && applicationIntentJobKeys.has(buildApplicationIntentJobKey(job))
      ? ALERT_APPLICATION_INTENT_BOOST
      : 0
  );

  // Job-specific scope: a pinned alert ("notify me about THIS job/company")
  // surfaces ONLY the pinned job(s) / company, bypassing keyword/intent scoring.
  const pinnedJobs = profile.specificJobIds || [];
  const pinnedCompany = profile.specificCompanyKey || '';
  if (pinnedJobs.length > 0 || pinnedCompany) {
    return (job) => {
      if (!job) return 0;
      // `companyKey` identifies the crawler and can cover several employer labels
      // (the Migros crawler also publishes Galaxus jobs). The display name is the
      // employer identity used by the public profile and the writer. Use the
      // shared canonical resolver on that display name only; never let a crawler
      // key, substring, or missing display name broaden a company follow.
      const jobCompanyKeys = featureCache ? featureCache.pinnedKeys(job) : pinnedCompanyIdentityKeys(job);
      const idHit = pinnedJobs.includes(String(job.id || ''))
        || pinnedJobs.includes(String(job.publisherJobId || ''));
      const companyHit = Boolean(pinnedCompany && jobCompanyKeys.includes(pinnedCompany));
      return (idHit || companyHit) ? 10 + applicationIntentBoost(job) : 0;
    };
  }

  const { hardKeywords, softTokens, cantons, sectors, contractTypes } = profile;
  const hardList = [...hardKeywords];
  const keywordTests = featureCache ? hardList.map((kw) => featureCache.keywordTest(locale, kw)) : null;
  const alertLocationNeedles = paddedLocNeedles(profile.alertLocations);
  const locationNeedles = paddedLocNeedles(profile.locations);
  const needsLocation = alertLocationNeedles.length > 0 || locationNeedles.length > 0;
  const hasGeoScope = profile.alertLocations.length > 0 || cantons.length > 0;
  const hasIntentProfile = softTokens.size > 0 || Boolean(profile.company);
  // A profile without a single signal scores every job 0 (nothing can add to
  // the score, and the no-keyword/no-intent policy then drops score 0): answer
  // that without touching the job — 588 of 5.157 alerts in run 36097910375.
  const neverMatches = hardList.length === 0 && !hasGeoScope && !hasIntentProfile
    && locationNeedles.length === 0 && sectors.length === 0 && contractTypes.length === 0;

  return (job) => {
    if (!job || neverMatches) return 0;
    const cached = featureCache ? featureCache.entry(job, locale) : null;
    const {
      titleText, fullText, jobTokens, jobCompany, jobLoc, jobCanton, jobSector, jobContract,
    } = cached ? cached.features : jobMatchFeatures(job, locale);
    let locHaystack = '';
    if (needsLocation) {
      if (cached) {
        if (cached.locHaystack === null) cached.locHaystack = paddedLocHaystack(jobLoc);
        locHaystack = cached.locHaystack;
      } else {
        locHaystack = paddedLocHaystack(jobLoc);
      }
    }

    // HARD geo filter: when the user scoped the alert to explicit locations and/or
    // cantons, a job OUTSIDE that geography is dropped — even when keywords or
    // company/sector match. Without this the location was only a +2 ranking nudge,
    // so a "Lugano, Mendrisio, Bellinzona" alert still surfaced Basel/Lausanne jobs
    // whose title matched the keyword. Only the alert's OWN locations/cantons are
    // hard; soft profile-derived locations (geo_city, pref cities) still only rank.
    if (hasGeoScope) {
      const geoHit = includesAny(locHaystack, alertLocationNeedles)
        || (cantons.length > 0 && jobCanton && cantons.includes(jobCanton));
      if (!geoHit) return 0;
    }

    let score = 0;

    // 1. HARD keyword filter — preserve the legacy contract: when the user typed
    //    keywords, at least one MUST appear in the job text or the job is dropped.
    if (hardList.length > 0) {
      let hit = false;
      for (let k = 0; k < hardList.length; k++) {
        const found = keywordTests ? keywordTests[k](cached) : fullText.includes(hardList[k]);
        if (found) { hit = true; break; }
      }
      if (!hit) return 0;
      score += 3;
      // Tokenized overlap bonus: jobs matching MORE keyword tokens rank higher.
      let overlap = 0;
      for (const kw of hardList) if (jobTokens.has(kw)) overlap++;
      score += Math.min(3, overlap);
    }

    // Company affinity (strong signal — same employer).
    const companyMatch = Boolean(profile.company && jobCompany && jobCompany === profile.company);
    if (companyMatch) score += 4;

    // Soft keyword overlap (tokenized, proportional, capped).
    let softOverlap = 0;
    for (const t of softTokens) if (jobTokens.has(t)) softOverlap++;
    if (softOverlap > 0) score += Math.min(5, softOverlap * 2);

    // Location (jobLoc: see jobMatchFeatures).
    const locationMatch = includesAny(locHaystack, locationNeedles);
    if (locationMatch) score += 2;
    const cantonMatch = cantons.length > 0 && cantons.includes(jobCanton);
    if (cantonMatch) score += 1;

    // Sector (match against sector/category AND title — sectors often surface in titles).
    const sectorMatch = sectors.some((s) => jobSector.includes(s) || titleText.includes(s));
    if (sectorMatch) score += 2;

    // Contract type.
    const contractMatch = contractTypes.some((c) => jobContract.includes(c));
    if (contractMatch) score += 1;

    // 2. Filtering policy when there are NO explicit keywords.
    if (hardList.length === 0) {
      if (hasIntentProfile) {
        // One-tap / onboarding subscriber: require at least ONE targeted signal,
        // otherwise we'd surface every recent job (the legacy noise this fixes).
        if (softOverlap === 0 && !companyMatch && !sectorMatch && !locationMatch) return 0;
      } else if (score === 0) {
        // Pure location/sector alert with no intent profile (legacy behavior):
        // location / sector / contract sufficient; nothing matched → exclude.
        return 0;
      }
    }

    return Math.max(score, 1) + applicationIntentBoost(job);
  };
}

/**
 * Score one job against a pre-built alert profile.
 * Returns 0 when the job should NOT be surfaced; a positive integer otherwise
 * (higher = more relevant). The send loop sorts by this score, then recency.
 * A caller scoring many jobs against the same alert should compile it once
 * with {@link createAlertScorer} (same answer, per-alert work done once).
 *
 * @param {object} job          Job from data/jobs.json.
 * @param {AlertProfile} profile Output of {@link buildAlertProfile}.
 * @param {string} [locale]     Recipient's alert locale. When passed, only that
 *   locale's `titleByLocale` slot feeds keyword matching instead of every
 *   locale's translation at once — a mistranslation in one locale's title
 *   (e.g. a French MT error inserting an unrelated word) must not cause a
 *   job to wrongly match and get emailed to a subscriber in a DIFFERENT
 *   locale. Omitted keeps the prior locale-agnostic behavior. See #4715.
 * @param {ReturnType<typeof createJobFeatureCache>|null} [featureCache] Memo of
 *   the job-side features, for a caller scoring the same immutable pool against
 *   many alerts. Omitted: computed per call, as before.
 * @returns {number}
 */
export function scoreJobForAlert(job, profile, locale, featureCache = null, options = {}) {
  if (!job || !profile) return 0;
  return createAlertScorer(profile, locale, featureCache, options)(job);
}
