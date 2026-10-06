import {
 resolveCantonSection,
 resolveJobCanton,
 SECTION_LEGACY_TI,
 type CantonLocale,
} from './cantonSection';

export type CanonicalJobDetailLocale = CantonLocale;
export type CanonicalJobDetailJob = { canton?: string; location?: string };
export type CanonicalJobDetailTarget = CanonicalJobDetailJob | string;

const LEGACY_TI_SECTION_SLUGS = new Set(Object.values(SECTION_LEGACY_TI));

/**
 * Build the one canonical detail path for a job in a locale.
 *
 * Callers that already resolved the job canton may pass it as the fourth
 * argument. This keeps the hot SSG path from resolving the same job once per
 * locale link while preserving the pure job-based API for smaller emitters.
 * Landing models may pass their existing TI section slug as the fifth
 * argument so their public URL shape remains stable while non-TI jobs still
 * route to the section for their own canton.
 * The string target is retained for the legacy sitemap helper, whose caller
 * already owns a resolved canton code.
 */
export function buildCanonicalJobDetailPath(
  locale: CanonicalJobDetailLocale,
  target: CanonicalJobDetailTarget,
  slug: string,
  resolvedCanton?: string,
  legacySectionSlug?: string,
): string {
  const canton = typeof target === 'string'
    ? target
    : resolvedCanton ?? resolveJobCanton(target);
  const normalizedLegacySection = legacySectionSlug?.replace(/^\/+|\/+$/g, '');
  const section = canton === 'TI'
    && normalizedLegacySection
    && LEGACY_TI_SECTION_SLUGS.has(normalizedLegacySection)
    ? normalizedLegacySection
    : resolveCantonSection(locale, canton);
  const path = [locale === 'it' ? '' : locale, section, slug]
    .filter(Boolean)
    .join('/');
  return `/${path}/`;
}
