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

/**
 * True when a job came from the group-wide swatchgroup.com pool (as opposed
 * to a sub-brand's own-domain adapter like eta.ch / swisstiming.com).
 *
 * Matched on the job URL host, NOT on `companyKey` — see
 * selectSharedPoolBrandJobs() for why the key cannot be trusted here. Both
 * `https://www.swatchgroup.com/...` and the bare-apex
 * `https://swatchgroup.com/...` form occur in the live pool (verified
 * 2026-08-10: job 32757 is persisted apex-only while its pool siblings carry
 * the `www.` host), so the check is a hostname suffix test, not equality.
 *
 * @param {{url?: string, companyDomain?: string}} job
 * @returns {boolean}
 */
export function isSharedSwatchPoolJob(job) {
  const host = (() => {
    try {
      return new URL(String(job?.url || '')).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (host === 'swatchgroup.com' || host.endsWith('.swatchgroup.com')) return true;
  return String(job?.companyDomain || '').trim().toLowerCase() === 'swatchgroup.com';
}

/**
 * Select the jobs that genuinely belong to `companyKey` out of the merged
 * multi-brand crawl pool, and stamp the correct key on them.
 *
 * WHY this exists (issue #5392, root cause measured 2026-08-10). The caller
 * in update-swatchgroup-jobs.mjs used to narrow the pool by `companyKey`
 * FIRST and only then apply filterSharedPoolJobsByBrand():
 *
 *     const raw = allJobs.filter((j) => normalizeKey(j.companyKey) === ck);
 *     const kept = filterSharedPoolJobsByBrand(ck, raw);
 *
 * That defeats the whole point of the brand filter, which exists precisely
 * because `companyKey` is NOT trustworthy on this pool. The shared crawler
 * de-duplicates by URL across the per-companyKey iterations, so each pooled
 * posting is stamped once — with whichever key happened to reach it first —
 * and is never re-stamped for the other five. Measured on the live pool
 * (data/jobs-crawler-summaries/by-crawler/swatchgroup.json, run
 * 2026-08-09T21:52Z): all 53 pooled jobs carry just TWO keys,
 * `swatch-group-assembly` (26 in the sample) and `rado` (4) — including the
 * genuine Comadur posting
 *
 *     { company: "Comadur SA", companyKey: "swatch-group-assembly",
 *       title: "Comptable Polyvalent",
 *       url: "https://swatchgroup.com/fr/job/32757" }
 *
 * So for ck='comadur-swatch-group' the pre-filter yielded [] and the brand
 * filter never saw the one job it was written to catch: 0 jobs, and the
 * crawler-health monitor opened "3 consecutive runs returned 0 jobs". The
 * same pre-filter silently hid the 3 live Rado apprenticeship postings
 * (jobs 32617/32619/32620, hiringOrganization "Rado Watch Co. Ltd.") behind
 * rado's EMPTY_OK_CRAWLERS registration.
 *
 * The fix: for a shared-pool brand, run the brand-identity filter over the
 * WHOLE swatchgroup.com pool and ignore the stamped key entirely, then
 * re-stamp `companyKey` on the survivors so downstream consumers (slice
 * writer, dataset assembler, employer hub) see the real employer. Brands
 * with their own-domain adapter (eta-sa, swiss-timing) are unaffected and
 * keep the exact key-equality selection they always had.
 *
 * @param {string} companyKey
 * @param {Array<object>} allJobs merged pool for this crawler run
 * @returns {Array<object>} jobs belonging to `companyKey`, key re-stamped
 */
export function selectSharedPoolBrandJobs(companyKey, allJobs) {
  const key = normalizeKey(companyKey);
  const jobs = Array.isArray(allJobs) ? allJobs : [];
  const pattern = SHARED_POOL_BRAND_PATTERNS.get(key);

  if (!pattern) {
    // Own-domain sub-brand: `companyKey` is reliable, keep the old behaviour.
    return jobs.filter((job) => normalizeKey(job?.companyKey || '') === key);
  }

  return jobs
    .filter((job) => isSharedSwatchPoolJob(job) && pattern.test(String(job?.company || '')))
    .map((job) => (normalizeKey(job?.companyKey || '') === key ? job : { ...job, companyKey: companyKey }));
}
