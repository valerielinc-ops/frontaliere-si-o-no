/**
 * Shared data + path helpers for the SEO hub-pages family
 *
 * Hub pages are paginated indexes that close the orphan-page graph
 * (Semrush Issue 207 / 212 / 213). They list all known SEO-static URLs
 * (jobs, sectors, companies, articles) so crawlers reach every URL within
 * 2 clicks from the home/footer.
 *
 * Each hub is built statically by `seoHubsPlugin.ts` and routed via
 * `services/router.ts` as `staticOverlay: true` so the SPA does not
 * replace the static body once it hydrates over `#root`.
 */

export type HubLocale = 'it' | 'en' | 'de' | 'fr';

export const HUB_LOCALES: readonly HubLocale[] = ['it', 'en', 'de', 'fr'] as const;

// ── Per-hub page sizes (tuned for crawl depth + reasonable HTML byte size) ──
export const JOBS_PAGE_SIZE = 100;
export const COMPANIES_PAGE_SIZE = 200;
export const ARTICLES_PAGE_SIZE = 100;

// ── Per-locale slug tables. Mirrors patterns already in services/router.ts ──
// Top-level slugs match the existing job-board / aziende / articoli families.
export interface HubSlugs {
  jobsAll: string;          // e.g. /cerca-lavoro-ticino/tutti/
  sectorsAll: string;       // e.g. /cerca-lavoro-ticino/settori/
  companiesAll: string;     // e.g. /aziende-che-assumono/tutte/
  articlesAll: string;      // e.g. /articoli-frontaliere/tutti/
}

export const HUB_SLUGS: Record<HubLocale, HubSlugs> = {
  it: {
    jobsAll: '/cerca-lavoro-ticino/tutti/',
    sectorsAll: '/cerca-lavoro-ticino/settori/',
    companiesAll: '/aziende-che-assumono/tutte/',
    articlesAll: '/articoli-frontaliere/tutti/',
  },
  en: {
    jobsAll: '/en/find-jobs-ticino/all/',
    sectorsAll: '/en/find-jobs-ticino/sectors/',
    companiesAll: '/en/companies-hiring/all/',
    articlesAll: '/en/cross-border-articles/all/',
  },
  de: {
    jobsAll: '/de/jobs-im-tessin/alle/',
    sectorsAll: '/de/jobs-im-tessin/branchen/',
    companiesAll: '/de/firmen-die-einstellen/alle/',
    articlesAll: '/de/grenzgaenger-artikel/alle/',
  },
  fr: {
    jobsAll: '/fr/trouver-emploi-tessin/tous/',
    sectorsAll: '/fr/trouver-emploi-tessin/secteurs/',
    companiesAll: '/fr/entreprises-qui-recrutent/toutes/',
    articlesAll: '/fr/articles-frontalier/tous/',
  },
};

/** Path-based pagination helper (we cannot rely on ?query for static prerender). */
export function paginatedPath(basePath: string, page: number): string {
  if (page <= 1) return basePath;
  const trimmed = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return `${trimmed}/page-${page}/`;
}

/** All canonical hub paths (page-1 only) used by router for staticOverlay match. */
export function hubBasePaths(): readonly string[] {
  const out: string[] = [];
  for (const loc of HUB_LOCALES) {
    const s = HUB_SLUGS[loc];
    out.push(s.jobsAll, s.sectorsAll, s.companiesAll, s.articlesAll);
  }
  return out;
}

/** Returns true when the path matches any hub base or paginated variant. */
export function isSeoHubPath(pathname: string): boolean {
  const norm = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const loc of HUB_LOCALES) {
    const s = HUB_SLUGS[loc];
    for (const base of [s.jobsAll, s.sectorsAll, s.companiesAll, s.articlesAll]) {
      if (norm === base) return true;
      const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
      if (new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/page-\\d+/?$`).test(norm)) {
        return true;
      }
    }
  }
  return false;
}

/** Locale extracted from a hub path (defaults to 'it'). */
export function localeFromHubPath(pathname: string): HubLocale {
  if (pathname.startsWith('/en/')) return 'en';
  if (pathname.startsWith('/de/')) return 'de';
  if (pathname.startsWith('/fr/')) return 'fr';
  return 'it';
}

// ── Curated sector list (50 sectors covering Ticino frontaliere demand) ──
// Anchor text is the IT label; per-locale display strings live in the i18n
// keys `seo.hub.sector.{key}.label`. The existing per-sector landings live
// under SECTOR_HUB_SLUG (jobSectorLanding.ts) for the 3 formal hubs;
// the rest currently route to /cerca-lavoro-ticino/?q=<label> as fallback.
export interface SectorEntry {
  readonly key: string;
  readonly it: string;
  readonly en: string;
  readonly de: string;
  readonly fr: string;
}

export const HUB_SECTORS: readonly SectorEntry[] = [
  { key: 'infermieri', it: 'Infermieri', en: 'Nurses', de: 'Krankenpfleger', fr: 'Infirmiers' },
  { key: 'case-anziani', it: 'Case anziani', en: 'Elderly care', de: 'Altersheime', fr: "Maisons de retraite" },
  { key: 'educatori', it: 'Educatori', en: 'Educators', de: 'Erzieher', fr: 'Éducateurs' },
  { key: 'medici', it: 'Medici', en: 'Doctors', de: 'Ärzte', fr: 'Médecins' },
  { key: 'oss', it: 'Operatori socio-sanitari', en: 'Healthcare assistants', de: 'Gesundheitsassistenten', fr: 'Aides-soignants' },
  { key: 'fisioterapisti', it: 'Fisioterapisti', en: 'Physiotherapists', de: 'Physiotherapeuten', fr: 'Physiothérapeutes' },
  { key: 'farmacisti', it: 'Farmacisti', en: 'Pharmacists', de: 'Apotheker', fr: 'Pharmaciens' },
  { key: 'ingegneri', it: 'Ingegneri', en: 'Engineers', de: 'Ingenieure', fr: 'Ingénieurs' },
  { key: 'sviluppatori', it: 'Sviluppatori software', en: 'Software developers', de: 'Softwareentwickler', fr: 'Développeurs' },
  { key: 'data-scientist', it: 'Data scientist', en: 'Data scientists', de: 'Data Scientists', fr: 'Data scientists' },
  { key: 'cybersecurity', it: 'Cybersecurity', en: 'Cybersecurity', de: 'Cybersicherheit', fr: 'Cybersécurité' },
  { key: 'project-manager', it: 'Project manager', en: 'Project managers', de: 'Projektmanager', fr: 'Chefs de projet' },
  { key: 'contabili', it: 'Contabili', en: 'Accountants', de: 'Buchhalter', fr: 'Comptables' },
  { key: 'banca', it: 'Banca e finanza', en: 'Banking & finance', de: 'Bank & Finanzen', fr: 'Banque & finance' },
  { key: 'assicurazioni', it: 'Assicurazioni', en: 'Insurance', de: 'Versicherungen', fr: 'Assurances' },
  { key: 'consulenza', it: 'Consulenza', en: 'Consulting', de: 'Beratung', fr: 'Conseil' },
  { key: 'avvocati', it: 'Avvocati e legale', en: 'Legal', de: 'Recht', fr: 'Juridique' },
  { key: 'risorse-umane', it: 'Risorse umane', en: 'Human resources', de: 'Personalwesen', fr: 'Ressources humaines' },
  { key: 'marketing', it: 'Marketing', en: 'Marketing', de: 'Marketing', fr: 'Marketing' },
  { key: 'vendite', it: 'Vendite', en: 'Sales', de: 'Verkauf', fr: 'Ventes' },
  { key: 'commercio', it: 'Commercio al dettaglio', en: 'Retail', de: 'Einzelhandel', fr: 'Commerce de détail' },
  { key: 'logistica', it: 'Logistica', en: 'Logistics', de: 'Logistik', fr: 'Logistique' },
  { key: 'trasporti', it: 'Trasporti', en: 'Transport', de: 'Transport', fr: 'Transport' },
  { key: 'autisti', it: 'Autisti', en: 'Drivers', de: 'Fahrer', fr: 'Chauffeurs' },
  { key: 'magazzino', it: 'Magazzinieri', en: 'Warehouse staff', de: 'Lagerist', fr: 'Magasiniers' },
  { key: 'meccanici', it: 'Meccanici', en: 'Mechanics', de: 'Mechaniker', fr: 'Mécaniciens' },
  { key: 'elettricisti', it: 'Elettricisti', en: 'Electricians', de: 'Elektriker', fr: 'Électriciens' },
  { key: 'idraulici', it: 'Idraulici', en: 'Plumbers', de: 'Klempner', fr: 'Plombiers' },
  { key: 'edilizia', it: 'Edilizia', en: 'Construction', de: 'Bauwesen', fr: 'Construction' },
  { key: 'muratori', it: 'Muratori', en: 'Bricklayers', de: 'Maurer', fr: 'Maçons' },
  { key: 'falegnami', it: 'Falegnami', en: 'Carpenters', de: 'Schreiner', fr: 'Menuisiers' },
  { key: 'industria', it: 'Industria e produzione', en: 'Manufacturing', de: 'Industrie', fr: 'Industrie' },
  { key: 'orologeria', it: 'Orologeria', en: 'Watchmaking', de: 'Uhrenindustrie', fr: 'Horlogerie' },
  { key: 'farmaceutica', it: 'Farmaceutica', en: 'Pharmaceutical', de: 'Pharma', fr: 'Pharmaceutique' },
  { key: 'chimica', it: 'Chimica', en: 'Chemicals', de: 'Chemie', fr: 'Chimie' },
  { key: 'food', it: 'Food & beverage', en: 'Food & beverage', de: 'Lebensmittel', fr: 'Agroalimentaire' },
  { key: 'ristorazione', it: 'Ristorazione', en: 'Restaurants', de: 'Gastronomie', fr: 'Restauration' },
  { key: 'cuochi', it: 'Cuochi', en: 'Chefs', de: 'Köche', fr: 'Cuisiniers' },
  { key: 'camerieri', it: 'Camerieri', en: 'Waiters', de: 'Kellner', fr: 'Serveurs' },
  { key: 'hotel', it: 'Hotel e turismo', en: 'Hotels & tourism', de: 'Hotellerie', fr: 'Hôtellerie' },
  { key: 'pulizie', it: 'Pulizie', en: 'Cleaning', de: 'Reinigung', fr: 'Nettoyage' },
  { key: 'sicurezza', it: 'Sicurezza', en: 'Security', de: 'Sicherheit', fr: 'Sécurité' },
  { key: 'pubblica-amministrazione', it: 'Pubblica amministrazione', en: 'Public sector', de: 'Öffentlicher Dienst', fr: 'Administration publique' },
  { key: 'scuola', it: 'Scuola e formazione', en: 'Education', de: 'Bildung', fr: 'Enseignement' },
  { key: 'designer', it: 'Designer e creativi', en: 'Designers', de: 'Designer', fr: 'Designers' },
  { key: 'architetti', it: 'Architetti', en: 'Architects', de: 'Architekten', fr: 'Architectes' },
  { key: 'agricoltura', it: 'Agricoltura', en: 'Agriculture', de: 'Landwirtschaft', fr: 'Agriculture' },
  { key: 'energia', it: 'Energia e utility', en: 'Energy & utilities', de: 'Energie', fr: 'Énergie' },
  { key: 'media', it: 'Media e comunicazione', en: 'Media', de: 'Medien', fr: 'Médias' },
  { key: 'tecnici', it: 'Tecnici', en: 'Technicians', de: 'Techniker', fr: 'Techniciens' },
] as const;

/** Top 8 sector keys featured in the footer "Esplora settori" widget. */
export const FOOTER_TOP_SECTORS: readonly string[] = [
  'infermieri',
  'case-anziani',
  'ingegneri',
  'sviluppatori',
  'banca',
  'edilizia',
  'ristorazione',
  'pulizie',
] as const;

/** Top 8 cities featured in the footer "Esplora città" widget. */
export interface CityEntry {
  readonly key: 'lugano' | 'mendrisio' | 'bellinzona' | 'locarno' | 'chiasso';
  readonly display: string;
}
export const FOOTER_TOP_CITIES: readonly CityEntry[] = [
  { key: 'lugano', display: 'Lugano' },
  { key: 'mendrisio', display: 'Mendrisio' },
  { key: 'bellinzona', display: 'Bellinzona' },
  { key: 'locarno', display: 'Locarno' },
  { key: 'chiasso', display: 'Chiasso' },
] as const;
