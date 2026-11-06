/**
 * sectionPagesPathsData.ts — browser-safe canonical path table for the 7
 * Google-News topic section pages (sectionPagesPlugin.ts: fisco, lavoro,
 * salari, cambio, trasporti, pensioni, dogana × 4 locales = 28 pages).
 * Split out because the plugin imports `node:fs`/`node:path`, `ARTICLES`
 * and `buildSeoPageHtml` and is therefore unsafe to bundle into the client
 * — mirrors the exchangeSsgPaths.ts / jobMarketSnapshotChCantonPathsData.ts
 * split. The plugin imports `SECTION_PATHS` from here so the literal path
 * table has one source of truth.
 */

export type SectionId = 'fisco' | 'lavoro' | 'salari' | 'cambio' | 'trasporti' | 'pensioni' | 'dogana';

export const SECTION_IDS: readonly SectionId[] = [
  'fisco',
  'lavoro',
  'salari',
  'cambio',
  'trasporti',
  'pensioni',
  'dogana',
];

export type SectionPageLocale = 'it' | 'en' | 'de' | 'fr';

export const SECTION_PAGE_LOCALES: readonly SectionPageLocale[] = ['it', 'en', 'de', 'fr'];

export const SECTION_PATHS: Record<SectionId, Record<SectionPageLocale, string>> = {
  fisco: { it: '/fisco/', en: '/en/tax/', de: '/de/steuern/', fr: '/fr/fiscalite/' },
  lavoro: { it: '/lavoro-frontaliere/', en: '/en/cross-border-work/', de: '/de/grenzgaenger-arbeit/', fr: '/fr/travail-frontalier/' },
  salari: { it: '/salari/', en: '/en/salaries/', de: '/de/loehne/', fr: '/fr/salaires/' },
  cambio: { it: '/cambio-valuta/', en: '/en/currency-exchange/', de: '/de/waehrung/', fr: '/fr/change/' },
  trasporti: { it: '/trasporti/', en: '/en/transport/', de: '/de/verkehr/', fr: '/fr/transports/' },
  pensioni: { it: '/pensioni/', en: '/en/pensions/', de: '/de/renten/', fr: '/fr/retraites/' },
  dogana: { it: '/dogana/', en: '/en/customs/', de: '/de/zoll/', fr: '/fr/douane/' },
};

export interface SectionPageMatch {
  sectionId: SectionId;
  locale: SectionPageLocale;
  path: string;
}

function normalizePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

const PATH_INDEX: ReadonlyMap<string, SectionPageMatch> = new Map(
  SECTION_IDS.flatMap((sectionId) =>
    SECTION_PAGE_LOCALES.map((locale) => {
      const path = SECTION_PATHS[sectionId][locale];
      return [normalizePath(path), { sectionId, locale, path }] as const;
    }),
  ),
);

export function isSectionPagePath(urlPath: string): boolean {
  return PATH_INDEX.has(normalizePath(urlPath));
}

export function parseSectionPagePath(urlPath: string): SectionPageMatch | null {
  return PATH_INDEX.get(normalizePath(urlPath)) ?? null;
}
