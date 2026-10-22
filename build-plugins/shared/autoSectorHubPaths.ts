import type { JobBoardLocale } from '../jobBoardSeoPure';
import {
  SECTOR_HUB_LOCALE_PREFIX,
  SECTOR_HUB_SECTION,
} from './jobSectorPaths';

export const AUTO_SECTOR_HUB_SEGMENT: Record<JobBoardLocale, string> = {
  it: 'settore',
  en: 'sector',
  de: 'branche',
  fr: 'secteur',
};

export type AutoSectorHubRouteKind = 'dynamic' | 'static-category';

/**
 * Category paths are shared by the legacy job-board emitter and the automatic
 * sector publisher. Keep the key order stable: it is also the order used by
 * category navigation and the deterministic sitemap output.
 */
export const JOB_CATEGORY_KEYS = [
  'health',
  'finance',
  'tech',
  'engineering',
  'admin',
  'hospitality',
  'sales',
  'other',
] as const;

export type JobCategoryKey = typeof JOB_CATEGORY_KEYS[number];

export const JOB_CATEGORY_SLUGS: Record<JobCategoryKey, Record<JobBoardLocale, string>> = {
  health: { it: 'sanita', en: 'health', de: 'gesundheit', fr: 'sante' },
  finance: { it: 'finanza', en: 'finance', de: 'finanzen', fr: 'finance' },
  tech: { it: 'informatica', en: 'tech', de: 'technik', fr: 'tech' },
  engineering: { it: 'ingegneria', en: 'engineering', de: 'ingenieurwesen', fr: 'ingenierie' },
  admin: { it: 'amministrazione', en: 'admin', de: 'verwaltung', fr: 'administration' },
  hospitality: { it: 'ristorazione', en: 'hospitality', de: 'gastgewerbe', fr: 'hotellerie' },
  sales: { it: 'vendita', en: 'sales', de: 'vertrieb', fr: 'vente' },
  other: { it: 'altro', en: 'other', de: 'andere', fr: 'autre' },
};

export const JOB_CATEGORY_PREFIX: Record<JobBoardLocale, string> = {
  it: 'categoria',
  en: 'category',
  de: 'kategorie',
  fr: 'categorie',
};

export function isKnownExistingCategorySlug(slug: string): slug is JobCategoryKey {
  return (JOB_CATEGORY_KEYS as readonly string[]).includes(slug);
}

function trimPathSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

export function buildJobCategorySlug(locale: JobBoardLocale, category: JobCategoryKey): string {
  return `${JOB_CATEGORY_PREFIX[locale]}-${JOB_CATEGORY_SLUGS[category][locale]}`;
}

/**
 * Build the one canonical category path for a locale and a canton-aware
 * section. `pageSlug` is the optional pagination segment (for example
 * `pagina-2`). The caller supplies the section owner; no other emitter may
 * reconstruct this path from a second slug table.
 */
export function buildJobCategoryPath(
  locale: JobBoardLocale,
  section: string,
  category: JobCategoryKey,
  pageSlug?: string,
): string {
  const page = pageSlug ? `/${trimPathSlashes(pageSlug)}` : '';
  return `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${trimPathSlashes(section)}/${buildJobCategorySlug(locale, category)}${page}/`
    .replace(/\/+/g, '/');
}

export type AutoSectorHubPathOwner = 'jobsSeoPagesPlugin' | 'autoSectorHubPagesPlugin';

/**
 * Static-category publications reuse the job-board page. Dynamic publications
 * are the sole responsibility of autoSectorHubPagesPlugin. Keeping this
 * decision beside the path builder prevents a canonical/noindex decision from
 * drifting away from the file owner.
 */
export function autoSectorHubPathOwner(routeKind: AutoSectorHubRouteKind): AutoSectorHubPathOwner {
  return routeKind === 'static-category' ? 'jobsSeoPagesPlugin' : 'autoSectorHubPagesPlugin';
}

const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function buildAutoSectorHubPath(
  locale: JobBoardLocale,
  slug: string,
  routeKind: AutoSectorHubRouteKind = 'dynamic',
): string {
  if (!SAFE_SLUG_RE.test(slug)) throw new Error(`Invalid automatic sector-hub slug: ${slug}`);
  const prefix = SECTOR_HUB_LOCALE_PREFIX[locale];
  const section = SECTOR_HUB_SECTION[locale];
  const existingCategory = routeKind === 'static-category' && isKnownExistingCategorySlug(slug)
    ? slug
    : undefined;
  if (routeKind === 'static-category' && !existingCategory) {
    throw new Error(`Automatic sector-hub slug has no static category route: ${slug}`);
  }
  if (existingCategory) {
    return buildJobCategoryPath(locale, section, existingCategory);
  }
  return `${prefix}/${section}/${AUTO_SECTOR_HUB_SEGMENT[locale]}/${slug}/`.replace(/\/+/g, '/');
}

export function autoSectorHubUsesExistingCategoryPath(routeKind: AutoSectorHubRouteKind): boolean {
  return autoSectorHubPathOwner(routeKind) === 'jobsSeoPagesPlugin';
}

export function parseAutoSectorHubPath(
  parts: readonly string[],
  locale: JobBoardLocale,
): string | null {
  if (parts.length !== 3 || parts[0] !== SECTOR_HUB_SECTION[locale]
    || parts[1] !== AUTO_SECTOR_HUB_SEGMENT[locale] || !SAFE_SLUG_RE.test(parts[2])) return null;
  return parts[2];
}
