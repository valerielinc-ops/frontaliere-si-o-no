import { resolveCantonSection, type CantonLocale } from './shared/cantonSection';
import cantonSlugFile from '../data/canton-url-slugs.json';
import {
 FUEL_SECTION_SLUG,
 FUEL_TODAY_SLUG,
 FUEL_LOCALE_PREFIX,
 type FuelDailyLocale,
 type FuelType,
} from './fuelDailyData';

type SupportedLocale = CantonLocale;

// Legacy TI sections — the listing fallback used for `search` and `company`
// compat targets (canton-independent). Per-canton job-detail paths instead
// canonicalize to the canton section already present in the URL (see the
// `expired-job` branch in resolveSearchConsoleCompatTarget), so they never
// fall back to TI.
const JOB_BOARD_SECTION_BY_LOCALE: Record<SupportedLocale, string> = {
 it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section (it)
 en: 'find-jobs-ticino', // cathedral-allow: TI legacy section (en)
 de: 'jobs-im-tessin', // cathedral-allow: TI legacy section (de)
 fr: 'trouver-emploi-tessin', // cathedral-allow: TI legacy section (fr)
};

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
 * Fuel sub-path 404s → that fuel section's localized "today" landing, derived
 * from FUEL_SECTION_SLUG (single source of truth) so the canonical can never
 * drift onto a renamed/legacy alias (e.g. FR diesel is `prix-gasoil-suisse`,
 * NOT the legacy `prix-diesel` which 301-redirects) and diesel↔diesel /
 * benzina↔benzina is preserved (a benzina 404 must not land on the diesel page).
 */
const FUEL_SECTION_FALLBACKS: Array<{ pattern: RegExp; canonical: string; locale: SupportedLocale }> = (() => {
 const out: Array<{ pattern: RegExp; canonical: string; locale: SupportedLocale }> = [];
 const fuels: FuelType[] = ['diesel', 'benzina'];
 for (const loc of ['it', 'en', 'de', 'fr'] as FuelDailyLocale[]) {
 for (const fuel of fuels) {
 const section = FUEL_SECTION_SLUG[loc][fuel];
 const prefix = FUEL_LOCALE_PREFIX[loc];
 const today = FUEL_TODAY_SLUG[loc];
 const esc = `${prefix}/${section}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 out.push({
 pattern: new RegExp(`^${esc}/`),
 canonical: `${prefix}/${section}/${today}/`.replace(/\/+/g, '/'),
 locale: loc as SupportedLocale,
 });
 }
 }
 return out;
})();

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
 // Fuel-price sections (derived from FUEL_SECTION_SLUG — the single source of
 // truth — so the canonical can never drift onto a renamed/legacy alias):
 // station-detail leaves (/{locale-section}/{city}/{stations}/{slug}) expire as
 // stations rotate; route each to its OWN "today" landing, keeping diesel↔diesel
 // and benzina↔benzina (a benzina 404 must not land on the diesel page). See
 // FUEL_SECTION_FALLBACKS below.
 ...FUEL_SECTION_FALLBACKS,
 // Company-hub section. Per-company×city×week leaves (e.g. .../locarno/{company}/settimana-corrente/)
 // 404 once that company has no current-week openings; route to the hub root (IT + EN only —
 // the DE/FR hub roots are not emitted, so no fallback target exists for them).
 { pattern: /^\/aziende-che-assumono\//, canonical: '/aziende-che-assumono/', locale: 'it' },
 { pattern: /^\/en\/companies-hiring\//, canonical: '/en/companies-hiring/', locale: 'en' },
 // Legacy flat `/lavoro/` job-detail prefix (pre per-canton structure). Route to the
 // localized job-board listing root.
 { pattern: /^\/lavoro\//, canonical: '/cerca-lavoro-ticino/', locale: 'it' },
 { pattern: /^\/en\/lavoro\//, canonical: '/en/find-jobs-ticino/', locale: 'en' },
];

export type SearchConsoleCompatKind = 'search' | 'expired-job' | 'company' | 'legacy' | 'canton-moved';

export interface SearchConsoleCompatResolution {
 canonicalPath: string;
 kind: SearchConsoleCompatKind;
 locale: SupportedLocale;
}

/**
 * Optional slug→canonical-path index for canton-drift recovery. A job slug is
 * globally unique (company + city + hash), but the URL SECTION encodes the
 * canton, and the canton was re-derived every crawl (inferAnyCanton's
 * municipality DB grows / job.location text varies) → the same slug migrated
 * between canton sections, orphaning the previously-emitted (Google-indexed)
 * URL. When this index is supplied, a job-detail 404 whose slug is a KNOWN job
 * under a DIFFERENT canonical path resolves to that real (200) page instead of
 * the bare section listing — recovering the specific page, not just the section.
 * Build it as a Map<localizedSlug, {it,en,de,fr}> from data/all-known-job-slugs.json.
 */
export interface JobSlugCanonicalIndex {
 get(localizedSlug: string): Partial<Record<SupportedLocale, string>> | undefined;
}

const ensureTrailingSlash = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

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

// Both patterns depend only on the pre-computed section segment, so they are
// constant across calls. Compile them once at module init — building them per
// call recompiles a ~1.2k-char, 100-branch alternation on every invocation,
// which is O(paths) regex-compilation and blows the resolver budget when the
// committed 404-path corpus is large (605k+ entries → multi-second loops).
const COMPANY_COMPAT_PATTERN = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/(azienda|company|unternehmen|entreprise)-(.+)$`);
const JOB_BOARD_SECTION_COMPAT_PATTERN = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/([^/]+)\\/?$`);
// Listing pagination leaves (e.g. /de/jobs-im-tessin/alle/page-1022) — historical deep
// page numbers Google still crawls after the listing shrank. Capture group 2 = the canton
// section in the URL → canonicalize to that listing root (NOT a re-derived TI fallback).
const JOB_BOARD_PAGINATION_PATTERN = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/(?:alle|tutti|tutte|all|tous|toutes)\\/page-\\d+\\/?$`);
// Expired job-detail leaves with a trailing numeric job id (e.g. /de/jobs-im-tessin/<slug>/3594).
// Two segments after the section, so the single-segment job pattern above never matches them.
const JOB_BOARD_TRAILING_ID_PATTERN = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/[^/]+\\/\\d+\\/?$`);

export function resolveSearchConsoleCompatTarget(
 inputPath: string,
 slugIndex?: JobSlugCanonicalIndex,
): SearchConsoleCompatResolution | null {
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
 // Canton-aware: a search-style slug under a known job-board section
 // (e.g. /cerca-lavoro-berna/ricerca-offerte-...) must canonicalize to THAT
 // canton's listing, not the locale's TI default — otherwise every
 // ricerca-/suche-/search-/recherche- job slug drifts onto Ticino (the exact
 // wrong-canton regression #2041 fixed in the expired-job branch below).
 // Falls back to the locale listing root only when the path isn't under a
 // recognized section.
 const sectionMatch = path.match(JOB_BOARD_SECTION_COMPAT_PATTERN);
 const canonicalPath = sectionMatch
 ? `${JOB_BOARD_PREFIX_BY_LOCALE[locale]}/${sectionMatch[2]}/`.replace(/\/+/g, '/')
 : listingPathForLocale(locale);
 return {
 canonicalPath,
 kind: 'search',
 locale,
 };
 }

 const companyMatch = path.match(COMPANY_COMPAT_PATTERN);
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

 const jobSectionMatch = path.match(JOB_BOARD_SECTION_COMPAT_PATTERN);
 if (jobSectionMatch) {
 const urlSection = jobSectionMatch[2];
 const slug = jobSectionMatch[3];
 const prefix = JOB_BOARD_PREFIX_BY_LOCALE[locale];
 // Canton-drift recovery (the dominant residual-404 cohort): the slug is
 // globally unique, so if it is a KNOWN job whose current canonical path sits
 // under a DIFFERENT section than the one requested, the request is an ORPHANED
 // canton variant (the canton was re-derived between crawls and the job migrated
 // sections). Point the recovery page at the real (200) canonical job page —
 // recovering the specific page, not just the listing. Prefer the request's own
 // locale, fall back to the IT canonical.
 if (slugIndex) {
 const known = slugIndex.get(slug);
 if (known) {
 const target = known[locale] || known.it;
 if (target) {
 const targetNorm = normalizePath(target);
 if (targetNorm !== path) {
 return {
 canonicalPath: ensureTrailingSlash(target),
 kind: 'canton-moved',
 locale,
 };
 }
 }
 }
 }
 // Fallback (slug unknown / already this path): canonicalize to the canton
 // listing already encoded IN THE URL (capture group 2), not one re-derived
 // from the slug. The matched section IS the canton Google/the user referenced
 // and is always resolvable, so it is the authoritative signal (wrong-canton
 // listing regression #2041).
 return {
 canonicalPath: `${prefix}/${urlSection}/`.replace(/\/+/g, '/'),
 kind: 'expired-job',
 locale,
 };
 }

 const paginationMatch = path.match(JOB_BOARD_PAGINATION_PATTERN);
 if (paginationMatch) {
 const urlSection = paginationMatch[2];
 const prefix = JOB_BOARD_PREFIX_BY_LOCALE[locale];
 return {
 canonicalPath: `${prefix}/${urlSection}/`.replace(/\/+/g, '/'),
 kind: 'legacy',
 locale,
 };
 }

 const trailingIdMatch = path.match(JOB_BOARD_TRAILING_ID_PATTERN);
 if (trailingIdMatch) {
 const urlSection = trailingIdMatch[2];
 const prefix = JOB_BOARD_PREFIX_BY_LOCALE[locale];
 return {
 canonicalPath: `${prefix}/${urlSection}/`.replace(/\/+/g, '/'),
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

