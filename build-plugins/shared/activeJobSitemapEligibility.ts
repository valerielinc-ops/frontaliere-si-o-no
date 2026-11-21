export interface ActiveJobSitemapCandidate {
  description?: unknown;
  descriptionByLocale?: { it?: unknown } | null;
  needsRetranslation?: unknown;
  sourceLang?: unknown;
}

const MIN_SITEMAP_DESCRIPTION_WORDS = 50;

export function isActiveJobSitemapEligible(job: ActiveJobSitemapCandidate): boolean {
  if (job.needsRetranslation === true && (job.sourceLang || 'it') !== 'it') return false;

  const description = String(job.descriptionByLocale?.it || job.description || '');
  const wordCount = description
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

  return wordCount >= MIN_SITEMAP_DESCRIPTION_WORDS;
}
