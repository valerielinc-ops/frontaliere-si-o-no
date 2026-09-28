/**
 * Ghost matching between expired and active jobs.
 *
 * A "ghost" is an expired entry that still refers to an active posting: same
 * title+company+location, and either a shared slug or the same IT slug. The
 * assembler removes ghosts from the expired slices (reconcileGhostExpired),
 * and the crawler-slice write guard has to prove that such a prune removed
 * nothing but ghosts. Both read the rule from here, so the proof cannot drift
 * away from the prune it accepts.
 *
 * Matched on title+company+location, NOT title+company alone: see the #4602
 * note on reconcileGhostExpired in scripts/assemble-jobs-dataset.mjs.
 */

function titleCompanyLocationKey(job) {
  return `${(job?.title || '').toLowerCase().trim()}||${(job?.company || '').toLowerCase().trim()}||${(job?.location || '').toLowerCase().trim()}`;
}

/** Index the active jobs once: first job per title+company+location, and every current or previous slug. */
export function buildActiveGhostIndex(activeJobs) {
  const byTitleCompanyLocation = Object.create(null);
  const slugs = new Set();
  for (const job of activeJobs || []) {
    const key = titleCompanyLocationKey(job);
    if (!byTitleCompanyLocation[key]) byTitleCompanyLocation[key] = job;
    if (job.slugByLocale) Object.values(job.slugByLocale).forEach((s) => slugs.add(s));
    if (job.previousSlugs) job.previousSlugs.forEach((s) => slugs.add(s));
    if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
      for (const arr of Object.values(job.previousSlugsByLocale)) {
        if (Array.isArray(arr)) arr.forEach((s) => slugs.add(s));
      }
    }
  }
  return { byTitleCompanyLocation, slugs };
}

/** The active job an expired entry is a ghost of, or null when it is a real expiry. */
export function findActiveGhostMatch(index, expired) {
  const match = index.byTitleCompanyLocation[titleCompanyLocationKey(expired)];
  if (!match) return null;
  const expiredSlugs = expired.slugByLocale ? Object.values(expired.slugByLocale) : [];
  const hasSlugOverlap = expiredSlugs.some((s) => index.slugs.has(s));
  const sameItSlug = expired.slugByLocale?.it === match.slugByLocale?.it;
  return hasSlugOverlap || sameItSlug ? match : null;
}
