/**
 * Central fixture-data filter — keeps test/dev fixture jobs out of every
 * production persistence path (jobs.json, newsletter, all-known-job-slugs,
 * orphan tracking, seo-404-compat).
 *
 * The canonical fixture record was created at some point as a 4-job seed
 * for local builds when the real per-crawler slices weren't available
 * (id `fixture-corp-canonical-abc123`, company "Fixture Corp SA",
 * slug `software-engineer-fixture-corp-sa-lugano`). It leaked into multiple
 * tracked data files and into a newsletter send. This module is the single
 * gate that recognises any such record and short-circuits it.
 *
 * Detection markers (any one match is enough):
 *   - id starts with "fixture-"
 *   - companyKey starts with "fixture-" or equals "fixture"
 *   - slug starts with "fixture-" or contains "-fixture-corp-" / "-fixture-canonical-"
 *   - company exactly "Fixture Corp SA" (the canonical fixture company)
 *
 * Markers are deliberately specific — a real company called e.g. "Fixture
 * Manufacturing AG" would not be filtered (its companyKey would be
 * "fixture-manufacturing", which still matches). If a real-world fixture-named
 * employer ever appears, narrow the prefixes (e.g. require `fixture-corp-`).
 */

const FIXTURE_SLUG_RE = /^fixture-|-fixture-corp-|-fixture-canonical-/i;
const FIXTURE_ID_RE = /^fixture-/i;
const FIXTURE_COMPANY_KEY_RE = /^fixture(?:-|$)/i;
const FIXTURE_COMPANY_NAMES = new Set(['fixture corp sa', 'fixture corp']);

/** True iff the slug looks like a fixture-data slug. */
export function isFixtureSlug(slug) {
  if (!slug) return false;
  return FIXTURE_SLUG_RE.test(String(slug));
}

/** True iff the job record is a fixture-data record (any marker matches). */
export function isFixtureJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.id && FIXTURE_ID_RE.test(String(job.id))) return true;
  if (job.companyKey && FIXTURE_COMPANY_KEY_RE.test(String(job.companyKey))) return true;
  if (job.company && FIXTURE_COMPANY_NAMES.has(String(job.company).trim().toLowerCase())) return true;
  if (job.slug && FIXTURE_SLUG_RE.test(String(job.slug))) return true;
  // slugByLocale fallback — defends against future fixtures that only set per-locale slugs
  if (job.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const v of Object.values(job.slugByLocale)) {
      if (v && FIXTURE_SLUG_RE.test(String(v))) return true;
    }
  }
  return false;
}

/**
 * Drop fixture-data jobs from an array. Returns the cleaned array.
 * Logs the dropped count on stderr so it surfaces in CI logs without polluting
 * stdout reports.
 */
export function filterFixtureJobs(jobs, contextLabel = '') {
  if (!Array.isArray(jobs)) return jobs;
  const before = jobs.length;
  const cleaned = jobs.filter((j) => !isFixtureJob(j));
  const dropped = before - cleaned.length;
  if (dropped > 0) {
    const ctx = contextLabel ? ` [${contextLabel}]` : '';
    console.warn(`⚠️  Filtered ${dropped} fixture job(s) out of ${before}${ctx}`);
  }
  return cleaned;
}

/**
 * Drop fixture-data slugs from a slug array. Used by orphan/compat pipelines
 * that only see slug strings (not full job records).
 */
export function filterFixtureSlugs(slugs, contextLabel = '') {
  if (!Array.isArray(slugs)) return slugs;
  const before = slugs.length;
  const cleaned = slugs.filter((s) => {
    if (typeof s === 'string') return !isFixtureSlug(s);
    if (s && typeof s === 'object') {
      // { locale, path } shape used by orphan-indexed-job-slugs.json
      if (s.path) {
        const tail = String(s.path).replace(/\/+$/, '').split('/').pop() || '';
        return !isFixtureSlug(tail);
      }
      if (s.slug) return !isFixtureSlug(s.slug);
    }
    return true;
  });
  const dropped = before - cleaned.length;
  if (dropped > 0) {
    const ctx = contextLabel ? ` [${contextLabel}]` : '';
    console.warn(`⚠️  Filtered ${dropped} fixture slug(s) out of ${before}${ctx}`);
  }
  return cleaned;
}

/** True iff a path (e.g. "/cerca-lavoro-ticino/foo/") points at a fixture job page. */
export function isFixturePath(p) {
  if (!p) return false;
  const tail = String(p).replace(/\/+$/, '').split('/').pop() || '';
  return isFixtureSlug(tail);
}
