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
import { locTokenHit } from './locToken.mjs';
import { municipalityToCantons } from './provinceCantonAffinity.ts';

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
 * @property {string}    specificCompanyKey Exact companyKey this alert is pinned to ('' when none).
 * @property {string[]}  preferredLocations High-confidence geo signals (home city + explicit
 *                                       on-site filters + clicked/source job) for the graduated
 *                                       geo PREFERENCE — see {@link partitionByGeoPreference}.
 * @property {string[]}  preferredCantons  Cantons resolved from preferredLocations (graduated preference).
 */

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/**
 * Normalize a company display name / key into a compact, comparable token:
 * lowercased, accent-stripped, alphanumerics only. This reconciles the two
 * shapes we compare — the newsletter `job_company` display name ("Board
 * International") and the job's `companyKey` slug ("board-international") both
 * collapse to "boardinternational".
 * Returns '' for values too short to be a reliable signal (avoids matching on
 * stray 1-2 char fragments like legal-form suffixes).
 * @param {string} value
 * @returns {string}
 */
function normalizeCompanyToken(value) {
  const t = String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
  return t.length >= 3 ? t : '';
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
  const hardKeywords = new Set();
  for (const kw of a.keywords || []) {
    const t = String(kw || '').toLowerCase().trim();
    if (t) hardKeywords.add(t);
  }

  // 2. Soft intent tokens — boost relevance and, for keyword-less alerts, act as
  //    the matching filter. Sourced from the job the user engaged with plus the
  //    newsletter onboarding context.
  const softTokens = new Set();
  const addTokens = (text) => {
    if (!text) return;
    for (const t of extractKeywords(text)) softTokens.add(t);
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
  const specificCompanyKey = normalizeCompanyToken(a.specificCompanyKey);

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

  const inArea = [];
  const rest = [];
  for (const job of list) {
    const jobCanton = String(job?.canton || '').toLowerCase();
    const jobLoc = `${job?.location || ''} ${job?.addressLocality || ''} ${job?.addressRegion || ''} ${job?.canton || ''}`.toLowerCase();
    const hit = (prefCanton.length > 0 && jobCanton && prefCanton.includes(jobCanton))
      || prefLoc.some((l) => locTokenHit(jobLoc, l));
    (hit ? inArea : rest).push(job);
  }
  return inArea.length >= minLocal ? inArea : inArea.concat(rest);
}

/**
 * Score one job against a pre-built alert profile.
 * Returns 0 when the job should NOT be surfaced; a positive integer otherwise
 * (higher = more relevant). The send loop sorts by this score, then recency.
 *
 * @param {object} job          Job from data/jobs.json.
 * @param {AlertProfile} profile Output of {@link buildAlertProfile}.
 * @returns {number}
 */
export function scoreJobForAlert(job, profile) {
  if (!job || !profile) return 0;

  // Job-specific scope: a pinned alert ("notify me about THIS job/company")
  // surfaces ONLY the pinned job(s) / company, bypassing keyword/intent scoring.
  const pinnedJobs = profile.specificJobIds || [];
  const pinnedCompany = profile.specificCompanyKey || '';
  if (pinnedJobs.length > 0 || pinnedCompany) {
    const jobCompanyKey = normalizeCompanyToken(job.companyKey || job.company);
    const idHit = pinnedJobs.includes(String(job.id || ''))
      || pinnedJobs.includes(String(job.publisherJobId || ''));
    const companyHit = Boolean(pinnedCompany && jobCompanyKey
      && (jobCompanyKey.includes(pinnedCompany) || pinnedCompany.includes(jobCompanyKey)));
    return (idHit || companyHit) ? 10 : 0;
  }

  const localizedTitles = Object.values(job.titleByLocale || {}).join(' ');
  const titleText = `${job.title || ''} ${localizedTitles}`.toLowerCase();
  const fullText = `${titleText} ${(job.description || '').toLowerCase()}`;
  const jobTokens = extractKeywords(
    `${job.title || ''} ${localizedTitles} ${job.category || ''} ${job.sector || ''}`,
  );
  const jobCompany = normalizeCompanyToken(job.companyKey || job.company);

  let score = 0;

  // 1. HARD keyword filter — preserve the legacy contract: when the user typed
  //    keywords, at least one MUST appear in the job text or the job is dropped.
  const { hardKeywords } = profile;
  if (hardKeywords.size > 0) {
    let hit = false;
    for (const kw of hardKeywords) {
      if (fullText.includes(kw)) { hit = true; break; }
    }
    if (!hit) return 0;
    score += 3;
    // Tokenized overlap bonus: jobs matching MORE keyword tokens rank higher.
    let overlap = 0;
    for (const kw of hardKeywords) if (jobTokens.has(kw)) overlap++;
    score += Math.min(3, overlap);
  }

  // Company affinity (strong signal — same employer).
  const companyMatch = Boolean(
    profile.company && jobCompany &&
    (jobCompany.includes(profile.company) || profile.company.includes(jobCompany)),
  );
  if (companyMatch) score += 4;

  // Soft keyword overlap (tokenized, proportional, capped).
  let softOverlap = 0;
  for (const t of profile.softTokens) if (jobTokens.has(t)) softOverlap++;
  if (softOverlap > 0) score += Math.min(5, softOverlap * 2);

  // Location.
  const jobLoc = `${job.location || ''} ${job.addressLocality || ''} ${job.addressRegion || ''} ${job.canton || ''}`.toLowerCase();

  // HARD geo filter: when the user scoped the alert to explicit locations and/or
  // cantons, a job OUTSIDE that geography is dropped — even when keywords or
  // company/sector match. Without this the location was only a +2 ranking nudge,
  // so a "Lugano, Mendrisio, Bellinzona" alert still surfaced Basel/Lausanne jobs
  // whose title matched the keyword. Only the alert's OWN locations/cantons are
  // hard; soft profile-derived locations (geo_city, pref cities) still only rank.
  const hasGeoScope = profile.alertLocations.length > 0 || profile.cantons.length > 0;
  if (hasGeoScope) {
    const jobCanton = String(job.canton || '').toLowerCase();
    const geoHit =
      profile.alertLocations.some((l) => locTokenHit(jobLoc, l)) ||
      (profile.cantons.length > 0 && jobCanton && profile.cantons.includes(jobCanton));
    if (!geoHit) return 0;
  }

  const locationMatch = profile.locations.some((l) => locTokenHit(jobLoc, l));
  if (locationMatch) score += 2;
  const cantonMatch = profile.cantons.length > 0 && profile.cantons.includes(String(job.canton || '').toLowerCase());
  if (cantonMatch) score += 1;

  // Sector (match against sector/category AND title — sectors often surface in titles).
  const jobSector = `${job.sector || ''} ${job.category || ''}`.toLowerCase();
  const sectorMatch = profile.sectors.some((s) => jobSector.includes(s) || titleText.includes(s));
  if (sectorMatch) score += 2;

  // Contract type.
  const jobContract = String(job.contract || '').toLowerCase();
  const contractMatch = profile.contractTypes.some((c) => jobContract.includes(c));
  if (contractMatch) score += 1;

  // 2. Filtering policy when there are NO explicit keywords.
  if (hardKeywords.size === 0) {
    const hasIntentProfile = profile.softTokens.size > 0 || Boolean(profile.company);
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

  return Math.max(score, 1);
}
