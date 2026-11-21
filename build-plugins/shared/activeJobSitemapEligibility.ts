export interface ActiveJobSitemapCandidate {
  description?: unknown;
  descriptionByLocale?: Partial<Record<ActiveJobSitemapLocale, unknown>> | null;
  needsRetranslation?: unknown;
  sourceLang?: unknown;
}

export type ActiveJobSitemapLocale = 'it' | 'en' | 'de' | 'fr';

const MIN_SITEMAP_DESCRIPTION_WORDS = 50;

function contentWordCount(parts: unknown[]): number {
  return parts
    .map((part) => String(part || '').replace(/<[^>]+>/g, ' '))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function isActiveJobSitemapEligible(job: ActiveJobSitemapCandidate): boolean {
  if (job.needsRetranslation === true && (job.sourceLang || 'it') !== 'it') return false;

  const wordCount = contentWordCount([
    job.descriptionByLocale?.it || job.description || '',
  ]);

  return wordCount >= MIN_SITEMAP_DESCRIPTION_WORDS;
}

export interface ActiveJobLocaleIndexabilityDecision {
  canonicalUrl: string;
  effectiveCanonicalUrl: string;
  hasIndexableRenderedBody: boolean;
  sourceDetailWordCount: number;
}

/**
 * Decide whether one rendered locale is both indexable and sitemap-safe.
 *
 * The renderer and sitemap must call this same predicate. A job-level Italian
 * description proves that the listing can own an Italian sitemap group; it
 * does not prove that every translated page has enough source content or that
 * the page is self-canonical.
 */
export function isActiveJobLocaleIndexable(
  _job: ActiveJobSitemapCandidate,
  _locale: ActiveJobSitemapLocale,
  decision: ActiveJobLocaleIndexabilityDecision,
): boolean {
  if (decision.effectiveCanonicalUrl !== decision.canonicalUrl) return false;
  return decision.hasIndexableRenderedBody
    || decision.sourceDetailWordCount >= MIN_SITEMAP_DESCRIPTION_WORDS;
}

export function isActiveJobLocaleSitemapEligible(
  job: ActiveJobSitemapCandidate,
  locale: ActiveJobSitemapLocale,
  decision: ActiveJobLocaleIndexabilityDecision,
): boolean {
  return isActiveJobSitemapEligible(job)
    && isActiveJobLocaleIndexable(job, locale, decision);
}
