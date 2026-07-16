import { resolveCantonSection, AGGREGATE_KEY, type CantonLocale } from './shared/cantonSection';
import { SECTOR_HUB_KEYS, SECTOR_HUB_SLUG } from './jobSectorLanding';
import { BASE_URL } from './constants';
import cantonSlugFile from '../data/canton-url-slugs.json';
import searchClusterMapFile from '../data/search-cluster-301-map.json';
import {
 FUEL_SECTION_SLUG,
 FUEL_TODAY_SLUG,
 FUEL_LOCALE_PREFIX,
 type FuelDailyLocale,
 type FuelType,
} from './fuelDailyData';
import { isProfessionCantonPath } from './professionCantonData';
import { WEEKLY_EMPLOYERS_SECTION } from './weeklyEmployersData';
import { SNAPSHOT_SEGMENT } from './jobMarketSnapshotChCantonPages';
import { HUB_SLUG_BY_LOCALE } from './seoHubsData';
import {
 EDITORIAL_CANTONS,
 getJobTodayLandingSlug,
 getJobNursesHubSlug,
 getJobPartTimeLandingSlug,
 careClusterSlug,
 type JobCareClusterKey,
} from './jobEditorialLanding';
import { EVENTS_INDEX_PATH } from '../scripts/lib/events-utils.mjs';

type SupportedLocale = CantonLocale;

// Editorial-canton landing kinds confirmed (via emitEditorialBelowFloorBridge
// call sites in jobsSeoPagesPlugin.ts) to ALWAYS have a live page at their
// canonical slug for EVERY canton — either the full listing or a noindex
// below-floor bridge, never a silent skip. Other descriptor kinds
// (official-gazette/location/location-type/location-sector/sector-region/
// recency) do NOT have that universal per-canton guarantee, so they are
// deliberately excluded — self-mapping them would risk telling the compat
// layer a genuinely-404 path is live.
//
// Built ONCE at module load from the same slug builders jobEditorialLanding.ts
// uses internally, rather than calling resolveEditorialJobLandingDescriptor()
// per 404 URL: that resolver rebuilds per-canton Sets on every call, and
// tests/search-console-compat.test.ts resolves 150k+ committed URLs in one
// test — an unconditional per-call resolve there turned a ~13s test into a
// 60s+ timeout. A precomputed Set keeps the per-URL check O(1).
const CARE_CLUSTER_KEYS: readonly JobCareClusterKey[] = ['clinics', 'careHomes', 'oss', 'educators'];
const SELF_MAPPABLE_EDITORIAL_SLUGS: ReadonlySet<string> = (() => {
 const s = new Set<string>();
 const locales: SupportedLocale[] = ['it', 'en', 'de', 'fr'];
 for (const canton of EDITORIAL_CANTONS) {
 for (const locale of locales) {
 s.add(getJobTodayLandingSlug(locale, canton));
 s.add(getJobNursesHubSlug(locale, canton));
 s.add(getJobPartTimeLandingSlug(locale, canton));
 for (const key of CARE_CLUSTER_KEYS) {
 s.add(careClusterSlug(key, canton, locale));
 }
 }
 }
 return s;
})();

// Per-canton sector-hub slugs (jobsSeoPagesPlugin.ts Phase 3.2 for the 24
// non-TI canton sections, jobSectorPagesPlugin.ts for the TI legacy section)
// are emitted for EVERY (canton section × sector × locale) combo
// unconditionally — either the full hub page or a below-floor noindex bridge
// (canton-level MIN_JOBS_FOR_CANTON_PAGE floor AND the finer per-sector
// MIN_JOBS_PER_CANTON_SECTOR floor both bridge, issue #3747) — so a URL
// matching a locale's OWN sector slug under a non-aggregate canton section
// always has a live target at the SAME path today. The national aggregate
// sections (resolveCantonSection(locale, AGGREGATE_KEY), e.g.
// /cerca-lavoro-svizzera/) get NO sector pages from either plugin and are
// excluded via AGGREGATE_SECTIONS below. Per-locale Sets so a cross-locale
// slug (e.g. EN `nurses` under an IT section) is NOT claimed live. Built once
// at module load — same O(1)-per-URL rationale as SELF_MAPPABLE_EDITORIAL_SLUGS
// (tests/search-console-compat.test.ts resolves 150k+ paths in one test).
//
// Per-canton company (`azienda-{slug}`) and company×city
// (`azienda-{slug}-{city}`) hubs from the same #3747 fix are deliberately NOT
// self-mapped: their slugs are data-driven (not enumerable at module load),
// and the COMPANY_COMPAT_PATTERN branch below already resolves every URL of
// that shape (kind 'company'), so they can never go unresolvable.
const SELF_MAPPABLE_SECTOR_HUB_SLUGS: Record<SupportedLocale, ReadonlySet<string>> = (() => {
 const out = {} as Record<SupportedLocale, ReadonlySet<string>>;
 const locales: SupportedLocale[] = ['it', 'en', 'de', 'fr'];
 for (const locale of locales) {
 const s = new Set<string>();
 for (const key of SECTOR_HUB_KEYS) s.add(SECTOR_HUB_SLUG[locale][key]);
 out[locale] = s;
 }
 return out;
})();

const AGGREGATE_SECTIONS: ReadonlySet<string> = new Set(
 (['it', 'en', 'de', 'fr'] as SupportedLocale[]).map((l) => resolveCantonSection(l, AGGREGATE_KEY)),
);

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

// Native pagination-ladder word per locale (matches jobsSeoPagesPlugin's
// `paginationSlugs` / staticPagesPlugin's ladder). Bare `page-N` under a job
// board section is a legacy English-word crawl (from before canton listings
// switched to a localized ladder) — recover it to its live `pagina-N`/`seite-N`
// twin instead of dropping it as an expired-job slug (real GSC traffic).
const PAGINATION_WORD_BY_LOCALE: Record<SupportedLocale, string> = {
 it: 'pagina',
 en: 'page',
 de: 'seite',
 fr: 'page',
};
const BARE_PAGE_NUMBER_PATTERN = /^page-(\d+)$/;

const COMPANY_ROUTE_PREFIX_BY_LOCALE: Record<SupportedLocale, string> = {
 it: 'azienda',
 en: 'company',
 de: 'unternehmen',
 fr: 'entreprise',
};

// Legacy per-canton related-search cluster URLs (old slug format, now 404) →
// their SPECIFIC live national cluster, verified against the live cluster
// sitemaps; entries with no live match map to the canton job board. Generated
// by scripts/build-search-cluster-301-map.mjs. Consulted in the `ricerca-`
// branch of resolveSearchConsoleCompatTarget below.
const SEARCH_CLUSTER_301_MAP: Record<string, string> = (
  searchClusterMapFile as { map?: Record<string, string> }
).map ?? {};

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
 // Google-indexed wrong-locale-word guess (IT canton name "ticino" grafted
 // onto the DE "jobs-in-" prefix) — the real DE TI section is "jobs-im-tessin".
 '/de/jobs-in-ticino': '/de/jobs-im-tessin/',
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
 // Legacy top-level search-page prefix, pre-dating the per-canton /ricerca-<term>-<city>/
 // combo structure (e.g. /ricerca/offerte-lavoro-infermieri-mendrisio/). Every sampled
 // 404 in this family is a TI-era slug (no canton encoded in the URL), so the safe
 // fallback is the same TI listing root as the bare `/cerca-lavoro/` case above. Note
 // this needs its OWN entry because SEARCH_COMBO_SEGMENT_PATTERN requires a hyphen
 // after "ricerca" (`/ricerca-`), so it does not match this slash-separated legacy shape.
 { pattern: /^\/ricerca\//, canonical: '/cerca-lavoro-ticino/', locale: 'it' },
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
 // 404 once that company has no current-week openings; route to the hub root, all 4 locales
 // (weeklyEmployersPlugin's renderTopHubPage loop emits a hub root for every WEEKLY_EMPLOYERS_LOCALE).
 { pattern: /^\/aziende-che-assumono\//, canonical: '/aziende-che-assumono/', locale: 'it' },
 { pattern: /^\/en\/companies-hiring\//, canonical: '/en/companies-hiring/', locale: 'en' },
 { pattern: /^\/de\/unternehmen-einstellen\//, canonical: '/de/unternehmen-einstellen/', locale: 'de' },
 { pattern: /^\/fr\/entreprises-recrutent\//, canonical: '/fr/entreprises-recrutent/', locale: 'fr' },
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
 // Present only when canonicalPath targets a SPECIFIC pagination-ladder page
 // number recovered from a legacy bare `page-N` URL. The ladder's length is
 // recomputed from live job counts on every build and isn't visible to this
 // pure resolver, so a canton's page N can shrink out of existence between
 // the original GSC crawl and a later build. The SPA has no out-of-range
 // handling for a missing page (falls through to a blank shell, not a 404),
 // so callers with dist/ access should verify canonicalPath's static file
 // still exists and fall back to this section-listing root if not.
 fallbackPath?: string;
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

// URL#hostname is already lowercased per the URL spec, so these stay lowercase.
const SITE_HOSTNAME = new URL(BASE_URL).hostname;
const DUPLICATE_HOSTNAME_PREFIX = `/${SITE_HOSTNAME}/`;
const DUPLICATE_HOSTNAME_WWW_PREFIX = `/www.${SITE_HOSTNAME}/`;

function normalizePath(input: string): string {
 let clean = `/${String(input || '').trim().replace(/^\/+/, '')}`.replace(/\/+/g, '/');
 // Strip an accidental leading duplicate of the site's own hostname as a path
 // segment (e.g. GSC-indexed `/frontaliereticino.ch/en/find-jobs-ticino/...`,
 // an absolute-URL-built-as-relative artifact from a stray external backlink)
 // — without this the whole path never matches any branch below and is left
 // unresolved even though the real path after the duplicate IS recoverable.
 // Match case-insensitively (GSC may index `/Frontaliereticino.ch/...`) and
 // also strip an optional `www.` variant. Slice the ORIGINAL (not lowercased)
 // string so the remaining path keeps its real casing.
 const lowerClean = clean.toLowerCase();
 if (lowerClean.startsWith(DUPLICATE_HOSTNAME_WWW_PREFIX)) {
  clean = clean.slice(DUPLICATE_HOSTNAME_WWW_PREFIX.length - 1);
 } else if (lowerClean.startsWith(DUPLICATE_HOSTNAME_PREFIX)) {
  clean = clean.slice(DUPLICATE_HOSTNAME_PREFIX.length - 1);
 }
 if (clean === '/') return clean;
 return clean.replace(/\/$/, '');
}

function inferLocale(path: string): SupportedLocale {
 // Match case-insensitively (GSC may index a locale segment with drifted
 // casing, e.g. `/EN/find-jobs-ticino/...`) — mirrors normalizePath()'s
 // duplicate-hostname-prefix check above (PR #3419). Unlike that check there
 // is nothing to slice/preserve here: the return value is always one of the
 // four fixed locale codes, never a substring of `path`.
 const lowerPath = path.toLowerCase();
 if (lowerPath.startsWith('/en/')) return 'en';
 if (lowerPath.startsWith('/de/')) return 'de';
 if (lowerPath.startsWith('/fr/')) return 'fr';
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
// Exported: legacyRedirectsPlugin's isJobPath() skip must NOT swallow these — no plugin
// emits a bridge for individual out-of-range pagination leaves, so without this exemption
// the path is silently unresolvable even though this resolver handles it correctly below.
export const JOB_BOARD_PAGINATION_PATTERN = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/(?:alle|tutti|tutte|all|tous|toutes)\\/page-\\d+\\/?$`);
// Expired job-detail leaves with a trailing numeric job id (e.g. /de/jobs-im-tessin/<slug>/3594).
// Two segments after the section, so the single-segment job pattern above never matches them.
const JOB_BOARD_TRAILING_ID_PATTERN = new RegExp(`^\\/(?:(en|de|fr)\\/)?(${JOB_BOARD_SECTION_PATTERN_SEGMENT})\\/[^/]+\\/\\d+\\/?$`);
// Search-combo slug segment (ricerca-/search-/suche-/recherche-). Exported for the same
// reason as JOB_BOARD_PAGINATION_PATTERN above: jobsSeoPagesPlugin explicitly EXCLUDES
// these slugs from its own tracking (searchComboPattern in jobsSeoPagesPlugin.ts), so
// legacyRedirectsPlugin's job-prefix skip must not also swallow them here.
export const SEARCH_COMBO_SEGMENT_PATTERN = /\/(ricerca|search|suche|recherche)-/;
// Event-detail leaves past the plugin's own noindex grace window (eventsSeoPagesPlugin
// stops emitting a bridge EVENT_PAST_GRACE_DAYS after the event ends) or dropped
// pre-emptively (rescheduled/cancelled at source, so never even entered the grace
// window). Capture group 3 = the canton segment (e.g. "ticino") → canonicalize one
// level up to that canton's event hub, which always exists once any event does.
const EVENTS_SECTION_PATTERN = /^\/(?:(en|de|fr)\/)?(eventi|events|veranstaltungen|evenements)\/([^/]+)\//;

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

 // Profession-canton landings (professionCantonLandings.ts) emit every
 // (canton × profession) combo unconditionally — either the full page or a
 // below-floor bridge — so a URL matching this family's exact enumerated
 // shape always has a live target at the SAME path today, even if GSC's
 // Coverage export captured it as 404 from before that page existed / was
 // below floor on an earlier build. Self-map so the compat layer (which
 // never sees the plugin's own route table otherwise) stops reporting it
 // unresolvable.
 if (isProfessionCantonPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 if (SEARCH_COMBO_SEGMENT_PATTERN.test(path)) {
 // Legacy per-canton cluster URL with a KNOWN live target: recover the
 // SPECIFIC live national cluster (verified at map-generation time) instead
 // of the generic canton-listing fallback below. Entries that had no live
 // match are mapped to the canton board, so this lookup is always a strict
 // improvement when present. See scripts/build-search-cluster-301-map.mjs.
 const mapped = SEARCH_CLUSTER_301_MAP[path] || SEARCH_CLUSTER_301_MAP[`${path}/`];
 if (mapped) {
 return { canonicalPath: mapped, kind: 'search', locale };
 }
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

 // Event-detail leaves (past the noindex grace window, or dropped pre-emptively on
 // reschedule/cancellation — see EVENTS_SECTION_PATTERN comment above). match[0] IS
 // already the canton hub root (pattern is anchored through the trailing slash after
 // the canton segment), so no further path construction is needed. The canton hub
 // is only emitted when that canton has an upcoming event THIS build (eventsSeoPagesPlugin
 // groups from upcomingEvents), so unlike the profession-canton/pagination self-maps
 // above it has no universal per-canton guarantee — fallbackPath lets the consuming
 // plugin gap-fill to the Swiss-wide index (EVENTS_INDEX_PATH), which IS unconditional
 // whenever any event exists at all (see review finding on PR #4252).
 const eventsMatch = EVENTS_SECTION_PATTERN.exec(path);
 if (eventsMatch) {
 return {
 canonicalPath: eventsMatch[0],
 kind: 'legacy',
 locale,
 fallbackPath: `${EVENTS_INDEX_PATH[locale]}/`,
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
 // Bare `page-N` (legacy English pagination word, pre-dating the localized
 // ladder) → redirect to the section's real `pagina-N`/`seite-N` twin. The
 // canton is already encoded in urlSection, so no slug index lookup needed.
 const barePageMatch = slug.match(BARE_PAGE_NUMBER_PATTERN);
 if (barePageMatch) {
 const pageNum = barePageMatch[1];
 const word = PAGINATION_WORD_BY_LOCALE[locale];
 return {
 canonicalPath: `${prefix}/${urlSection}/${word}-${pageNum}/`.replace(/\/+/g, '/'),
 kind: 'legacy',
 locale,
 fallbackPath: `${prefix}/${urlSection}/`.replace(/\/+/g, '/'),
 };
 }
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
 // Family self-map: weekly-employers / job-market-snapshot / editorial-canton
 // (today, nurses-hub, part-time, care-variant only) / canton-hub (tutti,
 // settori, aziende) / sector-hub (per-canton sector slugs, non-aggregate
 // sections only — see SELF_MAPPABLE_SECTOR_HUB_SLUGS) all emit this exact
 // single-segment slug under EVERY canton's job-board section
 // unconditionally — either the full page or a below-floor noindex bridge
 // (see renderBelowFloorBridge / emitEditorialBelowFloorBridge /
 // emitCantonHubBelowFloorBridge / emitSectorHubBelowFloorBridge) — so, like
 // isProfessionCantonPath above, a URL matching one of these known slugs
 // always has a live target at the SAME path today, even if GSC's Coverage
 // export captured it as 404 from an earlier build.
 if (
 slug === WEEKLY_EMPLOYERS_SECTION[locale] ||
 slug === SNAPSHOT_SEGMENT ||
 (Object.values(HUB_SLUG_BY_LOCALE[locale]) as string[]).includes(slug) ||
 SELF_MAPPABLE_EDITORIAL_SLUGS.has(slug) ||
 (SELF_MAPPABLE_SECTOR_HUB_SLUGS[locale].has(slug) && !AGGREGATE_SECTIONS.has(urlSection))
 ) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
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

