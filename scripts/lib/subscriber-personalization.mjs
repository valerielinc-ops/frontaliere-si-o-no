/**
 * Consolidate every personalization signal we hold about a subscriber into the
 * flat `newsletter_subscribers/{email}` profile fields the matcher + newsletter
 * + employer-blast funnels read.
 *
 * Motivation (issue #2993): the precise targeting fields (`location_interest`,
 * `geo_city`, `sector_interest`, `job_category`, `job_company`,
 * `job_search_query`) were frequently EMPTY, so alerts fell back to broad,
 * low-value matching ("nurse jobs across all of Switzerland"). The data to fill
 * them already exists, scattered across three places the enrichment never
 * combined:
 *
 *   1. The browsing-personalization subdoc
 *      (`newsletter_subscribers/{email}/private/personalization`):
 *      `filterUsage.location`/`.category` (weighted by use count),
 *      `viewedJobs[].location/category/company`, `searches[].query`.
 *   2. The user's own job alerts (`job_alert_subscribers/{email}/alerts/*`):
 *      explicit `locations`, `cantonFilter`, `sectors`, `keywords`,
 *      `sourceJobTitle`.
 *
 * `derivePersonalizationPatch` folds all of that into a no-clobber patch: it
 * only fills fields the subscriber is MISSING, never overwrites an explicit
 * value. Pure (no IO) so it is unit-testable — see
 * tests/subscriber-personalization.test.ts.
 */

// Fields we fill. Order matters only for readability.
export const PERSONALIZATION_FIELDS = [
  'location_interest',
  'geo_city',
  'sector_interest',
  'job_category',
  'job_company',
  'job_search_query',
];

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Pick the highest-weighted non-blank label from a list of `{ value, weight }`
 * entries. Ties break toward the first seen (insertion order), so a single
 * recent signal still wins deterministically.
 * @param {Array<{value: unknown, weight: number}>} entries
 * @returns {string}
 */
function topWeighted(entries) {
  const totals = new Map();
  for (const { value, weight } of entries) {
    const label = String(value || '').trim();
    if (!label) continue;
    totals.set(label, (totals.get(label) || 0) + (Number(weight) || 0));
  }
  let best = '';
  let bestWeight = -Infinity;
  for (const [label, weight] of totals) {
    if (weight > bestWeight) {
      best = label;
      bestWeight = weight;
    }
  }
  return best;
}

/** Weighted entries from a Firestore-style `{ key: count }` usage map. */
function fromUsageMap(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([value, count]) => ({ value, weight: Number(count) || 1 }));
}

/**
 * @typedef {object} DeriveInput
 * @property {object|null} subscriber      Flat newsletter_subscribers doc (for no-clobber).
 * @property {object|null} personalization private/personalization subdoc raw.
 * @property {object[]}   [alerts]         The user's alert docs.
 */

/**
 * Build a no-clobber personalization patch for one subscriber.
 * @param {DeriveInput} input
 * @returns {Record<string, string>|null} patch, or null when nothing to fill.
 */
export function derivePersonalizationPatch({ subscriber, personalization, alerts = [], clicked = null } = {}) {
  const sub = subscriber || {};
  const p = personalization || {};
  const viewedJobs = Array.isArray(p.viewedJobs) ? p.viewedJobs : [];
  const searches = Array.isArray(p.searches) ? p.searches : [];
  const filterUsage = p.filterUsage && typeof p.filterUsage === 'object' ? p.filterUsage : {};
  const alertList = Array.isArray(alerts) ? alerts : [];
  // A click on a job in an email is the STRONGEST intent signal we hold — the
  // user actively chose that job out of the inbox — so it outranks a passive
  // on-site filter (×3) or view (×2). Resolved from the ESP-recorded
  // `last_clicked_url` by the caller; see send-job-alerts.mjs clickedJobMeta.
  const clk = clicked || {};
  const clickedLocations = Array.isArray(clk.locations) ? clk.locations : [];
  const CLICK_WEIGHT = 5;

  // ── Location: clicked job (strongest) > filter usage (explicit filter
  //    action) > viewed job cities > explicit alert locations / cantons.
  const locationEntries = [
    ...clickedLocations.map((l) => ({ value: l, weight: CLICK_WEIGHT })),
    ...fromUsageMap(filterUsage.location).map((e) => ({ ...e, weight: e.weight * 3 })),
    ...viewedJobs.map((v) => ({ value: v?.location, weight: 2 })),
    ...alertList.flatMap((a) => [
      ...((a?.locations) || []).map((l) => ({ value: l, weight: 2 })),
      ...((a?.cantonFilter) || []).map((c) => ({ value: c, weight: 1 })),
    ]),
  ];
  const location = topWeighted(locationEntries);

  // ── Sector / category: filter usage > viewed job categories > alert sectors.
  const sectorEntries = [
    ...fromUsageMap(filterUsage.category).map((e) => ({ ...e, weight: e.weight * 3 })),
    ...viewedJobs.map((v) => ({ value: v?.category, weight: 2 })),
    ...alertList.flatMap((a) => ((a?.sectors) || []).map((s) => ({ value: s, weight: 2 }))),
  ];
  const sector = topWeighted(sectorEntries);

  // ── Company: clicked employer (strongest) > most-viewed employer.
  const company = topWeighted([
    { value: clk.company, weight: CLICK_WEIGHT },
    ...viewedJobs.map((v) => ({ value: v?.company, weight: 1 })),
  ]);

  // ── Search query: most recent search, else newest viewed-job title-ish, else
  //    alert keywords / source title.
  const recentSearch = searches
    .filter((s) => s && !isBlank(s.query))
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))[0]?.query || '';
  const alertQuery = alertList
    .map((a) => (Array.isArray(a?.keywords) && a.keywords.length ? a.keywords.join(' ') : a?.sourceJobTitle))
    .find((q) => !isBlank(q)) || '';
  const searchQuery = recentSearch || alertQuery;

  const derived = {
    location_interest: location,
    geo_city: location,
    sector_interest: sector,
    job_category: sector,
    job_company: company,
    job_search_query: searchQuery,
  };

  const patch = {};
  for (const field of PERSONALIZATION_FIELDS) {
    if (isBlank(sub[field]) && !isBlank(derived[field])) patch[field] = derived[field];
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
