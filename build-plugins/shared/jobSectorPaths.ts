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

/** Per-locale URL slug for each sector. Query-matching, short. */
export const SECTOR_HUB_SLUG: Record<JobBoardLocale, Record<SectorHubKey, string>> = {
  it: {
    infermieri: 'infermieri',
    'case-anziani': 'case-anziani',
    educatori: 'educatori',
    ingegneri: 'ingegneri',
    autisti: 'autisti',
    sviluppatori: 'sviluppatori',
    ristorazione: 'ristorazione',
    oss: 'operatori-socio-sanitari',
    logistica: 'logistica',
    apprendistato: 'apprendistato',
    medici: 'medici',
    fisioterapisti: 'fisioterapisti',
    farmacisti: 'farmacisti',
    'data-scientist': 'data-scientist',
    cybersecurity: 'cybersecurity',
    'project-manager': 'project-manager',
    contabili: 'contabili',
    banca: 'banca-finanza',
    assicurazioni: 'assicurazioni',
    consulenza: 'consulenza',
    avvocati: 'avvocati-legale',
    'risorse-umane': 'risorse-umane',
    marketing: 'marketing',
    vendite: 'vendite',
    commercio: 'commercio-dettaglio',
    trasporti: 'trasporti',
    magazzino: 'magazzino',
    meccanici: 'meccanici',
    elettricisti: 'elettricisti',
    idraulici: 'idraulici',
    edilizia: 'edilizia',
    falegnami: 'falegnami',
    industria: 'industria-produzione',
    orologeria: 'orologeria',
    farmaceutica: 'farmaceutica',
    chimica: 'chimica',
    food: 'alimentare',
    cuochi: 'cuochi',
    camerieri: 'camerieri',
    hotel: 'hotel-alberghi',
    pulizie: 'pulizie',
    sicurezza: 'sicurezza',
    scuola: 'scuola-formazione',
    designer: 'designer',
    architetti: 'architetti',
    agricoltura: 'agricoltura',
    energia: 'energia',
    media: 'media-giornalismo',
    tecnici: 'tecnici',
  },
  en: {
    infermieri: 'nurses',
    'case-anziani': 'elderly-care',
    educatori: 'educators',
    ingegneri: 'engineers',
    autisti: 'drivers',
    sviluppatori: 'developers',
    ristorazione: 'restaurants',
    oss: 'healthcare-assistants',
    logistica: 'logistics',
    apprendistato: 'apprenticeships',
    medici: 'doctors',
    fisioterapisti: 'physiotherapists',
    farmacisti: 'pharmacists',
    'data-scientist': 'data-scientists',
    cybersecurity: 'cybersecurity',
    'project-manager': 'project-managers',
    contabili: 'accountants',
    banca: 'banking-finance',
    assicurazioni: 'insurance',
    consulenza: 'consulting',
    avvocati: 'legal',
    'risorse-umane': 'human-resources',
    marketing: 'marketing',
    vendite: 'sales',
    commercio: 'retail',
    trasporti: 'transport',
    magazzino: 'warehouse',
    meccanici: 'mechanics',
    elettricisti: 'electricians',
    idraulici: 'plumbers',
    edilizia: 'construction',
    falegnami: 'carpenters',
    industria: 'manufacturing',
    orologeria: 'watchmaking',
    farmaceutica: 'pharmaceutical',
    chimica: 'chemistry',
    food: 'food-industry',
    cuochi: 'cooks',
    camerieri: 'waiters',
    hotel: 'hotels',
    pulizie: 'cleaning',
    sicurezza: 'security',
    scuola: 'education',
    designer: 'designers',
    architetti: 'architects',
    agricoltura: 'agriculture',
    energia: 'energy',
    media: 'media',
    tecnici: 'technicians',
  },
  de: {
    infermieri: 'pflegepersonal',
    'case-anziani': 'altenpflege',
    educatori: 'erzieher',
    ingegneri: 'ingenieure',
    autisti: 'fahrer',
    sviluppatori: 'entwickler',
    ristorazione: 'gastronomie',
    oss: 'pflegeassistenten',
    logistica: 'logistik',
    apprendistato: 'lehrstellen',
    medici: 'aerzte',
    fisioterapisti: 'physiotherapeuten',
    farmacisti: 'apotheker',
    'data-scientist': 'data-scientists',
    cybersecurity: 'cybersicherheit',
    'project-manager': 'projektmanager',
    contabili: 'buchhalter',
    banca: 'bank-finanzen',
    assicurazioni: 'versicherungen',
    consulenza: 'beratung',
    avvocati: 'recht',
    'risorse-umane': 'personalwesen',
    marketing: 'marketing',
    vendite: 'verkauf',
    commercio: 'einzelhandel',
    trasporti: 'transport',
    magazzino: 'lager',
    meccanici: 'mechaniker',
    elettricisti: 'elektriker',
    idraulici: 'sanitaer',
    edilizia: 'bau',
    falegnami: 'schreiner',
    industria: 'produktion',
    orologeria: 'uhrenindustrie',
    farmaceutica: 'pharma',
    chimica: 'chemie',
    food: 'lebensmittel',
    cuochi: 'koeche',
    camerieri: 'servicepersonal',
    hotel: 'hotellerie',
    pulizie: 'reinigung',
    sicurezza: 'sicherheit',
    scuola: 'schule',
    designer: 'designer',
    architetti: 'architekten',
    agricoltura: 'landwirtschaft',
    energia: 'energie',
    media: 'medien',
    tecnici: 'techniker',
  },
  fr: {
    infermieri: 'infirmiers',
    'case-anziani': 'maisons-retraite',
    educatori: 'educateurs',
    ingegneri: 'ingenieurs',
    autisti: 'chauffeurs',
    sviluppatori: 'developpeurs',
    ristorazione: 'restauration',
    oss: 'aides-soignants',
    logistica: 'logistique',
    apprendistato: 'apprentissages',
    medici: 'medecins',
    fisioterapisti: 'physiotherapeutes',
    farmacisti: 'pharmaciens',
    'data-scientist': 'data-scientists',
    cybersecurity: 'cybersecurite',
    'project-manager': 'chefs-de-projet',
    contabili: 'comptables',
    banca: 'banque-finance',
    assicurazioni: 'assurances',
    consulenza: 'conseil',
    avvocati: 'juridique',
    'risorse-umane': 'ressources-humaines',
    marketing: 'marketing',
    vendite: 'ventes',
    commercio: 'commerce-detail',
    trasporti: 'transport',
    magazzino: 'entrepot',
    meccanici: 'mecaniciens',
    elettricisti: 'electriciens',
    idraulici: 'plombiers',
    edilizia: 'batiment',
    falegnami: 'menuisiers',
    industria: 'industrie',
    orologeria: 'horlogerie',
    farmaceutica: 'pharmaceutique',
    chimica: 'chimie',
    food: 'agroalimentaire',
    cuochi: 'cuisiniers',
    camerieri: 'serveurs',
    hotel: 'hotellerie',
    pulizie: 'nettoyage',
    sicurezza: 'securite',
    scuola: 'enseignement',
    designer: 'designers',
    architetti: 'architectes',
    agricoltura: 'agriculture',
    energia: 'energie',
    media: 'medias',
    tecnici: 'techniciens',
  },
};

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
