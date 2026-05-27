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

import { resolveCantonSection, type CantonLocale } from './shared/cantonSection';

export type HubLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Hub kinds emitted per canton: `tutti` (all jobs), `settori` (sectors),
 * `aziende` (companies). Articles are NOT canton-scoped — they remain TI-only.
 */
export type HubKind = 'tutti' | 'settori' | 'aziende';

/**
 * Per-locale hub-name slug (the trailing path component after the canton section).
 * Mirrors the locale slugs already used in the legacy TI `HUB_SLUGS` table.
 */
const HUB_SLUG_BY_LOCALE: Record<CantonLocale, Record<HubKind, string>> = {
  it: { tutti: 'tutti',  settori: 'settori',  aziende: 'aziende' },
  en: { tutti: 'all',    settori: 'sectors',  aziende: 'companies' },
  de: { tutti: 'alle',   settori: 'branchen', aziende: 'unternehmen' },
  fr: { tutti: 'tous',   settori: 'secteurs', aziende: 'entreprises' },
};

/**
 * Build the hub-page URL path for a canton + locale + hub kind.
 * Returns the path component INCLUDING the leading slash and the trailing
 * slash, matching the existing `HUB_SLUGS` shape:
 *
 *   hubSlugFor('TI', 'it', 'tutti')  → '/cerca-lavoro-ticino/tutti/'
 *   hubSlugFor('ZH', 'it', 'aziende') → '/cerca-lavoro-zurigo/aziende/'
 *   hubSlugFor('_AGGREGATE_', 'fr', 'settori') → '/fr/trouver-emploi-suisse/secteurs/'
 *
 * `resolveCantonSection` already prepends the `/{locale}/` prefix for non-IT
 * locales (e.g. `find-jobs-zurich` for EN — the call below adds `/en/`).
 */
export function hubSlugFor(canton: string, locale: CantonLocale, hub: HubKind): string {
  const section = resolveCantonSection(locale, canton);
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${section}/${HUB_SLUG_BY_LOCALE[locale][hub]}/`;
}

export const HUB_LOCALES: readonly HubLocale[] = ['it', 'en', 'de', 'fr'] as const;

// ── Per-hub page sizes (tuned for crawl depth + reasonable HTML byte size) ──
export const JOBS_PAGE_SIZE = 100;
// 100 keeps the page-1 HTML under the 200 KB hard cap enforced by
// `audit:page-weight`. The previous value (200) emitted ~270 KB pages
// for IT/EN/DE/FR `companies/all/page-1`, blocking deploys on the
// post-deploy validation gate. Doubling the page count (more page-N
// URLs) is harmless — the BFS-depth audit allows up to depth 4 and
// the hub navigator already links every page-N directly.
export const COMPANIES_PAGE_SIZE = 100;
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

/**
 * Set of trailing-slug names that the SEO hub family (jobs, sectors, companies,
 * articles archives) reserves for its paginated index pages. These slugs MUST
 * NOT be claimed by jobsSeoPagesPlugin.ts as soft-landing slugs — otherwise an
 * expired-job soft-landing would overwrite the seoHubs HTML at e.g.
 * `/cerca-lavoro-ticino/tutti/index.html`, severing the pagination chain from
 * `/page-2/` onwards (hundreds of orphaned sitemap entries).
 *
 * The set is intentionally slug-only (not full paths) because the
 * jobsSeoPagesPlugin.ts soft-landing code matches tracking keys by slug.
 * Concrete slugs covered (per HUB_SLUGS):
 *  - jobs:      tutti / all / alle / tous
 *  - sectors:   settori / sectors / branchen / secteurs
 *  - companies: tutte / all / alle / toutes
 *  - articles:  tutti / all / alle / tous (re-uses the jobs slug name)
 */
export const SEO_HUB_RESERVED_SLUGS: readonly string[] = (() => {
  const s = new Set<string>();
  for (const loc of HUB_LOCALES) {
    const h = HUB_SLUGS[loc];
    for (const path of [h.jobsAll, h.sectorsAll, h.companiesAll, h.articlesAll]) {
      const trimmed = path.replace(/\/+$/, '');
      const last = trimmed.split('/').pop();
      if (last) s.add(last);
    }
  }
  return Array.from(s);
})();

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
