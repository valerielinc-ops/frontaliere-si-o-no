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

/** @typedef {Set<string>} TokenSet */

/**
 * @typedef {object} AlertProfile
 * @property {TokenSet}  hardKeywords  Explicit user keywords (hard filter when non-empty).
 * @property {TokenSet}  softTokens    Intent tokens from source job + newsletter profile.
 * @property {string}    company       Normalized company affinity token ('' when none).
 * @property {string[]}  locations     Lowercased location signals.
 * @property {string[]}  cantons       Lowercased canton codes (cantonFilter).
 * @property {string[]}  sectors       Lowercased sector / category signals.
 * @property {string[]}  contractTypes Lowercased contract-type signals.
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
 * Build the matching profile for one alert, enriched with the subscriber's
 * newsletter document (may be null when the user has no newsletter record).
 *
 * @param {object} alert       job_alert_subscribers/{email}/alerts/{id} document.
 * @param {object|null} [subscriber] newsletter_subscribers/{email} document.
 * @returns {AlertProfile}
 */
export function buildAlertProfile(alert, subscriber = null) {
  const a = alert || {};
  const sub = subscriber || {};

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

  // 3. Company affinity — same employer the user already engaged with.
  const company = normalizeCompanyToken(sub.job_company);

  // 4. Location signals — alert filters + newsletter geo/interest + pref cities.
  const locations = uniq([
    ...(a.locations || []).map((l) => String(l || '').toLowerCase()),
    String(sub.location_interest || '').toLowerCase(),
    String(sub.job_location || '').toLowerCase(),
    String(sub.geo_city || '').toLowerCase(),
    ...preferenceCities(sub.preferences),
  ]);

  const cantons = uniq((a.cantonFilter || []).map((c) => String(c || '').toLowerCase()));

  // 5. Sector signals.
  const sectors = uniq([
    ...(a.sectors || []).map((s) => String(s || '').toLowerCase()),
    String(sub.sector_interest || '').toLowerCase(),
    String(sub.job_category || '').toLowerCase(),
  ]);

  const contractTypes = uniq((a.contractTypes || []).map((c) => String(c || '').toLowerCase()));

  return { hardKeywords, softTokens, company, locations, cantons, sectors, contractTypes };
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
  const locationMatch = profile.locations.some((l) => jobLoc.includes(l));
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
