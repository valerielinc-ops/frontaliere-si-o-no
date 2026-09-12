/**
 * Sector-hub URL surface: chiavi di settore, slug per locale, costruttori di
 * path.
 *
 * PRIVO DI DIPENDENZE NODE — deliberatamente (#8125). Questo e' il modulo che
 * il bundle del browser raggiunge: `App.tsx` e `services/router.ts` hanno
 * bisogno di `SECTOR_HUB_KEYS`/`SECTOR_HUB_SLUG`/`buildSectorHubPath` perche'
 * la forma degli URL abbia UNA sola sorgente condivisa fra l'emettitore SSG e
 * il router della SPA — togliere l'arco reintrodurrebbe il drift fra URL
 * emessi e URL riconosciuti.
 *
 * La copy SEO, i matcher di settore e il lettore di `data/sector-descriptions.json`
 * restano in `build-plugins/jobSectorLanding.ts`, che importa DA qui e
 * ri-esporta questi simboli per i consumatori Node. Il verso e' quello e non
 * l'inverso: `jobSectorLanding.ts` tira dentro `shared/seoContentTokens.ts`,
 * che importa `node:fs`; se un componente SPA importasse un costruttore di path
 * DA LA', rollup risolverebbe quel builtin a `__vite-browser-external` e il
 * link della build morirebbe — non per l'uso, ma per la risoluzione del
 * binding. Non aggiungere qui import Node, nemmeno in forma namespace.
 */

import type { JobBoardLocale } from '../jobBoardSeo';
import { SECTION_LEGACY_TI } from './cantonSection';
import { SECTOR_HUB_SLUG as SHARED_SECTOR_HUB_SLUG } from './jobSectorSlugs.mjs';

export type SectorHubKey =
  | 'infermieri'
  | 'case-anziani'
  | 'educatori'
  | 'ingegneri'
  | 'autisti'
  | 'sviluppatori'
  | 'ristorazione'
  | 'oss'
  | 'logistica'
  | 'apprendistato'
  | 'medici'
  | 'fisioterapisti'
  | 'farmacisti'
  | 'data-scientist'
  | 'cybersecurity'
  | 'project-manager'
  | 'contabili'
  | 'banca'
  | 'assicurazioni'
  | 'consulenza'
  | 'avvocati'
  | 'risorse-umane'
  | 'marketing'
  | 'vendite'
  | 'commercio'
  | 'trasporti'
  | 'magazzino'
  | 'meccanici'
  | 'elettricisti'
  | 'idraulici'
  | 'edilizia'
  | 'falegnami'
  | 'industria'
  | 'orologeria'
  | 'farmaceutica'
  | 'chimica'
  | 'food'
  | 'cuochi'
  | 'camerieri'
  | 'hotel'
  | 'pulizie'
  | 'sicurezza'
  | 'scuola'
  | 'designer'
  | 'architetti'
  | 'agricoltura'
  | 'energia'
  | 'media'
  | 'tecnici';

export const SECTOR_HUB_KEYS: readonly SectorHubKey[] = [
  'infermieri',
  'case-anziani',
  'educatori',
  'ingegneri',
  'autisti',
  'sviluppatori',
  'ristorazione',
  'oss',
  'logistica',
  'apprendistato',
  'medici',
  'fisioterapisti',
  'farmacisti',
  'data-scientist',
  'cybersecurity',
  'project-manager',
  'contabili',
  'banca',
  'assicurazioni',
  'consulenza',
  'avvocati',
  'risorse-umane',
  'marketing',
  'vendite',
  'commercio',
  'trasporti',
  'magazzino',
  'meccanici',
  'elettricisti',
  'idraulici',
  'edilizia',
  'falegnami',
  'industria',
  'orologeria',
  'farmaceutica',
  'chimica',
  'food',
  'cuochi',
  'camerieri',
  'hotel',
  'pulizie',
  'sicurezza',
  'scuola',
  'designer',
  'architetti',
  'agricoltura',
  'energia',
  'media',
  'tecnici',
] as const;

/** Typed facade over the runtime-neutral table used by Node and the browser. */
export const SECTOR_HUB_SLUG: Record<JobBoardLocale, Record<SectorHubKey, string>> = SHARED_SECTOR_HUB_SLUG as Record<JobBoardLocale, Record<SectorHubKey, string>>;

/** Section root slug per locale (mirror of CITY_HUB_SECTION). */
export const SECTOR_HUB_SECTION: Record<JobBoardLocale, string> = SECTION_LEGACY_TI;

export const SECTOR_HUB_LOCALE_PREFIX: Record<JobBoardLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

// ── Path helpers ─────────────────────────────────────────────────────

export interface SectorHubPath {
  locale: JobBoardLocale;
  sector: SectorHubKey;
  /** Canonical path with trailing slash, e.g. "/jobs/sector/nursing/". */
  path: string;
}

export function buildSectorHubPath(locale: JobBoardLocale, sector: SectorHubKey): string {
  const prefix = SECTOR_HUB_LOCALE_PREFIX[locale];
  const section = SECTOR_HUB_SECTION[locale];
  const slug = SECTOR_HUB_SLUG[locale][sector];
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/** Return all 12 hub paths (3 sectors × 4 locales). */
export function allSectorHubPaths(): SectorHubPath[] {
  const out: SectorHubPath[] = [];
  for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
    for (const sector of SECTOR_HUB_KEYS) {
      out.push({ locale, sector, path: buildSectorHubPath(locale, sector) });
    }
  }
  return out;
}

/** Reverse lookup: parse a path like `/cerca-lavoro-ticino/infermieri/`. */
export function parseSectorHubPath(
  urlPath: string,
): { locale: JobBoardLocale; sector: SectorHubKey } | null {
  if (!urlPath) return null;
  const withSlash = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
  for (const locale of ['it', 'en', 'de', 'fr'] as JobBoardLocale[]) {
    for (const sector of SECTOR_HUB_KEYS) {
      if (withSlash === buildSectorHubPath(locale, sector)) {
        return { locale, sector };
      }
    }
  }
  return null;
}
