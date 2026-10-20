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

// These category landing pages already exist in jobsSeoPagesPlugin. Reuse
// their canonical URLs when the weekly publisher promotes the same category,
// instead of emitting a second indexable page with the same job inventory.
const EXISTING_CATEGORY_SLUGS: Record<string, Record<JobBoardLocale, string>> = {
  health: {
    it: 'categoria-sanita',
    en: 'category-health',
    de: 'kategorie-gesundheit',
    fr: 'categorie-sante',
  },
  admin: {
    it: 'categoria-amministrazione',
    en: 'category-admin',
    de: 'kategorie-verwaltung',
    fr: 'categorie-administration',
  },
  finance: {
    it: 'categoria-finanza',
    en: 'category-finance',
    de: 'kategorie-finanzen',
    fr: 'categorie-finance',
  },
  tech: {
    it: 'categoria-informatica',
    en: 'category-tech',
    de: 'kategorie-technik',
    fr: 'categorie-tech',
  },
  engineering: {
    it: 'categoria-ingegneria',
    en: 'category-engineering',
    de: 'kategorie-ingenieurwesen',
    fr: 'categorie-ingenierie',
  },
  hospitality: {
    it: 'categoria-ristorazione',
    en: 'category-hospitality',
    de: 'kategorie-gastgewerbe',
    fr: 'categorie-hotellerie',
  },
  sales: {
    it: 'categoria-vendita',
    en: 'category-sales',
    de: 'kategorie-vertrieb',
    fr: 'categorie-vente',
  },
  other: {
    it: 'categoria-altro',
    en: 'category-other',
    de: 'kategorie-andere',
    fr: 'categorie-autre',
  },
};

const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKnownExistingCategorySlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXISTING_CATEGORY_SLUGS, slug);
}

export function buildAutoSectorHubPath(
  locale: JobBoardLocale,
  slug: string,
  routeKind: AutoSectorHubRouteKind = 'dynamic',
): string {
  if (!SAFE_SLUG_RE.test(slug)) throw new Error(`Invalid automatic sector-hub slug: ${slug}`);
  const prefix = SECTOR_HUB_LOCALE_PREFIX[locale];
  const section = SECTOR_HUB_SECTION[locale];
  const existingCategory = routeKind === 'static-category' ? EXISTING_CATEGORY_SLUGS[slug]?.[locale] : undefined;
  if (routeKind === 'static-category' && !existingCategory) {
    throw new Error(`Automatic sector-hub slug has no static category route: ${slug}`);
  }
  if (existingCategory) {
    return `${prefix}/${section}/${existingCategory}/`.replace(/\/+/g, '/');
  }
  return `${prefix}/${section}/${AUTO_SECTOR_HUB_SEGMENT[locale]}/${slug}/`.replace(/\/+/g, '/');
}

export function autoSectorHubUsesExistingCategoryPath(routeKind: AutoSectorHubRouteKind): boolean {
  return routeKind === 'static-category';
}

export function parseAutoSectorHubPath(
  parts: readonly string[],
  locale: JobBoardLocale,
): string | null {
  if (parts.length !== 3 || parts[0] !== SECTOR_HUB_SECTION[locale]
    || parts[1] !== AUTO_SECTOR_HUB_SEGMENT[locale] || !SAFE_SLUG_RE.test(parts[2])) return null;
  return parts[2];
}
