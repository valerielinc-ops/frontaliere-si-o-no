import { resolveCantonSection, resolveJobCanton, type CantonLocale } from './cantonSection';

export type CanonicalJobDetailLocale = CantonLocale;
export type CanonicalJobDetailJob = { canton?: string; location?: string };
export type CanonicalJobDetailTarget = CanonicalJobDetailJob | string;

/**
 * Build the one canonical detail path for a job in a locale.
 *
 * Callers that already resolved the job canton may pass it as the fourth
 * argument. This keeps the hot SSG path from resolving the same job once per
 * locale link while preserving the pure job-based API for smaller emitters.
 * The string target is retained for the legacy sitemap helper, whose caller
 * already owns a resolved canton code.
 */
export function buildCanonicalJobDetailPath(
  locale: CanonicalJobDetailLocale,
  target: CanonicalJobDetailTarget,
  slug: string,
  resolvedCanton?: string,
): string {
  const canton = typeof target === 'string'
    ? target
    : resolvedCanton ?? resolveJobCanton(target);
  const section = resolveCantonSection(locale, canton);
  const path = [locale === 'it' ? '' : locale, section, slug]
    .filter(Boolean)
    .join('/');
  return `/${path}/`;
}
