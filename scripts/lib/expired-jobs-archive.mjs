/**
 * Per-crawler expired-jobs archival.
 *
 * Dedicated crawlers refetch the upstream ATS each run and overwrite their
 * `data/jobs/by-crawler/<key>.json` slice with the current vacancies. When a
 * job disappears from upstream (vacancy filled, listing removed) it is
 * dropped from the slice silently — `mergePreserveLocaleData` iterates only
 * the fresh batch, so any prior entry not present in the new fetch is gone.
 *
 * Without archival, indexed-by-Google detail URLs (and their previousSlug
 * bridges) 404 on the next deploy instead of rendering JobExpiredView. This
 * module captures those drops into `data/jobs/expired/by-crawler/<key>.json`
 * so the build plugin can emit the soft-landing page.
 *
 * Shape of an expired entry mirrors `cleanup-jobs.mjs:buildExpiredEntry`
 * so both code paths produce the same on-disk format.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { compareExpiredAt } from './compare-expired-at.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EXPIRED_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');

/**
 * Build an expired-job archive entry from a job object. Preserves the fields
 * the build plugin needs to render an enriched JobExpiredView under any
 * locale prefix (slugByLocale, descriptionByLocale, previousSlugs, salary +
 * address). Mirrors `scripts/cleanup-jobs.mjs:buildExpiredEntry` byte for byte.
 *
 * @param {object} job
 * @returns {object} expired entry
 */
export function buildExpiredEntry(job) {
  const entry = {
    slug: job.slug,
    title: job.title || '',
    titleByLocale: job.titleByLocale || {},
    company: job.company || '',
    companyKey: job.companyKey || '',
    location: job.location || '',
    addressLocality: job.addressLocality || '',
    descriptionByLocale: job.descriptionByLocale || {},
    slugByLocale: job.slugByLocale || {},
    sector: job.sector || '',
    expiredAt: new Date().toISOString(),
    previousSlugs:
      Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0
        ? [...job.previousSlugs]
        : undefined,
    previousSlugsByLocale:
      job.previousSlugsByLocale &&
      typeof job.previousSlugsByLocale === 'object' &&
      Object.keys(job.previousSlugsByLocale).length > 0
        ? JSON.parse(JSON.stringify(job.previousSlugsByLocale))
        : undefined,
    postalCode: job.postalCode || '',
    streetAddress: job.streetAddress || '',
    salaryMin: job.salaryMin || null,
    salaryMax: job.salaryMax || null,
    salaryCurrency: job.salaryCurrency || 'CHF',
    salaryPeriod: job.salaryPeriod || 'YEAR',
    dedupArchive: job.dedupArchive === true ? true : undefined,
  };
  if (!entry.postalCode) delete entry.postalCode;
  if (!entry.streetAddress) delete entry.streetAddress;
  if (!entry.salaryMin) delete entry.salaryMin;
  if (!entry.salaryMax) delete entry.salaryMax;
  if (entry.dedupArchive !== true) delete entry.dedupArchive;
  return entry;
}

/**
 * Archive removed jobs to a per-crawler expired slice file.
 *
 * Merges with any existing entries by `slug`, keeping the most-recently
 * expired entry per slug. Skips jobs without a slug (no static page to land
 * on). Returns the number of newly-added entries; zero means the on-disk
 * file is unchanged.
 *
 * @param {object[]} removedJobs - Full job objects (NOT `{ id }` refs)
 * @param {string} crawlerKey
 * @param {object} [opts]
 * @param {string} [opts.dir] - Override directory (default: data/jobs/expired/by-crawler)
 * @returns {number} added count
 */
export function archiveRemovedJobsToSlice(removedJobs, crawlerKey, opts = {}) {
  if (!crawlerKey) return 0;
  if (!Array.isArray(removedJobs) || removedJobs.length === 0) return 0;

  const dir = opts.dir || DEFAULT_EXPIRED_SLICES_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const slicePath = path.join(dir, `${crawlerKey}.json`);

  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }

  const bySlug = new Map();
  for (const ej of existing) {
    if (ej?.slug) bySlug.set(ej.slug, ej);
  }
  const sizeBefore = bySlug.size;

  let added = 0;
  for (const job of removedJobs) {
    if (!job?.slug) continue;
    const entry = buildExpiredEntry(job);
    const prev = bySlug.get(entry.slug);
    if (!prev) {
      bySlug.set(entry.slug, entry);
      added++;
    } else if (compareExpiredAt(entry.expiredAt, prev.expiredAt) >= 0) {
      bySlug.set(entry.slug, entry);
    }
  }

  if (added === 0 && bySlug.size === sizeBefore) return 0;

  const archived = [...bySlug.values()].sort((a, b) =>
    compareExpiredAt(b.expiredAt, a.expiredAt),
  );
  writeJsonAtomic(slicePath, archived);
  return added;
}
