import { resolveCantonSection, AGGREGATE_KEY, type CantonLocale } from './shared/cantonSection';
import { SECTOR_HUB_KEYS, SECTOR_HUB_SLUG } from './jobSectorLanding';
import { BASE_URL } from './constants';
import cantonSlugFile from '../data/canton-url-slugs.json';
import searchClusterMapFile from '../data/search-cluster-301-map.json';
import employerProfilesFile from '../data/employer-profiles.json';
import {
 FUEL_SECTION_SLUG,
 FUEL_TODAY_SLUG,
 FUEL_LOCALE_PREFIX,
 type FuelDailyLocale,
 type FuelType,
} from './fuelDailyData';
import { isProfessionCantonPath } from './professionCantonData';
import { isSalaryProfessionCantonPath } from './salaryProfessionCantonData';
import { isProfessionCityPath } from './professionCityData';
import { isHealthFacilityPath } from './healthFacilitiesData';
import { WEEKLY_EMPLOYERS_SECTION } from './weeklyEmployersData';
import { CH_CANTON_SNAPSHOT_SEGMENT as SNAPSHOT_SEGMENT } from './jobMarketSnapshotChCantonPathsData';
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
import { isExchangeSsgPath } from './exchangeRateSsgData';
import { isFiscalMunicipalityPath } from './fiscalMunicipalityData';
import { isTopicIndexPath, resolveTopicClusterHubCanonical } from './topicClusterHubsData';
import { isFrenchBorderMunicipalityPath } from './frenchBorderMunicipalityData';
import { isGermanBorderMunicipalityPath } from './germanBorderMunicipalityData';
import { isLiechtensteinBorderMunicipalityPath } from './liechtensteinBorderMunicipalityData';
import { isAustrianBorderMunicipalityPath } from './austrianBorderMunicipalityData';
import { isBorderMunicipalityPath, isBorderMunicipalityHubPath } from './borderMunicipalityData';
import { isBorderWaitPath } from './borderWaitData';

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

// Per-canton sector-hub slugs (jobsSeoPagesPlugin.ts Phase 3.2 for the 23
// non-TI canton sections, jobSectorPagesPlugin.ts for the TI legacy section)
// are emitted for EVERY (canton section × sector × locale) combo
// unconditionally, real self-canonical page — no job-count floor anywhere
// (owner decision 2026-07-16: PR #4254 gave TI no floor, PR follow-up removed
// the matching canton-level MIN_JOBS_FOR_CANTON_PAGE / per-sector
// MIN_JOBS_PER_CANTON_SECTOR floors that used to bridge the other 23 canton
// sections, issue #3747) — so a URL matching a locale's OWN sector slug
// under a non-aggregate canton section always has a live target at the SAME
// path today. The national aggregate
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

// Evergreen employer-profile pages (build-plugins/employerProfilePagesPlugin.ts,
// epic #4462): a company ABOVE the floor gets a full page at /aziende/<slug>/,
// a company in the bridge band gets a noindex,follow bridge at the SAME URL —
// both bands are EMITTED, so both must self-map. Slugs are data-driven (not an
// enumerable shape like isProfessionCantonPath), so unlike the canton/sector
// families we gate the self-map on membership in this Set, precomputed ONCE at
// module load from data/employer-profiles.json — keeps the per-URL check O(1)
// for tests/search-console-compat.test.ts (150k+ paths). A /aziende/<slug>/ URL
// whose slug is NOT emitted falls through to the aziende/ SECTION_FALLBACKS
// entry below (the locale's weekly-employers hub) — the company itself may be
// gone from the corpus, but the /aziende/ family always has a live landing.
const EMPLOYER_PROFILE_SLUGS: ReadonlySet<string> = (() => {
 const s = new Set<string>();
 const ds = employerProfilesFile as {
   profiles?: Array<{ slug?: string }>;
   belowFloor?: Array<{ slug?: string }>;
 };
 for (const p of ds.profiles || []) if (p.slug) s.add(p.slug);
 for (const b of ds.belowFloor || []) if (b.slug) s.add(b.slug);
 return s;
})();

// /aziende/<slug>/ (+ /en|/de|/fr) — single literal segment for every locale
// (mirrors the plugin's path builder). normalizePath() strips the trailing
// slash before this runs, so the pattern is slash-optional.
const EMPLOYER_PROFILE_PATH_RX = /^\/(?:(?:en|de|fr)\/)?aziende\/([a-z0-9][a-z0-9-]*)\/?$/;
function isEmployerProfilePath(path: string): boolean {
 const m = EMPLOYER_PROFILE_PATH_RX.exec(path);
 return !!m && EMPLOYER_PROFILE_SLUGS.has(m[1]);
}

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
 { pattern: /^\/articoli-svizzera\//, canonical: '/articoli-svizzera/', locale: 'it' },
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
 { pattern: /^\/en\/swiss-articles\//, canonical: '/en/swiss-articles/', locale: 'en' },
 { pattern: /^\/de\/schweiz-artikel\//, canonical: '/de/schweiz-artikel/', locale: 'de' },
 { pattern: /^\/fr\/articles-suisse\//, canonical: '/fr/articles-suisse/', locale: 'fr' },
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
 // Evergreen employer-profile leaves (/aziende/<slug>/, isEmployerProfilePath
 // above) whose slug is NOT in data/employer-profiles.json today: the company
 // dropped below BRIDGE_FLOOR (build-employer-profiles.mjs — "singletons: no
 // page, no bridge") since GSC captured the 404, so the profile genuinely has
 // no live page at that exact path anymore. That is NOT the same as "no live
 // target at all": route to the locale's weekly-employers top hub, the same
 // fallback employerProfilePagesPlugin's own below-floor bridge points to
 // ("Prevents silent 404 → canton / weekly-employers hubs"). Must be its own
 // entry (not folded into the aziende-che-assumono block above) because the
 // path shape is a different literal segment (`aziende` vs
 // `aziende-che-assumono`), so no earlier pattern in this array ever matches it
 // — before this entry the path fell through to `return null` (issue #6325).
 { pattern: /^\/aziende\//, canonical: '/aziende-che-assumono/', locale: 'it' },
 { pattern: /^\/en\/aziende\//, canonical: '/en/companies-hiring/', locale: 'en' },
 { pattern: /^\/de\/aziende\//, canonical: '/de/unternehmen-einstellen/', locale: 'de' },
 { pattern: /^\/fr\/aziende\//, canonical: '/fr/entreprises-recrutent/', locale: 'fr' },
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
// Issue #4263 item 2 (reviewer adversarial check, round 1): flagged as "not anchored to
// the terminal path segment — matches ANY occurrence of `/ricerca-` anywhere in the
// path", risking a false exemption in legacyRedirectsPlugin's isCompatResolvableUnderJobPrefix
// for a real, distinct job slug that merely CONTAINS a `/ricerca-`-shaped segment
// somewhere upstream of further real path structure. The reviewer explicitly flagged
// this as an unverified risk ("non ho trovato un caso concreto").
// VERIFIED (this fix): terminal-anchoring (`/\/(ricerca|search|suche|recherche)-[^/]*\/?$/`)
// was tried and reverted — it regressed `tests/search-console-compat.test.ts`'s
// "covers the committed live 404 export paths" check, which walks the full live
// data/seo-404-compat/* accumulator (1.7M+ paths) and requires every entry to resolve.
// Scanning that ENTIRE accumulator for paths where this pattern matches at a
// non-terminal position (i.e. would be dropped by anchoring) surfaces exactly 310
// hits — and every single one is a garbage-suffixed variant of a genuine search-combo
// shape (trailing literal `/null`, a stray `/'` quote segment, or a `/&...`
// tracking-param blob mis-parsed into the path — e.g.
// `/cerca-lavoro-svizzera/ricerca-addetto-alle-prestazioni-m-f-100/null`), never a
// distinct real page. So the terminal-anchoring the reviewer suggested would have
// traded a zero-observed-instance risk for an active regression on real GSC-exported
// 404s. Left unanchored; re-run this scan (grep `ricerca-|search-|suche-|recherche-`
// mid-path in a fresh accumulator export) if a future export surfaces a genuine
// non-terminal, non-garbage match.
export const SEARCH_COMBO_SEGMENT_PATTERN = /\/(ricerca|search|suche|recherche)-/;
// Issue #4303 item 4 self-map confirmation: relatedSearchClustersPlugin.ts's
// `renderClusterBelowFloorBridge` (below MIN_JOBS_FOR_INDEXABLE_CLUSTER=3
// matching jobs) now emits a noindex,follow bridge — canonical → the
// Svizzera hub — at the SAME `/cerca-lavoro-svizzera/ricerca-{slug}/` URL
// instead of a thin near-duplicate page, consolidating the below-floor
// profession×svizzera combos GSC showed averaging position 25.4. No new
// self-map entry needed: SEARCH_COMBO_SEGMENT_PATTERN above already
// resolves this exact URL shape for any stale-snapshot 404 (falls through
// to SEARCH_CLUSTER_301_MAP, then the canton-aware JOB_BOARD_SECTION_COMPAT_PATTERN
// listing-root fallback) — the bridge itself is additionally always-live
// (200 OK), so it never reaches this resolver in the first place.
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

 // Same self-map rationale as isProfessionCantonPath above, for the
 // salary-intent (profession × canton) family (salaryProfessionCantonPages.ts,
 // issue #4461): every enumerated (canton × eligible-profession) combo emits
 // either a full salary page or a below-floor noindex bridge at the SAME path
 // unconditionally, so a stale-snapshot 404 for this shape always has a live
 // target today. isSalaryProfessionCantonPath checks a module-load-precomputed
 // Map (PATH_INDEX), so this stays O(1) per call inside the 150k+-path loop.
 if (isSalaryProfessionCantonPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Same self-map rationale as isProfessionCantonPath above, for the
 // (TI city × profession) family (professionCityLandings.ts, issue #4301):
 // professionCityData.ts's isProfessionCityPath already checks a
 // module-load-precomputed Map (PATH_INDEX), so this stays O(1) per call —
 // no per-call Set/Map construction inside the 150k+-path compat loop.
 if (isProfessionCityPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Health-facilities hub (healthFacilitiesPlugin.ts, epic #4455): every
 // committed facility (build-plugins/healthFacilitiesData.ts) emits, on
 // EVERY build, either a full indexable page (live jobs ≥ floor) or a
 // noindex,follow below-floor bridge — always at the SAME canonical path.
 // So a URL matching an enumerated facility path always has a live target
 // today, even if GSC captured it as 404 from before the page existed.
 // isHealthFacilityPath checks a module-load-precomputed Set (PATH_INDEX),
 // so this stays O(1) per call inside the 150k+-path compat loop.
 if (isHealthFacilityPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Border-wait pages (borderWaitPagesPlugin.ts, issue #4889): every root
 // hub, regional hub and per-crossing "today" page enumerated in
 // build-plugins/borderWaitData.ts emits, on EVERY build, either a full
 // indexable page (word count ≥ floor) or a noindex,follow below-floor
 // bridge — always at the SAME canonical path. So a URL matching this
 // family's exact enumerated shape always has a live target at the SAME
 // path today, even if GSC's Coverage export captured it as 404 from
 // before the page existed / was below floor on an earlier build (e.g. any
 // of the 116 crossings that had live wait data but no page before this
 // corridor rollout). isBorderWaitPath checks a module-load-precomputed
 // Set (BORDER_WAIT_ROUTE_SET), so this stays O(1) per call inside the
 // 150k+-path compat loop.
 if (isBorderWaitPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Evergreen employer-profile pages (/aziende/<slug>/): every slug in
 // data/employer-profiles.json — above-floor page OR below-floor bridge — is
 // emitted at this exact path, so a GSC 404 snapshot for a now-live URL
 // resolves to itself. Unknown slugs fall through (no live page).
 if (isEmployerProfilePath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // CHF/EUR exchange vertical (epic #4452): hub + curated amount pages are
 // emitted UNCONDITIONALLY on every build (static amount set, no data-driven
 // floor), so a URL matching this exact enumerated family always has a live
 // target at the SAME path. isExchangeSsgPath checks a Set precompiled at
 // module load (exchangeRateSsgData.ts) — O(1) per call inside the
 // 150k+-path compat loop, same rationale as the self-maps above.
 if (isExchangeSsgPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Per-municipality FISCAL guide pages (fiscalMunicipalityPagesPlugin.ts,
 // epic #4482): every comune in data/fiscal-municipalities.json is emitted at
 // its enumerated path on EVERY build — the above-floor comuni as an indexable
 // page, the below-floor comuni as a noindex,follow bridge — always at the
 // SAME URL. So a URL matching this family always has a live target today,
 // even if GSC captured it as 404 before the page existed.
 // isFiscalMunicipalityPath checks a module-load-precomputed Set, so this
 // stays O(1) per call inside the 150k+-path compat loop.
 if (isFiscalMunicipalityPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Article topic hubs (topicClusterHubsPlugin.ts, issue #5001): every topic in
 // the curated taxonomy is emitted for every (section × locale) on EVERY build
 // — above the article floor as an indexable hub, below it as a noindex,follow
 // bridge — always at the SAME URL. So a URL in this family always has a live
 // target today, even if GSC captured it as 404 before the family existed.
 //
 // Paginated hub URLs resolve to the hub's page 1 rather than to themselves:
 // a topic's article count moves with the corpus, so `/…/page-9/` may have
 // been live and indexed when the topic was larger, while page 1 is the page
 // guaranteed to exist for every topic on every build.
 // Both helpers read a module-load-precomputed Set (the taxonomy is curated,
 // so the URL space is a constant), keeping this O(1) per call inside the
 // 150k+-path compat loop.
 {
 const topicHubCanonical = resolveTopicClusterHubCanonical(path);
 if (topicHubCanonical) {
 return {
 canonicalPath: topicHubCanonical,
 kind: 'legacy',
 locale,
 };
 }
 }

 // The bare topic INDEX one level above those hubs (issue #5436):
 // `/{section}/{argomenti|topics|themen|sujets}/`, 8 URLs. Same self-map, and
 // it needs one for a reason the hub branch does not have: this URL was a hard
 // 404 for as long as the hub family existed, so unlike the hubs it is exactly
 // the kind of path GSC has already captured as an error — from a crawler
 // truncating a hub URL, or from the archive nav's own base path. Now that
 // `renderTopicHubSectionCore` emits it on every render, the honest answer is
 // itself.
 //
 // NOT folded into `resolveTopicClusterHubCanonical` above: that helper
 // answers "which hub does this URL belong to", and the index belongs to none
 // — mapping it onto a hub would hand a crawler a canonical that contradicts
 // the page's own `<link rel="canonical">`. Same O(1) module-load Set.
 if (isTopicIndexPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Per-municipality FRANCE border pages (frenchBorderMunicipalityPagesPlugin.ts,
 // issue #4545): every commune in data/french-border-municipalities.json is
 // emitted at its enumerated path on EVERY build — above-floor communes as an
 // indexable page, below-floor communes as a noindex,follow bridge — always
 // at the SAME URL. Same self-map rationale as the fiscal branch above.
 // isFrenchBorderMunicipalityPath checks a module-load-precomputed Set, so
 // this stays O(1) per call inside the 150k+-path compat loop.
 if (isFrenchBorderMunicipalityPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // isGermanBorderMunicipalityPath checks a module-load-precomputed Set, so
 // this stays O(1) inside this loop (150k+ paths in
 // tests/search-console-compat.test.ts) — same rationale as the FRANCE
 // self-map branch above.
 if (isGermanBorderMunicipalityPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // isLiechtensteinBorderMunicipalityPath checks a module-load-precomputed
 // Set, same O(1) rationale as the FRANCE/GERMANY self-map branches above.
 if (isLiechtensteinBorderMunicipalityPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // isAustrianBorderMunicipalityPath checks a module-load-precomputed Set,
 // same O(1) rationale as the FRANCE/GERMANY/LIECHTENSTEIN self-map branches
 // above. Austria's own regime has no favourable frontalieri treatment (see
 // austrianBorderMunicipalityData.ts's AUSTRIAN_REGIME) but the self-map
 // contract is identical: every enumerated Gemeinde is live at its path on
 // every build, above-floor as an indexable page, below-floor as a
 // noindex,follow bridge, never a silent skip.
 if (isAustrianBorderMunicipalityPath(path)) {
 return {
 canonicalPath: ensureTrailingSlash(path),
 kind: 'legacy',
 locale,
 };
 }

 // Per-municipality ITALIAN border pages (borderMunicipalityPagesPlugin.ts) —
 // the largest of the five families and, until now, the only one without a
 // self-map. Its URLs matched the SECTION_FALLBACKS entries below
 // (`^/vivere-in-ticino/` and the en/de/fr twins), which resolve a comune to
 // the section HUB rather than to itself. That fallback is right for a truly
 // dead `/vivere-in-ticino/*` URL and wrong for a comune that is simply
 // absent from one build, so the enumerated set has to win — hence this
 // branch sits ahead of the fallback loop, alongside its four siblings.
 // isBorderMunicipalityPath checks a module-load-precomputed Set (O(1) inside
 // the 150k+-path compat loop), built from the unfiltered province filter so
 // BORDER_MUNICIPALITY_PAGE_LIMIT cannot shrink it.
 if (isBorderMunicipalityPath(path) || isBorderMunicipalityHubPath(path)) {
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

