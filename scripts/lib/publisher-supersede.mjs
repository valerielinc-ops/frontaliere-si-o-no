// Publisher-supersedes-crawled dedup.
//
// When an employer publishes their OWN ad via the publisher portal, that
// authoritative listing must supersede any crawled scrape of the same role —
// otherwise the job appears twice (free crawled + the employer's ad), which
// undermines the paid upgrade ("perché pago se il mio gratis resta lì?").
//
// Matching is on companyKey + normalized title + normalized LOCATION so only the
// SAME role at the SAME place is dropped. Location is part of the key because:
//   - the publisher projection emits ONE record per location (same title/companyKey);
//   - crawlers tag companyKey at the company level;
//   - each /lavoro/<slug-with-location> is a DISTINCT indexed SEO page.
// Without location in the key, publishing a role for city A would also drop the
// crawled pages for cities B and C (which the employer never published) → silent
// de-index + traffic loss with no publisher replacement. The employer's own
// (publisher-submitted) record is always kept; only crawled duplicates removed.

import { slugifyPublisher, PUBLISHER_SOURCE_KEY } from './publisherJobProjection.mjs';
import { addPreviousSlugForLocale } from './dedicated-crawler-common.mjs';

/** Stable match key for "same employer + same role + same location". */
export function supersedeKey(job) {
  if (!job || !job.companyKey || !job.title) return null;
  return `${job.companyKey}||${slugifyPublisher(job.title)}||${slugifyPublisher(job.location || '')}`;
}

/**
 * Drop crawled jobs that duplicate an employer-published (publisher-submitted)
 * ad for the same companyKey + normalized title.
 *
 * Before dropping a crawled duplicate, its already-indexed slug(s) are folded
 * into the kept publisher record's previousSlugs / previousSlugsByLocale, so the
 * existing slug-history redirect bridge emits a 301 from the old crawled URL to
 * the publisher slug in the SAME run — no 404 window, no lost SEO equity.
 *
 * @param {Array<object>} jobs - assembled, already-deduped job records
 * @returns {{ jobs: Array<object>, superseded: number }}
 */
export function supersedeCrawledByPublisher(jobs) {
  // First publisher record per key is the one we keep + bridge onto.
  const publisherByKey = new Map();
  for (const job of jobs) {
    if (job?.source === PUBLISHER_SOURCE_KEY) {
      const k = supersedeKey(job);
      if (k && !publisherByKey.has(k)) publisherByKey.set(k, job);
    }
  }
  if (publisherByKey.size === 0) return { jobs, superseded: 0 };

  let superseded = 0;
  const out = jobs.filter((job) => {
    if (job?.source === PUBLISHER_SOURCE_KEY) return true; // keep the employer's own ad
    const k = supersedeKey(job);
    if (k && publisherByKey.has(k)) {
      bridgeSlugHistory(publisherByKey.get(k), job); // preserve SEO before dropping
      superseded++;
      return false;
    }
    return true;
  });
  return { jobs: out, superseded };
}

/**
 * Fold a superseded crawled job's slug history into the kept publisher record so
 * the redirect bridge (trackSlugHistoryDrift) emits a 301 from the old indexed
 * crawled URL(s) to the publisher slug. Never self-bridges the publisher's own slug.
 */
export function bridgeSlugHistory(pubRec, crawled) {
  if (!pubRec || !crawled) return;

  const addBridged = (loc, val) => {
    if (!loc || !val) return;
    const pubLocSlug = (pubRec.slugByLocale && pubRec.slugByLocale[loc]) || pubRec.slug;
    if (String(val) === String(pubLocSlug)) return; // don't self-bridge
    addPreviousSlugForLocale(pubRec, loc, String(val), 20, 'publisher-supersede.bridgeSlugHistory');
  };

  // Flat: crawled.slug + its own prior previousSlugs bridge onto the IT locale
  // (this codebase's convention: job.slug mirrors slugByLocale.it).
  addBridged('it', crawled.slug);
  for (const s of (crawled.previousSlugs || [])) addBridged('it', s);

  // Per-locale: crawled.slugByLocale[loc] + crawled.previousSlugsByLocale[loc].
  for (const [loc, s] of Object.entries(crawled.slugByLocale || {})) addBridged(loc, s);
  for (const [loc, arr] of Object.entries(crawled.previousSlugsByLocale || {})) {
    for (const s of (Array.isArray(arr) ? arr : [])) addBridged(loc, s);
  }
}
