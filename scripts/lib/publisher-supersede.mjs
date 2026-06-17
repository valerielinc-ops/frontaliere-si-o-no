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

/** Stable match key for "same employer + same role + same location". */
export function supersedeKey(job) {
  if (!job || !job.companyKey || !job.title) return null;
  return `${job.companyKey}||${slugifyPublisher(job.title)}||${slugifyPublisher(job.location || '')}`;
}

/**
 * Drop crawled jobs that duplicate an employer-published (publisher-submitted)
 * ad for the same companyKey + normalized title.
 *
 * @param {Array<object>} jobs - assembled, already-deduped job records
 * @returns {{ jobs: Array<object>, superseded: number }}
 */
export function supersedeCrawledByPublisher(jobs) {
  const publisherKeys = new Set();
  for (const job of jobs) {
    if (job?.source === PUBLISHER_SOURCE_KEY) {
      const k = supersedeKey(job);
      if (k) publisherKeys.add(k);
    }
  }
  if (publisherKeys.size === 0) return { jobs, superseded: 0 };

  let superseded = 0;
  const out = jobs.filter((job) => {
    if (job?.source === PUBLISHER_SOURCE_KEY) return true; // keep the employer's own ad
    const k = supersedeKey(job);
    if (k && publisherKeys.has(k)) {
      superseded++;
      return false;
    }
    return true;
  });
  return { jobs: out, superseded };
}
