/**
 * Every slug an expired/recovered job has ever been addressable by, across all
 * locales and its rename history: `slug`, `slugByLocale.*`, `previousSlugs`,
 * `previousSlugsByLocale.*`.
 *
 * The soft-landing build plugin (jobsSeoPagesPlugin) indexes expired jobs by
 * each of these so an orphan URL that matches ANY historical slug of a job
 * resolves to that job's recovered content. Extracted into one place because
 * the plugin builds that index in two passes — the recency-capped
 * expired-jobs.json and the uncapped per-crawler slices — and both must derive
 * variants identically or the long-tail augmentation would key differently than
 * the primary index and silently miss matches.
 *
 * Order is stable and meaningful: the canonical `slug` comes first so
 * first-write-wins consumers prefer it as the map's representative entry.
 */
export function expiredJobSlugVariants(job: {
  slug?: string;
  slugByLocale?: Record<string, unknown> | null;
  previousSlugs?: unknown[] | null;
  previousSlugsByLocale?: Record<string, unknown> | null;
}): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (s: unknown) => {
    if (typeof s === 'string' && s && !seen.has(s)) {
      seen.add(s);
      variants.push(s);
    }
  };

  push(job?.slug);
  if (job?.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const s of Object.values(job.slugByLocale)) push(s);
  }
  if (Array.isArray(job?.previousSlugs)) {
    for (const s of job.previousSlugs) push(s);
  }
  if (job?.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    for (const arr of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(arr)) for (const s of arr) push(s);
    }
  }
  return variants;
}
