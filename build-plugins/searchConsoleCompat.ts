import { resolveCantonSection, type CantonLocale } from './shared/cantonSection';
import { getCantonForSlug } from './shared/slugCantonIndex';
import cantonSlugFile from '../data/canton-url-slugs.json';

type SupportedLocale = CantonLocale;

// Legacy TI sections — preserved here for byte-identical default behavior
// (listing fallback when no slug is present). Per-slug job redirects use
// `inferTargetSection()` below which inspects the slug-registry/jobs cantons.
const JOB_BOARD_SECTION_BY_LOCALE: Record<SupportedLocale, string> = {
 it: 'cerca-lavoro-ticino',
 en: 'find-jobs-ticino',
 de: 'jobs-im-tessin',
 fr: 'trouver-emploi-tessin',
};

/**
 * Pick the canton-aware job-board section a slug should redirect to.
 * Falls back to TI for unknown slugs (byte-identical legacy behavior).
 */
function inferTargetSection(slug: string, locale: SupportedLocale): string {
 const canton = getCantonForSlug(slug);
 return resolveCantonSection(locale, canton);
}

const JOB_BOARD_PREFIX_BY_LOCALE: Record<SupportedLocale, string> = {
 it: '',
 en: '/en',
 de: '/de',
 fr: '/fr',
};

const COMPANY_ROUTE_PREFIX_BY_LOCALE: Record<SupportedLocale, string> = {
 it: 'azienda',
 en: 'company',
 de: 'unternehmen',
 fr: 'entreprise',
};

const COMPAT_REDIRECTS: Record<string, string> = {
 '/compara-servizi/undefined': '/compara-servizi/',
 '/fisco-frontaliere/dichiarazione-redditi': '/tasse-e-pensione/',
 '/en/cross-border-articles/communal-elections-ticino-2026/': '/en/cross-border-articles/municipal-elections-ticino/',
 '/fr/articles-frontalier/elections-communales-tessin-2026/': '/fr/articles-frontalier/elections-municipales-tessin/',
 '/vivere-in-ticino/vivere-in-svizzera': '/vivere-in-ticino/',
 // Utility pages — these are real pages with their own SEO entries + sitemap URLs.
 // Map to themselves so resolveSearchConsoleCompatTarget() returns non-null
 // (legacyRedirectsPlugin skips from===to, so no overwrite of staticPagesPlugin pages).
 '/contattaci': '/contattaci/',
 '/en/contact-us': '/en/contact-us/',
 '/de/kontakt': '/de/kontakt/',
 '/fr/contactez-nous': '/fr/contactez-nous/',
 '/servizi-partner': '/servizi-partner/',
 '/en/partner-services': '/en/partner-services/',
 '/de/partner-dienste': '/de/partner-dienste/',
 '/fr/services-partenaires': '/fr/services-partenaires/',
 '/consulenza': '/consulenza/',
 '/en/consulting': '/en/consulting/',
 '/de/beratung': '/de/beratung/',
 '/fr/consultation': '/fr/consultation/',
 '/stato-api': '/stato-api/',
 '/en/api-status': '/en/api-status/',
 '/de/api-status': '/de/api-status/',
 '/fr/etat-api': '/fr/etat-api/',
 '/privacy': '/privacy/',
 '/fr/confidentialite': '/fr/confidentialite/',
};

/**
 * Known site sections and their canonical landing pages.
 * Used as a fallback when a 404 path matches a section prefix but isn't
 * handled by the exact-match or job-board pattern resolvers.
 */
const SECTION_FALLBACKS: Array<{ pattern: RegExp; canonical: string; locale: SupportedLocale }> = [
 // Italian sections (no locale prefix)
 { pattern: /^\/vivere-in-ticino\//, canonical: '/vivere-in-ticino/', locale: 'it' },
 { pattern: /^\/compara-servizi\//, canonical: '/compara-servizi/', locale: 'it' },
 { pattern: /^\/articoli-frontaliere\//, canonical: '/articoli-frontaliere/', locale: 'it' },
 { pattern: /^\/guida-frontaliere\//, canonical: '/guida-frontaliere/', locale: 'it' },
 { pattern: /^\/calcola-stipendio\//, canonical: '/calcola-stipendio/', locale: 'it' },
 { pattern: /^\/tasse-e-pensione\//, canonical: '/tasse-e-pensione/', locale: 'it' },
 { pattern: /^\/statistiche\//, canonical: '/statistiche/', locale: 'it' },
 { pattern: /^\/fisco-frontaliere\//, canonical: '/tasse-e-pensione/', locale: 'it' },
 // Legacy job-board prefix (without `-ticino` / `-<canton>` suffix) — a handful of
 // historical 404s use `/cerca-lavoro/<slug>` instead of the canonical section URL.
 // Route them to the IT job-board listing as a safe fallback (canton-aware slug
 // resolution happens in the section/company patterns below).
 { pattern: /^\/cerca-lavoro(?!-)\//, canonical: '/cerca-lavoro-ticino/', locale: 'it' },
 // Localized sections
 { pattern: /^\/en\/cross-border-articles\//, canonical: '/en/cross-border-articles/', locale: 'en' },
 { pattern: /^\/de\/grenzgaenger-artikel\//, canonical: '/de/grenzgaenger-artikel/', locale: 'de' },
 { pattern: /^\/fr\/articles-frontalier\//, canonical: '/fr/articles-frontalier/', locale: 'fr' },
 { pattern: /^\/en\/statistics\//, canonical: '/en/statistics/', locale: 'en' },
 { pattern: /^\/de\/statistiken\//, canonical: '/de/statistiken/', locale: 'de' },
 { pattern: /^\/fr\/statistiques\//, canonical: '/fr/statistiques/', locale: 'fr' },
 { pattern: /^\/en\/living-in-ticino\//, canonical: '/en/living-in-ticino/', locale: 'en' },
 { pattern: /^\/de\/leben-im-tessin\//, canonical: '/de/leben-im-tessin/', locale: 'de' },
 { pattern: /^\/fr\/vivre-au-tessin\//, canonical: '/fr/vivre-au-tessin/', locale: 'fr' },
 { pattern: /^\/en\/calculate-salary\//, canonical: '/en/calculate-salary/', locale: 'en' },
 { pattern: /^\/de\/gehalt-berechnen\//, canonical: '/de/gehalt-berechnen/', locale: 'de' },
 { pattern: /^\/fr\/calculer-salaire\//, canonical: '/fr/calculer-salaire/', locale: 'fr' },
 { pattern: /^\/en\/taxes-and-pension\//, canonical: '/en/taxes-and-pension/', locale: 'en' },
 { pattern: /^\/de\/steuern-und-rente\//, canonical: '/de/steuern-und-rente/', locale: 'de' },
 { pattern: /^\/fr\/impots-et-retraite\//, canonical: '/fr/impots-et-retraite/', locale: 'fr' },
 { pattern: /^\/en\/cross-border-guide\//, canonical: '/en/cross-border-guide/', locale: 'en' },
 { pattern: /^\/de\/grenzgaenger-leitfaden\//, canonical: '/de/grenzgaenger-leitfaden/', locale: 'de' },
 { pattern: /^\/fr\/guide-frontalier\//, canonical: '/fr/guide-frontalier/', locale: 'fr' },
 { pattern: /^\/en\/service-comparison\//, canonical: '/en/service-comparison/', locale: 'en' },
 { pattern: /^\/de\/dienstleistungsvergleich\//, canonical: '/de/dienstleistungsvergleich/', locale: 'de' },
 { pattern: /^\/fr\/comparaison-services\//, canonical: '/fr/comparaison-services/', locale: 'fr' },
];

export type SearchConsoleCompatKind = 'search' | 'expired-job' | 'company' | 'legacy';

export interface SearchConsoleCompatResolution {
 canonicalPath: string;
 kind: SearchConsoleCompatKind;
 locale: SupportedLocale;
}

function normalizePath(input: string): string {
 const clean = `/${String(input || '').trim().replace(/^\/+/, '')}`.replace(/\/+/g, '/');
 if (clean === '/') return clean;
 return clean.replace(/\/$/, '');
}

function inferLocale(path: string): SupportedLocale {
 if (path.startsWith('/en/')) return 'en';
 if (path.startsWith('/de/')) return 'de';
 if (path.startsWith('/fr/')) return 'fr';
 return 'it';
}

function listingPathForLocale(locale: SupportedLocale): string {
 const prefix = JOB_BOARD_PREFIX_BY_LOCALE[locale];
 const section = JOB_BOARD_SECTION_BY_LOCALE[locale];
 return `${prefix}/${section}/`.replace(/\/+/g, '/');
}

/**
 * Job-board listing path for the canton inferred from a slug.
 * Falls back to TI (byte-identical legacy behavior) when the slug isn't
 * registered or maps to TI.
 */
function listingPathForSlug(slug: string, locale: SupportedLocale): string {
 const prefix = JOB_BOARD_PREFIX_BY_LOCALE[locale];
 const section = inferTargetSection(slug, locale);
 return `${prefix}/${section}/`.replace(/\/+/g, '/');
}

// Build regex segment that matches ANY known job-board section (TI legacy
// + every per-canton section across all 4 locales). Pre-computed once.
const JOB_BOARD_SECTION_PATTERN_SEGMENT: string = (() => {
 const sections = new Set<string>();
 const locales: SupportedLocale[] = ['it', 'en', 'de', 'fr'];
 // Legacy TI sections
 for (const loc of locales) sections.add(JOB_BOARD_SECTION_BY_LOCALE[loc]);
 // All canton sections (incl. aggregator) — derive from resolveCantonSection
 // by feeding every canton code + '_AGGREGATE_' for each locale.
 // We can't import ALL_CANTON_CODES directly here without circularity worries,
 // so re-resolve via the helper at module init.
 const codes = Object.keys((cantonSlugFile as { cantons: Record<string, unknown> }).cantons || {});
 for (const code of codes) {
  for (const loc of locales) sections.add(resolveCantonSection(loc, code));
 }
 for (const loc of locales) sections.add(resolveCantonSection(loc, '_AGGREGATE_'));
 // Sort by length desc so longer matches win in alternation.
 const sorted = Array.from(sections).sort((a, b) => b.length - a.length);
 return sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
})();

export function resolveSearchConsoleCompatTarget(inputPath: string): SearchConsoleCompatResolution | null {
 const path = normalizePath(inputPath);
 const exact = COMPAT_REDIRECTS[path] || COMPAT_REDIRECTS[`${path}/`];
 if (exact) {
 return {
 canonicalPath: exact,
 kind: 'legacy',
 locale: inferLocale(path),
 };
 }

 const locale = inferLocale(path);

 if (/\/(ricerca|search|suche|recherche)-/.test(path)) {
 return {
 canonicalPath: listingPathForLocale(locale),
 kind: 'search',
 locale,
 };
 }

 const companyPattern = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/(azienda|company|unternehmen|entreprise)-(.+)$`);
 const companyMatch = path.match(companyPattern);
 if (companyMatch) {
 const slug = companyMatch[4];
 // Company hubs stay on TI listing (legacy preservation — company hub
 // is canton-independent, and the existing landing remains the listing
 // root with the locale's COMPANY_ROUTE_PREFIX appended).
 return {
 canonicalPath: `${listingPathForLocale(locale)}${COMPANY_ROUTE_PREFIX_BY_LOCALE[locale]}-${slug}/`.replace(/\/+/g, '/'),
 kind: 'company',
 locale,
 };
 }

 const jobBoardSectionPattern = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/([^/]+)\\/?$`);
 const jobSectionMatch = path.match(jobBoardSectionPattern);
 if (jobSectionMatch) {
 const slug = jobSectionMatch[3] || '';
 return {
 canonicalPath: listingPathForSlug(slug, locale),
 kind: 'expired-job',
 locale,
 };
 }

 // Fallback: match known site sections and redirect to their landing page
 for (const fb of SECTION_FALLBACKS) {
 if (fb.pattern.test(path)) {
 return {
 canonicalPath: fb.canonical,
 kind: 'legacy',
 locale: fb.locale,
 };
 }
 }

 return null;
}

