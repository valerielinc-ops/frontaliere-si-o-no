import { resolveLegacyGermanSectionPath } from './legacyGermanSectionAliases';

export type ExpiredEmitLocale = 'it' | 'en' | 'de' | 'fr';

export type ExpiredEmitPathResolution =
 | { kind: 'emit'; path: string; canonicalizedLegacySection: boolean }
 | { kind: 'skip'; reason: 'active-slug' | 'unroutable-occupied'; targetPath?: string };

export interface ResolveExpiredEmitPathOptions {
 locale: ExpiredEmitLocale;
 trackedPath: string;
 slug: string;
 isActiveSlug: (slug: string, locale: ExpiredEmitLocale) => boolean;
 isTargetOccupied: (canonicalPath: string, locale: ExpiredEmitLocale) => boolean;
}

/**
 * Choose the only path where an expired page may be written. Active route
 * ownership is locale-specific and supplied by the full source registry, so a
 * split locale build makes the same decision as an all-locale build.
 */
export function resolveExpiredEmitPath({
 locale,
 trackedPath,
 slug,
 isActiveSlug,
 isTargetOccupied,
}: ResolveExpiredEmitPathOptions): ExpiredEmitPathResolution {
 if (isActiveSlug(slug, locale)) return { kind: 'skip', reason: 'active-slug' };

 const legacyPath = locale === 'de' ? resolveLegacyGermanSectionPath(trackedPath) : null;
 if (!legacyPath) {
  return { kind: 'emit', path: trackedPath, canonicalizedLegacySection: false };
 }

 if (isTargetOccupied(legacyPath.canonicalPath, locale)) {
  return {
   kind: 'skip',
   reason: 'unroutable-occupied',
   targetPath: legacyPath.canonicalPath,
  };
 }
 return {
  kind: 'emit',
  path: legacyPath.canonicalPath,
  canonicalizedLegacySection: true,
 };
}
