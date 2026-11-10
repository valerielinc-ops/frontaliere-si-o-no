export const JOB_OG_DEFERRED_R2_MANIFEST = '.deferred-r2-og.json';
export const JOB_OG_DEFERRED_FALLBACKS = '.deferred-fallbacks.json';

function postingTimestamp(job) {
  const value = job?.datePosted ?? job?.postedDate;
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function renderSlug(job) {
  return String(job?.slugByLocale?.it || job?.slug || job?.id || '');
}

/** Sort active jobs by view count, then posting date, with a stable slug tie-breaker. */
export function sortJobsForOgRender(jobs, popularity = {}) {
  return [...jobs].sort((left, right) => {
    const leftViews = Number(popularity[renderSlug(left)]) || 0;
    const rightViews = Number(popularity[renderSlug(right)]) || 0;
    if (rightViews !== leftViews) return rightViews - leftViews;
    const byDate = postingTimestamp(right) - postingTimestamp(left);
    if (byDate !== 0) return byDate;
    const leftSlug = renderSlug(left);
    const rightSlug = renderSlug(right);
    return leftSlug < rightSlug ? -1 : leftSlug > rightSlug ? 1 : 0;
  });
}

/** `null` means unlimited. Invalid or negative values fail safe to zero. */
export function parseJobOgRenderBudgetMs(rawValue) {
  if (rawValue == null || String(rawValue).trim() === '') return null;
  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds * 1000);
}

export function isJobOgRenderBudgetSpent(startedAtMs, budgetMs, nowMs = Date.now()) {
  return budgetMs !== null && nowMs - startedAtMs >= budgetMs;
}

/**
 * Cache filenames are `<slug>.<photoKey>.<logoFingerprint>.<version>.webp`.
 * Probe each dot boundary so the slug may itself contain dots without making
 * a deferred job's stale cache entry eligible for pruning.
 */
export function cacheEntryBelongsToSlugs(entry, slugs) {
  if (!(slugs instanceof Set) || slugs.size === 0) return false;
  let boundary = entry.indexOf('.');
  while (boundary > 0) {
    if (slugs.has(entry.slice(0, boundary))) return true;
    boundary = entry.indexOf('.', boundary + 1);
  }
  return false;
}

export function deferredJobOgImageFallbackUrl(file, cdnBase, fallbackSlugs) {
  if (!file.startsWith('jobs/') || !file.endsWith('.webp')) return null;
  const slug = file.slice('jobs/'.length, -'.webp'.length);
  if (!fallbackSlugs.has(slug)) return null;
  return `${cdnBase}/og/jobs/archive-landing-card.webp`;
}
