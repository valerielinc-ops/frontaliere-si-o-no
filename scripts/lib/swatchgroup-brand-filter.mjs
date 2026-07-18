/**
 * Brand-identity filter for Swatch Group sub-brands that share the
 * group-wide swatchgroup.com/careers job-finder seed URLs with no per-brand
 * path segment (issue #4392).
 *
 * WHY this exists: rado, comadur-swatch-group, nivarox-swatch-group and
 * swatch-group-assembly all resolve to the SAME `companyHost: swatchgroup.com`
 * generic adapter (crawlerModes: generic_ats/html/jsonld, seedUrls like
 * swatchgroup.com/careers). update-swatchgroup-jobs.mjs runs the generic
 * crawl ONCE PER companyKey and the shared engine stamps `companyKey: ck` on
 * EVERY job it extracts during that company's own iteration, regardless of
 * the job's real employer — so filtering the aggregated pool by companyKey
 * alone yields the FULL shared ~90-job Swiss pool mislabeled as `ck`, not a
 * real per-brand subset. Confirmed live 2026-07-18: the persisted
 * data/jobs/by-crawler/rado.json and swatch-group-assembly.json slices
 * carried jobs whose real employer (`job.company`) was "Omega Ltd.", "ETA SA
 * Manufacture Horlogère Suisse", "Renata AG", "The Swatch Group
 * (Deutschland) GmbH" — zero genuine Rado/Assembly jobs.
 *
 * The generic jsonld extractor DOES correctly populate `job.company` with
 * the JSON-LD `hiringOrganization.name` of the posting (verified live: e.g.
 * "ETA SA Manufacture Horlogère Suisse", "The Swatch Group Research and
 * Development Ltd", legal-entity text is the same across DE/EN/FR detail
 * pages), so this module re-derives the real per-brand subset from that
 * text instead of trusting the blindly-stamped companyKey.
 *
 * Historical check (every commit that ever touched these slices — 92 for
 * rado.json, 462 for swatch-group-assembly.json; comadur-swatch-group.json
 * and nivarox-swatch-group.json never persisted a single job in their
 * history) found ZERO instances of a genuine brand-matching `company`
 * value, so all 4 legitimately filter down to 0 jobs today — that is the
 * CORRECT output of a real filter, not a parser bug. Each pattern still
 * keys off the brand's real Swatch Group legal-entity name — Rado Watch Co.
 * Ltd / Rado Uhren AG, Comadur SA, Nivarox-FAR SA, Swatch Group Assembly SA
 * (the Ticino-based watch-assembly subsidiary, swatchgroup.com/en/companies-
 * brands/production/swatch-group-assembly) — so a genuine future posting
 * for any of them is picked up correctly instead of staying invisible.
 *
 * eta-sa-swatch-group and swiss-timing-swatch-group are deliberately NOT in
 * this map: their adapters seed from eta.ch / swisstiming.com (their own
 * domains), not the shared swatchgroup.com pool, so they don't redistribute
 * and don't need this re-filter.
 */
import { normalizeKey } from './dedicated-crawler-common.mjs';

export const SHARED_POOL_BRAND_PATTERNS = new Map([
  ['rado', /\brado\b/i],
  ['comadur-swatch-group', /\bcomadur\b/i],
  ['nivarox-swatch-group', /\bnivarox\b/i],
  ['swatch-group-assembly', /swatch group assembly/i],
]);

/**
 * Re-derive a sub-brand's real jobs from the shared swatchgroup.com pool
 * using the job's own (correctly-extracted) `company` text instead of the
 * blindly-stamped `companyKey`. Companies not in SHARED_POOL_BRAND_PATTERNS
 * (own-domain adapters) pass through unchanged.
 *
 * @param {string} companyKey
 * @param {Array<{company?: string}>} jobs
 * @returns {Array<object>}
 */
export function filterSharedPoolJobsByBrand(companyKey, jobs) {
  const pattern = SHARED_POOL_BRAND_PATTERNS.get(normalizeKey(companyKey));
  if (!pattern) return jobs;
  return (jobs || []).filter((job) => pattern.test(String(job?.company || '')));
}
