export type JobLandingLocale = 'it' | 'en' | 'de' | 'fr';
export type JobLandingTypeKey = 'apprenticeship' | 'internship' | 'partTime';
export type JobLandingSectorKey = 'health' | 'finance' | 'tech' | 'engineering' | 'admin' | 'hospitality' | 'sales';
export type JobCareClusterKey = 'clinics' | 'careHomes' | 'oss' | 'educators';

import cantonSlugFile from '../data/canton-url-slugs.json';
import municipalitiesFile from '../data/canton-municipalities.json';
import { resolveJobCanton } from './shared/cantonSection';

type CantonSlugEntry = { it: string; en: string; de: string; fr: string; dePrefix?: string };
type CantonMunicipalitiesFile = {
 cantons: Record<string, { municipalities: string[] }>;
};

// ── Canton display names by locale ────────────────────────────────────
//
// TI/GR/VS rows preserved BYTE-IDENTICALLY from the legacy implementation
// (Phase 5 P1-A — must keep TI editorial URLs invariant). The remaining
// 21 cantons are auto-generated from data/canton-url-slugs.json using a
// title-case helper applied to the locale slug.
const CANTON_DISPLAY_LOCALE: Record<string, Record<JobLandingLocale, string>> = (() => {
 const out: Record<string, Record<JobLandingLocale, string>> = {
  TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' },
  GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' },
  VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' },
 };
 const cap = (s: string): string => s
  .split('-')
  .map((word) => word.split(' ')
   .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
   .join(' '))
  .join('-');
 const cantonsTable = (cantonSlugFile as { cantons: Record<string, CantonSlugEntry> }).cantons;
 for (const [code, raw] of Object.entries(cantonsTable)) {
  if (out[code]) continue;
  out[code] = { it: cap(raw.it), en: cap(raw.en), de: cap(raw.de), fr: cap(raw.fr) };
 }
 return out;
})();

// ── Canton slug by locale (URL-safe) ──────────────────────────────────
//
// TI/GR/VS rows preserved BYTE-IDENTICALLY from the legacy implementation.
// Remaining 21 cantons auto-generated from canton-url-slugs.json.
const CANTON_SLUG_LOCALE: Record<string, Record<JobLandingLocale, string>> = (() => {
 const out: Record<string, Record<JobLandingLocale, string>> = {
  TI: { it: 'ticino', en: 'ticino', de: 'tessin', fr: 'tessin' },
  GR: { it: 'grigioni', en: 'graubunden', de: 'graubunden', fr: 'grisons' },
  VS: { it: 'vallese', en: 'valais', de: 'wallis', fr: 'valais' },
 };
 const cantonsTable = (cantonSlugFile as { cantons: Record<string, CantonSlugEntry> }).cantons;
 for (const [code, raw] of Object.entries(cantonsTable)) {
  if (out[code]) continue;
  out[code] = { it: raw.it, en: raw.en, de: raw.de, fr: raw.fr };
 }
 return out;
})();

// French preposition for canton names — keep legacy special cases for
// TI/GR/VS exactly; add Jura/Vaud/Argovie special cases for the wider
// rollout. Default fallback "dans le canton de X" stays grammatically safe.
const frenchCantonPrep = (display: string): string => {
 if (['Tessin', 'Jura'].includes(display)) return `au ${display}`;
 if (display === 'Grisons') return `aux ${display}`;
 if (['Valais', 'Vaud', 'Argovie'].includes(display)) return `en ${display}`;
 return `dans le canton de ${display}`;
};

// German preposition for canton names — legacy cases (Tessin/Wallis/Jura)
// preserved; Aargau + Thurgau added based on `dePrefix: jobs-im-` in
// canton-url-slugs.json. Vaud (Waadt) takes "in der Waadt".
const germanCantonPrep = (display: string): string => {
 if (['Tessin', 'Wallis', 'Jura', 'Aargau', 'Thurgau'].includes(display)) return `im ${display}`;
 if (display === 'Waadt') return `in der ${display}`;
 return `in ${display}`;
};

// ── Editorial canton constants ────────────────────────────────────────
//
// EDITORIAL_PRIMARY_CANTONS is the legacy 3-canton list used purely for
// human-readable prose ("Ticino, Grigioni e Vallese"). It is NOT used to
// gate page emission. EDITORIAL_CANTONS is the full 24-canton set sourced
// from canton-url-slugs.json (22 single cantons + APPENZELLO + BASILEA URL
// groups). Emit loops MUST gate per-canton on MIN_JOBS_FOR_CANTON_PAGE so
// thin pages are never emitted (CLAUDE.md non-negotiable #4).
export const EDITORIAL_PRIMARY_CANTONS = ['TI', 'GR', 'VS'] as const;

export const EDITORIAL_CANTONS: readonly string[] = Object.freeze(
 Object.keys((cantonSlugFile as { cantons: Record<string, CantonSlugEntry> }).cantons).sort()
);

// ── Per-canton slug tables ────────────────────────────────────────────
//
// TI/GR/VS rows preserved BYTE-IDENTICALLY from the legacy implementation
// (Phase 5 P1-A — TI editorial URLs must stay invariant). Remaining cantons
// auto-generated from CANTON_SLUG_LOCALE with locale-specific templates.

// Phase 8d revert (2026-05-18): every canton now uses a per-canton
// long-form slug so the URL is `/cerca-lavoro-{canton}/{slug-with-canton-name}/`.
// The earlier "short-form for non-TI/GR/VS" design saved a URL segment but
// (a) made keyword matching weaker for SEO and (b) was inconsistent — TI
// used `infermieri-in-ticino` while BASILEA used `infermieri`. The
// long-form template is byte-identical to TI/GR/VS for the three legacy
// cantons (CLAUDE.md non-negotiable preserves those URLs); the remaining
// 21 cantons get the template `offerte-di-lavoro-{cantonSlug.locale}-oggi`
// etc. Old short-form URLs (`infermieri`, `oggi`) remain reachable via
// LEGACY_SHORT_FORM_SLUGS_BY_SLOT + cantonOrphanRedirectsPlugin.
const JOB_TODAY_LANDING_SLUGS_BY_CANTON: Record<string, Record<JobLandingLocale, string>> = (() => {
 const out: Record<string, Record<JobLandingLocale, string>> = {
  TI: { it: 'offerte-di-lavoro-ticino-oggi', en: 'ticino-jobs-today', de: 'jobs-tessin-heute', fr: 'offres-emploi-tessin-aujourdhui' },
  GR: { it: 'offerte-di-lavoro-grigioni-oggi', en: 'graubunden-jobs-today', de: 'jobs-graubunden-heute', fr: 'offres-emploi-grisons-aujourdhui' },
  VS: { it: 'offerte-di-lavoro-vallese-oggi', en: 'valais-jobs-today', de: 'jobs-wallis-heute', fr: 'offres-emploi-valais-aujourdhui' },
 };
 for (const code of Object.keys(CANTON_SLUG_LOCALE)) {
  if (out[code]) continue;
  const slugs = CANTON_SLUG_LOCALE[code];
  out[code] = {
   it: `offerte-di-lavoro-${slugs.it}-oggi`,
   en: `${slugs.en}-jobs-today`,
   de: `jobs-${slugs.de}-heute`,
   fr: `offres-emploi-${slugs.fr}-aujourdhui`,
  };
 }
 return out;
})();

const JOB_NURSES_HUB_SLUGS_BY_CANTON: Record<string, Record<JobLandingLocale, string>> = (() => {
 const out: Record<string, Record<JobLandingLocale, string>> = {
  TI: { it: 'infermieri-in-ticino', en: 'nurses-in-ticino', de: 'pflege-jobs-im-tessin', fr: 'infirmiers-au-tessin' },
  GR: { it: 'infermieri-in-grigioni', en: 'nurses-in-graubunden', de: 'pflege-jobs-in-graubunden', fr: 'infirmiers-aux-grisons' },
  VS: { it: 'infermieri-in-vallese', en: 'nurses-in-valais', de: 'pflege-jobs-im-wallis', fr: 'infirmiers-en-valais' },
 };
 for (const code of Object.keys(CANTON_SLUG_LOCALE)) {
  if (out[code]) continue;
  const slugs = CANTON_SLUG_LOCALE[code];
  // DE preposition "in" matches the GR legacy (`pflege-jobs-in-graubunden`).
  // FR preposition "a" is a safe default — TI/GR/VS keep their idiomatic
  // au/aux/en variants above; new cantons use the simplest preposition.
  out[code] = {
   it: `infermieri-in-${slugs.it}`,
   en: `nurses-in-${slugs.en}`,
   de: `pflege-jobs-in-${slugs.de}`,
   fr: `infirmiers-a-${slugs.fr}`,
  };
 }
 return out;
})();

const JOB_PART_TIME_LANDING_SLUGS_BY_CANTON: Record<string, Record<JobLandingLocale, string>> = (() => {
 const out: Record<string, Record<JobLandingLocale, string>> = {
  TI: { it: 'lavoro-part-time-ticino', en: 'part-time-jobs-ticino', de: 'teilzeit-jobs-tessin', fr: 'emploi-temps-partiel-tessin' },
  GR: { it: 'lavoro-part-time-grigioni', en: 'part-time-jobs-graubunden', de: 'teilzeit-jobs-graubunden', fr: 'emploi-temps-partiel-grisons' },
  VS: { it: 'lavoro-part-time-vallese', en: 'part-time-jobs-valais', de: 'teilzeit-jobs-wallis', fr: 'emploi-temps-partiel-valais' },
 };
 for (const code of Object.keys(CANTON_SLUG_LOCALE)) {
  if (out[code]) continue;
  const slugs = CANTON_SLUG_LOCALE[code];
  out[code] = {
   it: `lavoro-part-time-${slugs.it}`,
   en: `part-time-jobs-${slugs.en}`,
   de: `teilzeit-jobs-${slugs.de}`,
   fr: `emploi-temps-partiel-${slugs.fr}`,
  };
 }
 return out;
})();

// Backward-compatible exports: TI defaults
export const JOB_PART_TIME_LANDING_SLUGS: Record<JobLandingLocale, string> = {
 it: 'lavoro-part-time',
 en: 'part-time-jobs',
 de: 'teilzeit-jobs',
 fr: 'emploi-temps-partiel',
};

export const JOB_TODAY_LANDING_SLUGS = JOB_TODAY_LANDING_SLUGS_BY_CANTON['TI'];

export function getJobTodayLandingSlug(locale: JobLandingLocale, canton: string = 'TI'): string {
 const slugs = JOB_TODAY_LANDING_SLUGS_BY_CANTON[canton] || JOB_TODAY_LANDING_SLUGS;
 return slugs[locale];
}

// Phase 8 sub-PR (d) helper accessor — TI defaults preserved; non-TI/GR/VS
// cantons return the short slug (`infermieri` / `nurses` / `pflege-jobs` /
// `infirmiers`). Used by the canton-hub "Esplora" navigator to link the
// Phase 8d editorial slot pages without rebuilding the lookup table.
export function getJobNursesHubSlug(locale: JobLandingLocale, canton: string = 'TI'): string {
 const slugs = JOB_NURSES_HUB_SLUGS_BY_CANTON[canton] || JOB_NURSES_HUB_SLUGS;
 return slugs[locale];
}

// Phase 8 sub-PR (d) helper accessor — TI defaults preserved; non-TI/GR/VS
// cantons return the short slug (`lavoro-part-time` / `part-time-jobs` / …).
export function getJobPartTimeLandingSlug(locale: JobLandingLocale, canton: string = 'TI'): string {
 const slugs = JOB_PART_TIME_LANDING_SLUGS_BY_CANTON[canton] || JOB_PART_TIME_LANDING_SLUGS_BY_CANTON['TI'];
 return slugs[locale];
}

export const JOB_OFFICIAL_GAZETTE_LANDING_SLUGS: Record<JobLandingLocale, string> = {
 it: 'foglio-ufficiale-offerte-di-lavoro-ticino',
 en: 'official-gazette-ticino-jobs',
 de: 'amtsblatt-stellen-tessin',
 fr: 'feuille-officielle-emplois-tessin',
};

export const JOB_NURSES_HUB_SLUGS = JOB_NURSES_HUB_SLUGS_BY_CANTON['TI'];

const SEARCH_ROUTE_PREFIX: Record<JobLandingLocale, string> = {
 it: 'ricerca',
 en: 'search',
 de: 'suche',
 fr: 'recherche',
};

// ── Editorial locations per canton ────────────────────────────────────
//
// TI/GR/VS rows preserved verbatim. For the remaining 21 cantons we take
// the first 5 BFS municipalities from data/canton-municipalities.json
// (alphabetical fallback — acceptable per the Phase 5 plan). Half-cantons
// AI/AR collapse into the APPENZELLO URL group, BL/BS into BASILEA.
const EDITORIAL_LOCATIONS_BY_CANTON: Record<string, readonly string[]> = (() => {
 const out: Record<string, readonly string[]> = {
  TI: ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'],
  GR: ['Chur', 'Davos', 'St. Moritz'],
  VS: ['Sion', 'Brig', 'Visp', 'Martigny', 'Monthey', 'Sierre'],
 };
 const municipalitiesByCanton = (municipalitiesFile as CantonMunicipalitiesFile).cantons;
 // Aggregate half-canton members onto their URL group.
 const groupBuckets: Record<string, string[]> = {};
 for (const [code, info] of Object.entries(municipalitiesByCanton)) {
  let key = code;
  if (code === 'AI' || code === 'AR') key = 'APPENZELLO';
  if (code === 'BL' || code === 'BS') key = 'BASILEA';
  if (out[key]) continue;
  if (key !== code) {
   if (!groupBuckets[key]) groupBuckets[key] = [];
   groupBuckets[key].push(...info.municipalities);
  } else {
   out[key] = info.municipalities.slice(0, 5);
  }
 }
 for (const [groupKey, merged] of Object.entries(groupBuckets)) {
  if (out[groupKey]) continue;
  // Dedupe + alphabetical, take first 5.
  const unique = Array.from(new Set(merged)).sort();
  out[groupKey] = unique.slice(0, 5);
 }
 return out;
})();

// Backward compatibility: all supported locations across all cantons
const SUPPORTED_EDITORIAL_LOCATIONS = Object.values(EDITORIAL_LOCATIONS_BY_CANTON).flat() as string[];
const SUPPORTED_EDITORIAL_LOCATION_SET = new Set<string>(SUPPORTED_EDITORIAL_LOCATIONS);

// SEO plugin uses Italian sector keys that don't always match JOB_SECTOR_DEFS slugs
const SECTOR_SLUG_ALIASES: Record<string, JobLandingSectorKey> = {
 informatica: 'tech',
 vendita: 'sales',
 ristorazione: 'hospitality',
};

type JobLike = Record<string, any>;

// ── Editorial job-link shape ─────────────────────────────────────────
//
// The thin {title, company, location, href} contract was sufficient when
// editorial landings rendered plaintext lists, but the shared SPA-style
// renderer (build-plugins/shared/jobCardHtml.ts) needs salary, contract,
// posted-date, logo, canton and featured flags to draw the same chips the
// in-app <JobCard> shows. We mirror the enrichment pattern already used by
// `RecencyJobLink` in build-plugins/jobRecencyLanding.ts so every
// editorial-model job listing renders an identical card.
//
// All enrichment fields are optional — callers without source data still
// produce valid `LandingJobLink`s and the renderer simply hides the
// corresponding chips.
export type LandingJobLink = {
 title: string;
 company: string;
 location: string;
 href: string;
 datePosted?: string;
 titleByLocale?: Partial<Record<JobLandingLocale, string>>;
 companyKey?: string;
 canton?: string;
 contract?: string;
 salaryMin?: number | null;
 salaryMax?: number | null;
 featured?: boolean;
 logo?: string | null;
 addressLocality?: string;
 /** Pass-through for the SPA-card logo chain (resolveCompanyWebsiteHost
  * needs companyDomain/url to produce a Google favicon — without them
  * the renderer falls back to the deterministic initials placeholder). */
 companyDomain?: string;
 url?: string;
};

type LandingSection = {
 label: string;
 jobs: LandingJobLink[];
};

type CityLeader = {
 name: string;
 count: number;
 href: string;
};

type TypeLink = {
 key: JobLandingTypeKey;
 label: string;
 href: string;
 count: number;
};

type SectorLink = {
 key: JobLandingSectorKey;
 label: string;
 href: string;
 count: number;
};

export type JobTodayLandingModel = {
 slug: string;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 sections: {
 last24Hours: LandingSection;
 last3Days: LandingSection;
 partTime: LandingSection;
 cityHubLabel: string;
 cities: CityLeader[];
 };
 internalLinks: Array<{ label: string; href: string }>;
 openAllLabel: string;
};

export type JobLocationLandingModel = {
 kind: 'location';
 slug: string;
 location: string;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 relatedTypeLinks: TypeLink[];
 relatedSectorLinks: SectorLink[];
 openAllLabel: string;
};

export type JobLocationTypeLandingModel = {
 kind: 'location-type';
 slug: string;
 location: string;
 typeKey: JobLandingTypeKey;
 typeLabel: string;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 parentLocationHref: string;
 siblingTypeLinks: TypeLink[];
 openAllLabel: string;
};

export type JobLocationSectorLandingModel = {
 kind: 'location-sector';
 slug: string;
 location: string;
 sectorKey: JobLandingSectorKey;
 sectorLabel: string;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 parentLocationHref: string;
 siblingSectorLinks: SectorLink[];
 openAllLabel: string;
};

export type JobSectorRegionLandingModel = {
 kind: 'sector-region';
 slug: string;
 sectorKey: JobLandingSectorKey;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 siblingSectorLinks: SectorLink[];
 openAllLabel: string;
};

export type JobOfficialGazetteLandingModel = {
 kind: 'official-gazette';
 slug: string;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 explainerTitle: string;
 explainerCards: Array<{ title: string; body: string }>;
 officialSourceLabel: string;
 officialSourceUrl: string;
 internalLinks: Array<{ label: string; href: string }>;
 faq: Array<{ question: string; answer: string }>;
 openAllLabel: string;
};

type CareVariantLink = {
 key: JobCareClusterKey;
 label: string;
 href: string;
 count: number;
};

export type JobNursesHubLandingModel = {
 kind: 'nurses-hub';
 slug: string;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 variantTitle: string;
 variants: CareVariantLink[];
 explainerCards: Array<{ title: string; body: string }>;
 faq: Array<{ question: string; answer: string }>;
 openAllLabel: string;
};

export type JobCareVariantLandingModel = {
 kind: 'care-variant';
 slug: string;
 clusterKey: JobCareClusterKey;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 parentHubHref: string;
 siblingLinks: CareVariantLink[];
 openAllLabel: string;
};

export type JobPartTimeLandingModel = {
 kind: 'part-time';
 slug: string;
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 totalJobs: number;
 feed: LandingSection;
 latestLabel: string;
 latestJobs: LandingJobLink[];
 cityLinks: CityLeader[];
 cityHubLabel: string;
 faq: Array<{ question: string; answer: string }>;
 openAllLabel: string;
};

export type EditorialLandingDescriptor =
 | { kind: 'today'; canton?: string }
 | { kind: 'official-gazette' }
 | { kind: 'nurses-hub'; canton?: string }
 | { kind: 'part-time'; canton?: string }
 | { kind: 'care-variant'; clusterKey: JobCareClusterKey; canton?: string }
 | { kind: 'location'; location: string }
 | { kind: 'location-type'; location: string; typeKey: JobLandingTypeKey }
 | { kind: 'location-sector'; location: string; sectorKey: JobLandingSectorKey }
 | { kind: 'sector-region'; sectorKey: JobLandingSectorKey; canton?: string }
 | { kind: 'recency'; variant: 'last-3-days' | 'since-yesterday' };

function makeTodayCopy(cantonCode: string): Record<JobLandingLocale, {
 title: string;
 heading: string;
 description: string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 fresh24h: string;
 fresh3d: string;
 partTime: string;
 cityHub: string;
 openAll: string;
 internalLinks: [string, string, string];
}> {
 const cd = CANTON_DISPLAY_LOCALE[cantonCode] || CANTON_DISPLAY_LOCALE['TI'];
 const cities = (EDITORIAL_LOCATIONS_BY_CANTON[cantonCode] || EDITORIAL_LOCATIONS_BY_CANTON['TI']).join(', ');
 return {
 it: {
 // Title kept ≤66 chars (audit:title-length cap). Shortened from
 // "Ultime 24 ore e ultimi 3 giorni" (31 chars) to a compact
 // "24 ore + 3 giorni" tail to absorb long canton names like Grigioni.
 title: `Offerte di lavoro ${cd.it} oggi | 24 ore + 3 giorni`,
 heading: `Offerte di lavoro ${cd.it} oggi`,
 description: `Scopri le offerte di lavoro in ${cd.it} pubblicate oggi o negli ultimi 3 giorni, con blocchi dedicati a ultime 24 ore, part-time e citta come ${cities}.`,
 intro: `Questa landing editoriale raccoglie gli annunci piu freschi del nostro job board ${cd.it} e li organizza in blocchi utili per chi cerca lavoro in ${cd.it} e vuole capire subito dove si sta muovendo il mercato.`,
 updatedLabel: 'Aggiornamento',
 countsLabel: 'annunci attivi monitorati',
 fresh24h: 'Ultime 24 ore',
 fresh3d: 'Ultimi 3 giorni',
 partTime: `Part-time in ${cd.it}`,
 cityHub: 'Per citta',
 openAll: `Vedi tutte le offerte di lavoro in ${cd.it}`,
 internalLinks: ['Ultime 24 ore', 'Ultimi 3 giorni', `Part-time in ${cd.it}`],
 },
 en: {
 title: `${cd.en} jobs today | last 24h + 3 days`,
 heading: `${cd.en} jobs today`,
 description: `Browse ${cd.en} jobs published today or in the last 3 days, with dedicated blocks for the last 24 hours, part-time roles and key cities such as ${cities}.`,
 intro: `This editorial landing page groups the freshest jobs from our ${cd.en} job board and makes it easier to scan where employers are actively hiring.`,
 updatedLabel: 'Updated',
 countsLabel: 'active jobs tracked',
 fresh24h: 'New jobs in the last 24 hours',
 fresh3d: 'Jobs from the last 3 days',
 partTime: `Part-time jobs in ${cd.en}`,
 cityHub: 'Browse by city',
 openAll: `See all jobs in ${cd.en}`,
 internalLinks: ['Last 24 hours', 'Last 3 days', `Part-time jobs in ${cd.en}`],
 },
 de: {
 title: `Jobs ${germanCantonPrep(cd.de)} heute | letzte 24h + 3 Tage`,
 heading: `Jobs ${germanCantonPrep(cd.de)} heute`,
 description: `Entdecken Sie Jobs ${germanCantonPrep(cd.de)}, die heute oder in den letzten 3 Tagen veroffentlicht wurden, mit Bereichen fur 24h, Teilzeit und Stadte.`,
 intro: `Diese Landingpage bundelt die frischesten Stellen aus unserem Job Board ${cd.de} und ordnet sie in nutzliche Blocke fur eine schnelle Orientierung.`,
 updatedLabel: 'Aktualisiert',
 countsLabel: 'aktive Jobs im Monitoring',
 fresh24h: 'Neue Jobs in den letzten 24 Stunden',
 fresh3d: 'Jobs der letzten 3 Tage',
 partTime: `Teilzeitjobs ${germanCantonPrep(cd.de)}`,
 cityHub: 'Nach Stadt suchen',
 openAll: `Alle Jobs ${germanCantonPrep(cd.de)} ansehen`,
 internalLinks: ['Neue Jobs in den letzten 24 Stunden', 'Jobs der letzten 3 Tage', `Teilzeitjobs ${germanCantonPrep(cd.de)}`],
 },
 fr: {
 title: `Emplois ${frenchCantonPrep(cd.fr)} aujourd'hui | 24h + 3 jours`,
 heading: `Offres d'emploi ${frenchCantonPrep(cd.fr)} aujourd'hui`,
 description: `Consultez les offres d'emploi ${frenchCantonPrep(cd.fr)} publiees aujourd'hui ou ces 3 derniers jours, avec blocs 24h, temps partiel et villes.`,
 intro: `Cette landing page regroupe les offres les plus recentes de notre job board ${frenchCantonPrep(cd.fr)} et les organise en blocs utiles pour lire rapidement le marche.`,
 updatedLabel: 'Mis a jour',
 countsLabel: 'offres actives suivies',
 fresh24h: 'Nouvelles offres des dernieres 24 heures',
 fresh3d: 'Offres des 3 derniers jours',
 partTime: `Temps partiel ${frenchCantonPrep(cd.fr)}`,
 cityHub: 'Par ville',
 openAll: `Voir toutes les offres ${frenchCantonPrep(cd.fr)}`,
 internalLinks: ['Dernieres 24 heures', '3 derniers jours', `Temps partiel ${frenchCantonPrep(cd.fr)}`],
 },
 };
}

const TODAY_COPY = makeTodayCopy('TI');

const OFFICIAL_GAZETTE_COPY: Record<JobLandingLocale, {
 title: string;
 heading: string;
 description: (count: number) => string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 feedLabel: string;
 latestLabel: string;
 openAll: string;
 officialSourceLabel: string;
 explainerTitle: string;
 explainerCards: Array<{ title: string; body: string }>;
 internalLinks: [string, string];
 faq: Array<{ question: string; answer: string }>;
}> = {
 it: {
 title: 'Foglio ufficiale lavoro Ticino | Concorsi pubblici',
 heading: 'Foglio ufficiale offerte di lavoro Ticino',
 description: (count) => `Consulta ${count} concorsi pubblici e offerte dal Foglio ufficiale del Ticino indicizzati da Frontaliere Ticino, con spiegazione su concorsi, job board e fonti.`,
 intro: 'Questa pagina ti aiuta a distinguere tra concorsi pubblici, annunci del nostro job board e fonti ufficiali cantonali. Qui trovi soprattutto concorsi pubblici indicizzati da fonti ufficiali come concorsi.ti.ch, con link interni alle schede gia pulite e leggibili.',
 updatedLabel: 'Aggiornamento',
 countsLabel: 'concorsi pubblici indicizzati',
 feedLabel: 'Concorsi pubblici e offerte dal Foglio ufficiale',
 latestLabel: 'Nuovi concorsi negli ultimi 3 giorni',
 openAll: 'Vedi tutte le offerte in Ticino',
 officialSourceLabel: 'Fonte ufficiale cantonale',
 explainerTitle: 'Come leggere le offerte del Foglio ufficiale in Ticino',
 explainerCards: [
 {
 title: 'Concorsi pubblici',
 body: 'Sono bandi per enti pubblici o amministrazioni. Hanno requisiti formali, documenti obbligatori, scadenze precise e procedure di candidatura rigidamente definite.',
 },
 {
 title: 'Job board aggregato',
 body: 'Il nostro job board unisce aziende private, enti pubblici e concorsi ufficiali in un unico posto. Serve per confrontare piu opportunita, non sostituisce la fonte originaria.',
 },
 {
 title: 'Fonti ufficiali',
 body: 'Le fonti ufficiali come concorsi.ti.ch restano il riferimento per testo integrale, formulari, allegati e validita del bando. Noi le rendiamo piu facili da trovare e filtrare.',
 },
 ],
 internalLinks: ['Ultimi concorsi pubblici', 'Tutte le offerte in Ticino'],
 faq: [
 {
 question: 'Che differenza c e tra Foglio ufficiale e job board?',
 answer: 'Il Foglio ufficiale pubblica concorsi pubblici e bandi istituzionali. Il job board di Frontaliere Ticino raccoglie sia queste fonti ufficiali sia annunci di aziende private.',
 },
 {
 question: 'Queste offerte sostituiscono la fonte ufficiale?',
 answer: 'No. La fonte ufficiale resta il riferimento per il testo completo del concorso, i documenti richiesti e la candidatura. Le nostre schede servono per trovare e leggere piu rapidamente i bandi.',
 },
 {
 question: 'Trovo solo concorsi pubblici?',
 answer: 'In questa pagina il focus e sui concorsi pubblici e sulle offerte da fonti ufficiali cantonali gia indicizzate da noi.',
 },
 ],
 },
 en: {
 title: 'Official Gazette Ticino jobs | Public competitions',
 heading: 'Official Gazette jobs in Ticino',
 description: (count) => `Browse ${count} public competitions and jobs from the Ticino Official Gazette indexed by Frontaliere Ticino, with public vs job board vs official sources explained.`,
 intro: 'This page helps you understand the difference between public competitions, our broader job board and official canton sources. It focuses on public-sector listings already indexed from official sources such as concorsi.ti.ch.',
 updatedLabel: 'Updated',
 countsLabel: 'indexed public competitions',
 feedLabel: 'Public competitions and Official Gazette jobs',
 latestLabel: 'Newest public competitions in the last 3 days',
 openAll: 'See all jobs in Ticino',
 officialSourceLabel: 'Official canton source',
 explainerTitle: 'How to read Official Gazette job listings in Ticino',
 explainerCards: [
 {
 title: 'Public competitions',
 body: 'These are formal openings for public institutions or government bodies. They usually include strict deadlines, required documents and a defined hiring process.',
 },
 {
 title: 'Aggregated job board',
 body: 'Our job board combines private employers, public institutions and official competitions in one place so you can compare opportunities faster.',
 },
 {
 title: 'Official sources',
 body: 'Official sources such as concorsi.ti.ch remain the source of truth for the full text, attachments and final application rules. We make them easier to discover and filter.',
 },
 ],
 internalLinks: ['Latest public competitions', 'All jobs in Ticino'],
 faq: [
 {
 question: 'What is the difference between the Official Gazette and a job board?',
 answer: 'The Official Gazette publishes public competitions and institutional openings. Frontaliere Ticino also includes private-company openings in its job board.',
 },
 {
 question: 'Does this page replace the official source?',
 answer: 'No. The official source remains the reference for the full competition text, required documents and the final application process.',
 },
 {
 question: 'Does this page only include public-sector roles?',
 answer: 'This page focuses on public competitions and openings indexed from official canton sources.',
 },
 ],
 },
 de: {
 title: 'Amtsblatt Stellen Tessin | Offentliche Ausschreibungen',
 heading: 'Amtsblatt-Stellen im Tessin',
 description: (count) => `Entdecken Sie ${count} offentliche Ausschreibungen aus offiziellen Tessiner Quellen, indexiert von Frontaliere Ticino, mit Erklarung zu Wettbewerb und Quellen.`,
 intro: 'Diese Seite hilft bei der Unterscheidung zwischen offentlichen Ausschreibungen, unserem umfassenderen Job Board und offiziellen kantonalen Quellen. Im Fokus stehen bereits indexierte Ausschreibungen aus offiziellen Quellen wie concorsi.ti.ch.',
 updatedLabel: 'Aktualisiert',
 countsLabel: 'indexierte offentliche Ausschreibungen',
 feedLabel: 'Offentliche Ausschreibungen und Stellen aus dem Amtsblatt',
 latestLabel: 'Neueste offentliche Ausschreibungen der letzten 3 Tage',
 openAll: 'Alle Jobs im Tessin ansehen',
 officialSourceLabel: 'Offizielle Kantonsquelle',
 explainerTitle: 'So lesen Sie Amtsblatt-Stellen im Tessin',
 explainerCards: [
 {
 title: 'Offentliche Ausschreibungen',
 body: 'Das sind formelle Verfahren fur offentliche Stellen oder Verwaltungen. Sie enthalten meist feste Fristen, Pflichtdokumente und klar definierte Bewerbungsregeln.',
 },
 {
 title: 'Aggregiertes Job Board',
 body: 'Unser Job Board kombiniert private Arbeitgeber, offentliche Einrichtungen und offizielle Ausschreibungen an einem Ort, damit Sie Angebote schneller vergleichen konnen.',
 },
 {
 title: 'Offizielle Quellen',
 body: 'Offizielle Quellen wie concorsi.ti.ch bleiben massgeblich fur Volltext, Anhange und die endgultigen Bewerbungsregeln. Wir machen sie leichter auffindbar.',
 },
 ],
 internalLinks: ['Neueste offentliche Ausschreibungen', 'Alle Jobs im Tessin'],
 faq: [
 {
 question: 'Was ist der Unterschied zwischen Amtsblatt und Job Board?',
 answer: 'Im Amtsblatt erscheinen offentliche Ausschreibungen und institutionelle Stellen. Das Job Board von Frontaliere Ticino umfasst zusatzlich private Arbeitgeber.',
 },
 {
 question: 'Ersetzt diese Seite die offizielle Quelle?',
 answer: 'Nein. Die offizielle Quelle bleibt massgeblich fur den vollstandigen Text, die Unterlagen und den finalen Bewerbungsprozess.',
 },
 {
 question: 'Sind hier nur offentliche Stellen enthalten?',
 answer: 'Diese Seite fokussiert sich auf offentliche Ausschreibungen und Stellen aus offiziellen kantonalen Quellen.',
 },
 ],
 },
 fr: {
 title: "Feuille officielle emplois Tessin | Concours publics",
 heading: "Emplois de la Feuille officielle au Tessin",
 description: (count) => `Consultez ${count} concours publics et offres de sources officielles du Tessin indexes par Frontaliere Ticino, avec explication concours, job board et sources.`,
 intro: "Cette page vous aide a distinguer les concours publics, notre job board plus large et les sources officielles cantonales. Elle se concentre sur les offres publiques deja indexees depuis des sources officielles comme concorsi.ti.ch.",
 updatedLabel: 'Mis a jour',
 countsLabel: 'concours publics indexes',
 feedLabel: "Concours publics et offres de la Feuille officielle",
 latestLabel: 'Nouveaux concours publics des 3 derniers jours',
 openAll: 'Voir toutes les offres au Tessin',
 officialSourceLabel: 'Source officielle cantonale',
 explainerTitle: "Comment lire les offres de la Feuille officielle au Tessin",
 explainerCards: [
 {
 title: 'Concours publics',
 body: "Il s'agit d'ouvertures formelles pour des administrations ou organismes publics. Elles comportent souvent des delais stricts, des documents obligatoires et une procedure precise.",
 },
 {
 title: 'Job board agrege',
 body: "Notre job board regroupe entreprises privees, institutions publiques et concours officiels au meme endroit pour comparer les opportunites plus vite.",
 },
 {
 title: 'Sources officielles',
 body: 'Les sources officielles comme concorsi.ti.ch restent la reference pour le texte complet, les pieces jointes et les regles finales de candidature. Nous les rendons plus faciles a trouver.',
 },
 ],
 internalLinks: ['Derniers concours publics', 'Toutes les offres au Tessin'],
 faq: [
 {
 question: "Quelle difference entre la Feuille officielle et un job board ?",
 answer: "La Feuille officielle publie des concours publics et des offres institutionnelles. Le job board de Frontaliere Ticino inclut aussi des offres d'entreprises privees.",
 },
 {
 question: 'Cette page remplace-t-elle la source officielle ?',
 answer: "Non. La source officielle reste la reference pour le texte integral du concours, les documents demandes et la procedure finale de candidature.",
 },
 {
 question: 'Cette page contient-elle seulement des offres publiques ?',
 answer: 'Cette page se concentre sur les concours publics et les offres indexees depuis des sources cantonales officielles.',
 },
 ],
 },
};

function makeNursesHubCopy(cantonCode: string): Record<JobLandingLocale, {
 title: string;
 heading: string;
 description: (count: number) => string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 feedLabel: string;
 latestLabel: string;
 variantTitle: string;
 explainerCards: Array<{ title: string; body: string }>;
 faq: Array<{ question: string; answer: string }>;
 openAll: string;
}> {
 const cd = CANTON_DISPLAY_LOCALE[cantonCode] || CANTON_DISPLAY_LOCALE['TI'];
 return {
 it: {
 title: `Infermieri in ${cd.it} | Cliniche, case anziani e OSS`,
 heading: `Infermieri e sanita in ${cd.it}`,
 description: (count) => `Scopri ${count} offerte per infermieri, OSS, educatori e ruoli nelle cliniche o case anziani in ${cd.it}, con pagine dedicate ai cluster che convertono meglio.`,
 intro: `Questo hub raccoglie i lavori sanita e care che intercettano piu domanda: infermieri, OSS, educatori, cliniche private e case anziani. Serve per trovare piu velocemente le opportunita davvero vicine al tuo profilo.`,
 updatedLabel: 'Aggiornamento',
 countsLabel: 'offerte sanita e care',
 feedLabel: `Offerte per infermieri e sanita in ${cd.it}`,
 latestLabel: 'Nuove offerte sanita negli ultimi 3 giorni',
 variantTitle: 'Percorsi piu cercati nel cluster sanita',
 explainerCards: [
 { title: 'Cliniche', body: 'Ruoli in cliniche private, ospedali e strutture sanitarie dove il volume di candidature e alto ma la domanda resta costante.' },
 { title: 'Case anziani', body: 'Annunci in RSA, geriatria, strutture assistenziali e cure a lungo termine, utili per chi cerca continuita e turni stabili.' },
 { title: 'OSS ed educatori', body: 'Sottocluster ad alta conversione per operatori sociosanitari, socioassistenziali ed educatori attivi in scuole, centri e strutture sociali.' },
 ],
 faq: [
 { question: 'Qui trovo solo infermieri?', answer: `No. L hub include anche OSS, educatori, case anziani e cliniche, cioe i cluster care che generano piu interesse e candidature in ${cd.it}.` },
 { question: 'Le offerte arrivano da strutture pubbliche e private?', answer: 'Si. Il feed include annunci da ospedali, cliniche, enti pubblici, case anziani e altri datori di lavoro gia indicizzati nel nostro job board.' },
 { question: 'Come conviene usare questa pagina?', answer: 'Parti dal cluster piu vicino al tuo profilo, poi apri le pagine dedicate per affinare la ricerca tra cliniche, case anziani, OSS o educatori.' },
 ],
 openAll: `Vedi tutte le offerte in ${cd.it}`,
 },
 en: {
 title: `Nurses in ${cd.en} | Clinics, care homes and OSS`,
 heading: `Nurses and healthcare jobs in ${cd.en}`,
 description: (count) => `Browse ${count} nursing, healthcare assistant, educator and clinic or care home jobs in ${cd.en}, with dedicated pages for top converting clusters.`,
 intro: 'This hub groups together the healthcare and care jobs that attract the strongest demand: nurses, healthcare assistants, educators, private clinics and care homes.',
 updatedLabel: 'Updated',
 countsLabel: 'healthcare and care jobs',
 feedLabel: `Nursing and healthcare jobs in ${cd.en}`,
 latestLabel: 'Newest healthcare jobs in the last 3 days',
 variantTitle: 'Most searched healthcare paths',
 explainerCards: [
 { title: 'Clinics', body: 'Roles in private clinics, hospitals and medical facilities where hiring demand stays consistently high.' },
 { title: 'Care homes', body: 'Openings in elderly care, geriatrics and long-term care facilities for candidates looking for stable healthcare roles.' },
 { title: 'Healthcare assistants and educators', body: 'High-intent subclusters for OSS-style roles, socio-assistance and educators active in care or social settings.' },
 ],
 faq: [
 { question: 'Does this hub only cover nurses?', answer: `No. It also includes healthcare assistants, educators, care-home roles and clinic jobs across ${cd.en}.` },
 { question: 'Are these jobs public or private?', answer: 'Both. The feed can include hospitals, clinics, public institutions, care homes and other employers already indexed in our job board.' },
 { question: 'How should I use this page?', answer: 'Start from the subcluster closest to your profile, then open the dedicated pages to narrow the search.' },
 ],
 openAll: `See all jobs in ${cd.en}`,
 },
 de: {
 title: `Pflege Jobs ${germanCantonPrep(cd.de)} | Kliniken & OSS`,
 heading: `Pflege- und Gesundheitsjobs ${germanCantonPrep(cd.de)}`,
 description: (count) => `Entdecken Sie ${count} Pflege-, OSS-, Erzieher- und Klinikstellen ${germanCantonPrep(cd.de)}, mit eigenen Seiten fur die relevantesten Cluster.`,
 intro: 'Dieser Hub bundelt die Gesundheits- und Care-Jobs mit hoher Nachfrage: Pflege, Betreuung, Erziehung, Kliniken und Altersheime.',
 updatedLabel: 'Aktualisiert',
 countsLabel: 'Pflege- und Care-Jobs',
 feedLabel: `Pflege- und Gesundheitsjobs ${germanCantonPrep(cd.de)}`,
 latestLabel: 'Neue Gesundheitsjobs der letzten 3 Tage',
 variantTitle: 'Meistgesuchte Wege im Gesundheitsbereich',
 explainerCards: [
 { title: 'Kliniken', body: 'Rollen in Privatkliniken, Spitalern und medizinischen Einrichtungen mit konstantem Bedarf.' },
 { title: 'Altersheime', body: 'Angebote in Geriatrie, Langzeitpflege und betreuten Einrichtungen fur Kandidaten mit Fokus auf Kontinuitat.' },
 { title: 'OSS und Erzieher', body: 'Wichtige Untercluster fur sozio-sanitarische Assistenz und padagogische Rollen in sozialen Strukturen.' },
 ],
 faq: [
 { question: 'Geht es hier nur um Pflegefachpersonen?', answer: `Nein. Der Hub umfasst auch OSS-nahe Rollen, Erzieher, Altersheime und Kliniken ${germanCantonPrep(cd.de)}.` },
 { question: 'Sind die Stellen offentlich oder privat?', answer: 'Beides. Der Feed kann Stellen aus Kliniken, Spitalern, offentlichen Einrichtungen und Pflegeheimen enthalten.' },
 { question: 'Wie nutzt man diese Seite am besten?', answer: 'Starten Sie mit dem passendsten Untercluster und gehen Sie dann in die jeweilige Spezialseite.' },
 ],
 openAll: `Alle Jobs ${germanCantonPrep(cd.de)} ansehen`,
 },
 fr: {
 title: `Infirmiers ${frenchCantonPrep(cd.fr)} | Cliniques & EMS`,
 heading: `Infirmiers et sante ${frenchCantonPrep(cd.fr)}`,
 description: (count) => `Consultez ${count} offres infirmiers, OSS, educateurs et cliniques ou EMS ${frenchCantonPrep(cd.fr)}, avec pages dediees aux sous-clusters performants.`,
 intro: `Ce hub regroupe les offres sante et care qui attirent le plus de demande: infirmiers, OSS, educateurs, cliniques privees et maisons de retraite.`,
 updatedLabel: 'Mis a jour',
 countsLabel: 'offres sante et care',
 feedLabel: `Offres infirmiers et sante ${frenchCantonPrep(cd.fr)}`,
 latestLabel: 'Nouvelles offres sante des 3 derniers jours',
 variantTitle: 'Parcours les plus recherches en sante',
 explainerCards: [
 { title: 'Cliniques', body: 'Postes en cliniques privees, hopitaux et structures medicales ou la demande reste constante.' },
 { title: 'Maisons de retraite', body: 'Offres en geriatrie, soins de longue duree et structures medico-sociales pour des profils cherchant de la stabilite.' },
 { title: 'OSS et educateurs', body: 'Sous-clusters a forte intention pour les roles socio-sanitaires, socio-educatifs et pedagogiques.' },
 ],
 faq: [
 { question: 'Ce hub parle-t-il seulement des infirmiers ?', answer: `Non. Il inclut aussi les OSS, les educateurs, les maisons de retraite et les cliniques ${frenchCantonPrep(cd.fr)}.` },
 { question: 'Les offres viennent-elles du public et du prive ?', answer: 'Oui. Le feed peut inclure hopitaux, cliniques, institutions publiques, EMS et autres employeurs deja indexes.' },
 { question: 'Comment utiliser cette page ?', answer: 'Commencez par le sous-cluster le plus proche de votre profil puis ouvrez la page dediee pour affiner la recherche.' },
 ],
 openAll: `Voir toutes les offres ${frenchCantonPrep(cd.fr)}`,
 },
 };
}

const NURSES_HUB_COPY = makeNursesHubCopy('TI');

// Phase 8 sub-PR (d): TI/GR/VS retain legacy form `cliniche-ticino` (canton
// embedded in slug) for URL invariance — those URLs are locked by tests and
// by the production index. For the other 21 cantons, the slug collapses to
// the short form (e.g. `cliniche`) because the canton is already encoded in
// Phase 8d revert (2026-05-18): every canton now suffixes its display
// slug onto the care-cluster base (e.g. `cliniche-basilea`,
// `nurses-in-basel-jobs`) for keyword-rich URLs across the cathedral.
// TI/GR/VS continue to use the legacy slugs (canton + `-jobs` suffix in
// EN/DE) which are byte-identical because the template below resolves to
// the same string for those three. The pre-revert short form (`cliniche`,
// `clinics`, `kliniken`, `cliniques`) is kept as a legacy alias in
// LEGACY_SHORT_FORM_SLUGS_BY_SLOT so previously-emitted URLs continue to
// resolve via the canton-orphan-redirects plugin.
export function careClusterSlug(key: JobCareClusterKey, cantonCode: string, locale: JobLandingLocale): string {
 const base: Record<JobCareClusterKey, Record<JobLandingLocale, string>> = {
 clinics: { it: 'cliniche', en: 'clinics', de: 'kliniken', fr: 'cliniques' },
 careHomes: { it: 'case-anziani', en: 'care-homes', de: 'altersheime', fr: 'maisons-retraite' },
 oss: { it: 'oss', en: 'healthcare-assistants', de: 'pflegeassistenz', fr: 'oss' },
 educators: { it: 'educatori', en: 'educators', de: 'paedagogen', fr: 'educateurs' },
 };
 const cantonSlug = CANTON_SLUG_LOCALE[cantonCode]?.[locale] || CANTON_SLUG_LOCALE['TI'][locale];
 return `${base[key][locale]}-${cantonSlug}${locale === 'en' || locale === 'de' ? '-jobs' : ''}`;
}

function careClusterLabel(key: JobCareClusterKey, cantonCode: string, locale: JobLandingLocale): string {
 const cd = CANTON_DISPLAY_LOCALE[cantonCode]?.[locale] || CANTON_DISPLAY_LOCALE['TI'][locale];
 const base: Record<JobCareClusterKey, Record<JobLandingLocale, string>> = {
 clinics: { it: `Cliniche in ${cd}`, en: `Clinics in ${cd}`, de: `Kliniken ${germanCantonPrep(cd)}`, fr: `Cliniques ${frenchCantonPrep(cd)}` },
 careHomes: { it: `Case anziani in ${cd}`, en: `Care homes in ${cd}`, de: `Altersheime ${germanCantonPrep(cd)}`, fr: `Maisons de retraite ${frenchCantonPrep(cd)}` },
 oss: { it: `OSS in ${cd}`, en: `Healthcare assistants in ${cd}`, de: `Pflegeassistenz ${germanCantonPrep(cd)}`, fr: `OSS ${frenchCantonPrep(cd)}` },
 educators: { it: `Educatori in ${cd}`, en: `Educators in ${cd}`, de: `Padagogen ${germanCantonPrep(cd)}`, fr: `Educateurs ${frenchCantonPrep(cd)}` },
 };
 return base[key][locale];
}

const CARE_CLUSTER_DEFS: Record<JobCareClusterKey, {
 slug: Record<JobLandingLocale, string>;
 label: Record<JobLandingLocale, string>;
 matcher: (job: JobLike) => boolean;
}> = {
 clinics: {
 slug: { it: careClusterSlug('clinics', 'TI', 'it'), en: careClusterSlug('clinics', 'TI', 'en'), de: careClusterSlug('clinics', 'TI', 'de'), fr: careClusterSlug('clinics', 'TI', 'fr') },
 label: { it: careClusterLabel('clinics', 'TI', 'it'), en: careClusterLabel('clinics', 'TI', 'en'), de: careClusterLabel('clinics', 'TI', 'de'), fr: careClusterLabel('clinics', 'TI', 'fr') },
 matcher: (job) => {
 const titleText = normalizeSpace(`${job.title || ''}`);
 const contextText = normalizeSpace(`${job.title || ''} ${job.description || ''}`);
 return HEALTHCARE_TITLE_ROLE_REGEX.test(titleText) && /\b(clinic|clinica|cliniche|hospital|ospedal|medical center|medizin)\b/i.test(contextText);
 },
 },
 careHomes: {
 slug: { it: careClusterSlug('careHomes', 'TI', 'it'), en: careClusterSlug('careHomes', 'TI', 'en'), de: careClusterSlug('careHomes', 'TI', 'de'), fr: careClusterSlug('careHomes', 'TI', 'fr') },
 label: { it: careClusterLabel('careHomes', 'TI', 'it'), en: careClusterLabel('careHomes', 'TI', 'en'), de: careClusterLabel('careHomes', 'TI', 'de'), fr: careClusterLabel('careHomes', 'TI', 'fr') },
 matcher: (job) => {
 const titleText = normalizeSpace(`${job.title || ''}`);
 const contextText = normalizeSpace(`${job.title || ''} ${job.description || ''}`);
 return HEALTHCARE_TITLE_ROLE_REGEX.test(titleText) && /\b(casa anziani|case anziani|geriatria|geriatric|rsa\b|ems\b|elderly|long[-\s]?term care|senior living)\b/i.test(contextText);
 },
 },
 oss: {
 slug: { it: careClusterSlug('oss', 'TI', 'it'), en: careClusterSlug('oss', 'TI', 'en'), de: careClusterSlug('oss', 'TI', 'de'), fr: careClusterSlug('oss', 'TI', 'fr') },
 label: { it: careClusterLabel('oss', 'TI', 'it'), en: careClusterLabel('oss', 'TI', 'en'), de: careClusterLabel('oss', 'TI', 'de'), fr: careClusterLabel('oss', 'TI', 'fr') },
 matcher: (job) => /\b(oss\b|operatore socio|operatrice socio|socioassist|socioassistenziale|healthcare assistant|pflegeassist|assistente di cura|addetto alle cure)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 educators: {
 slug: { it: careClusterSlug('educators', 'TI', 'it'), en: careClusterSlug('educators', 'TI', 'en'), de: careClusterSlug('educators', 'TI', 'de'), fr: careClusterSlug('educators', 'TI', 'fr') },
 label: { it: careClusterLabel('educators', 'TI', 'it'), en: careClusterLabel('educators', 'TI', 'en'), de: careClusterLabel('educators', 'TI', 'de'), fr: careClusterLabel('educators', 'TI', 'fr') },
 matcher: (job) => /\b(educator|educatrice|educatore|educatori|pedagog|socioeduc|social care worker|leisure management)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
};

const HEALTHCARE_TITLE_ROLE_REGEX = /\b(nurse|infermier\w*|midwife|ostetric\w*|caregiver|oss\b|operatore socio\w*|operatrice socio\w*|socioassist\w*|assistente di cura|assistente di studio medico|medical assistant|assistant medical|dietist\w*|therap\w*|physio\w*|ergoterap\w*|educator\w*|educatric\w*|educatori|educatore|educatori|socioeduc\w*|social care|geriatri\w*|spitex|medic\w*|sanitar\w*)\b/i;
const LOCATION_COPY: Record<JobLandingLocale, {
 heading: (location: string) => string;
 title: (location: string) => string;
 description: (location: string, count: number) => string;
 intro: (location: string) => string;
 countsLabel: string;
 updatedLabel: string;
 feedLabel: (location: string) => string;
 latestLabel: (location: string) => string;
 openAll: string;
}> = {
 it: {
 heading: (location) => `Lavoro a ${location} in Ticino`,
 title: (location) => `Offerte di lavoro a ${location} in Ticino | Lavoro ${location} aggiornato`,
 description: (location, count) => `Scopri ${count} offerte di lavoro a ${location} in Ticino con annunci aggiornati, aziende che assumono, nuovi annunci degli ultimi 3 giorni e link alle candidature.`,
 intro: (location) => `Questa pagina raccoglie in un solo punto gli annunci con sede a ${location}, cosi puoi capire subito quali aziende stanno assumendo davvero in citta e quali profili compaiono piu spesso.`,
 countsLabel: 'annunci attivi in citta',
 updatedLabel: 'Aggiornamento',
 feedLabel: (location) => `Offerte attive a ${location}`,
 latestLabel: (location) => `Nuovi annunci a ${location} negli ultimi 3 giorni`,
 openAll: 'Vedi tutte le offerte in Ticino',
 },
 en: {
 heading: (location) => `Jobs in ${location}, Ticino`,
 title: (location) => `Jobs in ${location}, Ticino | Updated job listings and employers`,
 description: (location, count) => `Browse ${count} jobs in ${location}, Ticino, with updated job listings, active employers, roles from the last 3 days and direct links to the original application pages.`,
 intro: (location) => `This page groups together jobs based in ${location}, so you can quickly see which employers are hiring locally and which roles appear most often.`,
 countsLabel: 'active local jobs',
 updatedLabel: 'Updated',
 feedLabel: (location) => `Active jobs in ${location}`,
 latestLabel: (location) => `New jobs in ${location} over the last 3 days`,
 openAll: 'See all jobs in Ticino',
 },
 de: {
 heading: (location) => `Jobs in ${location}, Tessin`,
 title: (location) => `Jobs in ${location}, Tessin | Aktuelle Stellenangebote und Arbeitgeber`,
 description: (location, count) => `Entdecken Sie ${count} Jobs in ${location} im Tessin mit aktuellen Angeboten, aktiven Arbeitgebern, neuen Inseraten der letzten 3 Tage und Bewerbungslinks.`,
 intro: (location) => `Diese Seite bundelt Stellen mit Arbeitsort ${location}, damit Sie sofort sehen, welche Arbeitgeber vor Ort einstellen und welche Profile besonders gefragt sind.`,
 countsLabel: 'aktive lokale Jobs',
 updatedLabel: 'Aktualisiert',
 feedLabel: (location) => `Aktive Jobs in ${location}`,
 latestLabel: (location) => `Neue Jobs in ${location} in den letzten 3 Tagen`,
 openAll: 'Alle Jobs im Tessin ansehen',
 },
 fr: {
 heading: (location) => `Emploi a ${location}, Tessin`,
 title: (location) => `Offres d'emploi a ${location}, Tessin | Emploi local a jour`,
 description: (location, count) => `Consultez ${count} offres d'emploi a ${location} au Tessin avec annonces a jour, employeurs actifs, offres des 3 derniers jours et liens vers la candidature.`,
 intro: (location) => `Cette page regroupe les offres basees a ${location} afin de voir rapidement quelles entreprises recrutent localement et quels profils reviennent le plus souvent.`,
 countsLabel: 'offres locales actives',
 updatedLabel: 'Mis a jour',
 feedLabel: (location) => `Offres actives a ${location}`,
 latestLabel: (location) => `Nouvelles offres a ${location} sur 3 jours`,
 openAll: 'Voir toutes les offres au Tessin',
 },
};

const LOCATION_TYPE_COPY: Record<JobLandingLocale, {
 heading: (label: string, location: string) => string;
 title: (label: string, location: string) => string;
 description: (label: string, location: string, count: number) => string;
 intro: (label: string, location: string) => string;
 countsLabel: string;
 updatedLabel: string;
 feedLabel: (label: string, location: string) => string;
 latestLabel: (label: string, location: string) => string;
 openAll: string;
}> = {
 it: {
 heading: (label, location) => `${label} a ${location} in Ticino`,
 title: (label, location) => `${label} a ${location} in Ticino | Offerte di lavoro aggiornate`,
 description: (label, location, count) => `Scopri ${count} offerte di ${label.toLowerCase()} a ${location} in Ticino, con annunci aggiornati, nuovi inserimenti degli ultimi 3 giorni e link diretti alle candidature ufficiali.`,
 intro: (label, location) => `Questa pagina raccoglie le offerte di ${label.toLowerCase()} con sede a ${location}, utile per chi cerca un ingresso nel mercato locale o un percorso piu compatibile con studio e formazione.`,
 countsLabel: 'annunci attivi',
 updatedLabel: 'Aggiornamento',
 feedLabel: (label, location) => `Offerte di ${label.toLowerCase()} a ${location}`,
 latestLabel: (label, location) => `Nuovi ${label.toLowerCase()} a ${location} negli ultimi 3 giorni`,
 openAll: 'Vedi tutte le offerte in Ticino',
 },
 en: {
 heading: (label, location) => `${label} jobs in ${location}, Ticino`,
 title: (label, location) => `${label} jobs in ${location}, Ticino | Updated job offers`,
 description: (label, location, count) => `Browse ${count} ${label.toLowerCase()} jobs in ${location}, Ticino, with updated job listings, roles from the last 3 days and direct links to official applications.`,
 intro: (label, location) => `This page focuses on ${label.toLowerCase()} opportunities based in ${location}, useful if you want a more specific local job feed rather than a generic filtered list.`,
 countsLabel: 'active listings',
 updatedLabel: 'Updated',
 feedLabel: (label, location) => `${label} roles in ${location}`,
 latestLabel: (label, location) => `Newest ${label.toLowerCase()} jobs in ${location}`,
 openAll: 'See all jobs in Ticino',
 },
 de: {
 heading: (label, location) => `${label} in ${location}, Tessin`,
 title: (label, location) => `${label} in ${location}, Tessin | Aktuelle Jobangebote`,
 description: (label, location, count) => `Entdecken Sie ${count} Stellen fur ${label.toLowerCase()} in ${location} im Tessin mit aktuellen Stellenangeboten, Inseraten der letzten 3 Tage und direkten Links zur offiziellen Bewerbung.`,
 intro: (label, location) => `Diese Seite sammelt ${label.toLowerCase()}-Angebote mit Arbeitsort ${location} und bietet damit eine gezieltere lokale Auswahl statt nur einer gefilterten Liste.`,
 countsLabel: 'aktive Inserate',
 updatedLabel: 'Aktualisiert',
 feedLabel: (label, location) => `${label}-Jobs in ${location}`,
 latestLabel: (label, location) => `Neueste ${label.toLowerCase()} in ${location}`,
 openAll: 'Alle Jobs im Tessin ansehen',
 },
 fr: {
 heading: (label, location) => `${label} a ${location}, Tessin`,
 title: (label, location) => `${label} a ${location}, Tessin | Offres d'emploi a jour`,
 description: (label, location, count) => `Consultez ${count} offres de ${label.toLowerCase()} a ${location} au Tessin, avec annonces a jour, nouvelles offres des 3 derniers jours et liens directs vers la candidature officielle.`,
 intro: (label, location) => `Cette page regroupe les offres de ${label.toLowerCase()} basees a ${location}, afin d'offrir un flux local plus utile qu'une simple liste filtree.`,
 countsLabel: 'offres actives',
 updatedLabel: 'Mis a jour',
 feedLabel: (label, location) => `Offres ${label.toLowerCase()} a ${location}`,
 latestLabel: (label, location) => `Nouveaux ${label.toLowerCase()} a ${location}`,
 openAll: 'Voir toutes les offres au Tessin',
 },
};

const LOCATION_SECTOR_COPY: Record<JobLandingLocale, {
 heading: (label: string, location: string) => string;
 title: (label: string, location: string) => string;
 description: (label: string, location: string, count: number) => string;
 intro: (label: string, location: string) => string;
 countsLabel: string;
 updatedLabel: string;
 feedLabel: (label: string, location: string) => string;
 latestLabel: (label: string, location: string) => string;
 openAll: string;
}> = {
 it: {
 heading: (label, location) => `${label} a ${location} in Ticino`,
 title: (label, location) => `${label} a ${location} in Ticino | Offerte di lavoro aggiornate`,
 description: (label, location, count) => `Scopri ${count} offerte ${label.toLowerCase()} a ${location} in Ticino con aziende attive, annunci aggiornati, nuovi inserimenti degli ultimi 3 giorni e link alle candidature.`,
 intro: (label, location) => `Questa pagina raccoglie le offerte di ${label.toLowerCase()} con sede a ${location}, utile per capire subito quali aziende cercano profili di questo settore nella zona.`,
 countsLabel: 'annunci attivi',
 updatedLabel: 'Aggiornamento',
 feedLabel: (label, location) => `${label} attivi a ${location}`,
 latestLabel: (label, location) => `Nuovi annunci ${label.toLowerCase()} a ${location}`,
 openAll: 'Vedi tutte le offerte in Ticino',
 },
 en: {
 heading: (label, location) => `${label} jobs in ${location}, Ticino`,
 title: (label, location) => `${label} jobs in ${location}, Ticino | Updated job offers`,
 description: (label, location, count) => `Browse ${count} ${label.toLowerCase()} jobs in ${location}, Ticino, with active employers, fresh job listings, roles from the last 3 days and direct links to official application pages.`,
 intro: (label, location) => `This page groups ${label.toLowerCase()} opportunities based in ${location}, so you can focus on a local sector instead of a generic listing.`,
 countsLabel: 'active listings',
 updatedLabel: 'Updated',
 feedLabel: (label, location) => `${label} jobs in ${location}`,
 latestLabel: (label, location) => `Newest ${label.toLowerCase()} jobs in ${location}`,
 openAll: 'See all jobs in Ticino',
 },
 de: {
 heading: (label, location) => `${label} in ${location}, Tessin`,
 title: (label, location) => `${label} in ${location}, Tessin | Aktuelle Jobangebote`,
 description: (label, location, count) => `Entdecken Sie ${count} ${label.toLowerCase()}-Stellen in ${location} im Tessin mit aktiven Arbeitgebern, aktuellen Angeboten und direkten Bewerbungslinks.`,
 intro: (label, location) => `Diese Seite bundelt ${label.toLowerCase()}-Stellen mit Arbeitsort ${location}, damit Sie einen lokalen Sektor gezielt durchsuchen konnen.`,
 countsLabel: 'aktive Inserate',
 updatedLabel: 'Aktualisiert',
 feedLabel: (label, location) => `${label} in ${location}`,
 latestLabel: (label, location) => `Neueste ${label.toLowerCase()} in ${location}`,
 openAll: 'Alle Jobs im Tessin ansehen',
 },
 fr: {
 heading: (label, location) => `${label} a ${location}, Tessin`,
 title: (label, location) => `${label} a ${location}, Tessin | Offres d'emploi a jour`,
 description: (label, location, count) => `Consultez ${count} offres ${label.toLowerCase()} a ${location} au Tessin avec employeurs actifs, annonces a jour et liens directs vers la candidature.`,
 intro: (label, location) => `Cette page rassemble les offres de ${label.toLowerCase()} basees a ${location}, afin de suivre un secteur local de maniere plus utile qu'une liste generaliste.`,
 countsLabel: 'offres actives',
 updatedLabel: 'Mis a jour',
 feedLabel: (label, location) => `${label} a ${location}`,
 latestLabel: (label, location) => `Nouvelles offres ${label.toLowerCase()} a ${location}`,
 openAll: 'Voir toutes les offres au Tessin',
 },
};

const JOB_TYPE_DEFS: Record<JobLandingTypeKey, {
 slug: Record<JobLandingLocale, string>;
 label: Record<JobLandingLocale, string>;
 matcher: (job: JobLike) => boolean;
}> = {
 apprenticeship: {
 slug: { it: 'apprendistato', en: 'apprenticeship', de: 'lehrstelle', fr: 'apprentissage' },
 label: { it: 'Apprendistati', en: 'Apprenticeship', de: 'Lehrstellen', fr: 'Apprentissage' },
 matcher: (job) => /apprendist|apprenticeship|apprentissage|lehrstell|lernende|ausbildung/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 internship: {
 slug: { it: 'stage', en: 'internship', de: 'praktikum', fr: 'stage' },
 label: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' },
 matcher: (job) => /stage|internship|stagiaire|praktikum|intern\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''} ${job.contract || ''}`)),
 },
 partTime: {
 slug: { it: 'part-time', en: 'part-time', de: 'teilzeit', fr: 'temps-partiel' },
 label: { it: 'Part-time', en: 'Part-time', de: 'Teilzeit', fr: 'Temps partiel' },
 matcher: (job) => isPartTime(job),
 },
};

const JOB_SECTOR_DEFS: Record<JobLandingSectorKey, {
 slug: Record<JobLandingLocale, string>;
 label: Record<JobLandingLocale, string>;
 matcher: (job: JobLike) => boolean;
}> = {
 health: {
 slug: { it: 'sanita', en: 'health', de: 'gesundheit', fr: 'sante' },
 label: { it: 'Sanita', en: 'Health', de: 'Gesundheit', fr: 'Sante' },
 matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'health' || /\b(nurse|infermier|caregiver|oss|socioassist|health|clinic|clinica|hospital|ospedal|spitex)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 finance: {
 slug: { it: 'finanza', en: 'finance', de: 'finanzen', fr: 'finance' },
 label: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
 matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'finance' || /\b(finance|financial|bank|banking|payroll|tax|accounting|contabil|private banker|treasury)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 tech: {
 slug: { it: 'tecnologia', en: 'tech', de: 'technik', fr: 'tech' },
 label: { it: 'Tecnologia', en: 'Tech', de: 'Technik', fr: 'Tech' },
 matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'tech' || /\b(software|developer|engineer|it\b|data|frontend|backend|devops|cloud|cyber|analytics)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 engineering: {
 slug: { it: 'ingegneria', en: 'engineering', de: 'ingenieurwesen', fr: 'ingenierie' },
 label: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingenierie' },
 matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'engineering' || /\b(engineer|mechanic|mechanical|electrical|elettric|production|impianti|construction|project manager)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 admin: {
 slug: { it: 'amministrazione', en: 'admin', de: 'verwaltung', fr: 'administration' },
 label: { it: 'Amministrazione', en: 'Admin', de: 'Verwaltung', fr: 'Administration' },
 matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'admin' || /\b(admin|office|back office|assistant|assistente|segretari|hr\b|human resources|customer service|contabile)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 hospitality: {
 slug: { it: 'ristorazione-hotel', en: 'hospitality', de: 'gastgewerbe', fr: 'hotellerie-restauration' },
 label: { it: 'Ristorazione e hotel', en: 'Hospitality', de: 'Gastgewerbe', fr: 'Hotellerie et restauration' },
 matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'hospitality' || /\b(hotel|restaurant|ristor|bar|kitchen|chef|manora|waiter|service)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
 sales: {
 slug: { it: 'vendite', en: 'sales', de: 'vertrieb', fr: 'vente' },
 label: { it: 'Vendite', en: 'Sales', de: 'Vertrieb', fr: 'Vente' },
 matcher: (job) => normalizeSpace(job.category || '').toLowerCase() === 'sales' || /\b(sales|vendit|retail|store|negozio|clientela|commerciale|business development)\b/i.test(normalizeSpace(`${job.title || ''} ${job.description || ''}`)),
 },
};

function normalizeSpace(value = ''): string {
 return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugifyTerm(value = ''): string {
 return normalizeSpace(value)
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, '-')
 .replace(/^-+|-+$/g, '')
 .slice(0, 200);
}

function ensureTrailingSlash(value: string): string {
 return value.endsWith('/') ? value : `${value}/`;
}

function isPartTime(job: JobLike): boolean {
 const raw = normalizeSpace(`${job.contract || ''} ${job.title || ''}`);
 if (!raw) return false;
 if (/(part[\s-]?time|tempo parziale|teilzeit|temps partiel)/i.test(raw)) return true;
 const pctMatches = raw.match(/(\d{1,3})\s*%/g) || [];
 return pctMatches.some((match) => {
 const pct = Number(match.replace(/[^0-9]/g, ''));
 return Number.isFinite(pct) && pct > 0 && pct < 100;
 });
}

function parseDate(value: string): Date | null {
 const raw = normalizeSpace(value);
 if (!raw) return null;
 const parsed = new Date(raw);
 return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getJobFreshnessDate(job: JobLike): Date | null {
 return parseDate(job.postedDate) || parseDate(job.datePosted) || parseDate(job.crawledAt) || parseDate(job.updatedAt);
}

function dayKey(date: Date): string {
 return date.toISOString().slice(0, 10);
}

function diffDays(a: Date, b: Date): number {
 const dayMs = 24 * 60 * 60 * 1000;
 const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
 const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
 return Math.floor((utcA - utcB) / dayMs);
}

function isInLast24Hours(jobDate: Date | null, now: Date): boolean {
 if (!jobDate) return false;
 const rawValue = now.getTime() - jobDate.getTime();
 if (rawValue <= 24 * 60 * 60 * 1000 && rawValue >= 0) return true;
 return dayKey(now) === dayKey(jobDate);
}

function isInLast3Days(jobDate: Date | null, now: Date): boolean {
 if (!jobDate) return false;
 const rawValue = now.getTime() - jobDate.getTime();
 if (rawValue <= 3 * 24 * 60 * 60 * 1000 && rawValue >= 0) return true;
 const calendarDiff = diffDays(now, jobDate);
 return calendarDiff >= 0 && calendarDiff <= 2;
}

// Canton scoping for per-canton editorial pages. Routes through
// resolveJobCanton so URL groups (BASILEA = BS+BL, APPENZELLO = AI+AR)
// match their member cantons, and jobs without an explicit `canton` field
// fall back to the location-derived canton (defaulting to TI). The previous
// `!canton || canton === cantonCode` check failed in two ways:
//   1. BASILEA matched zero jobs (BS/BL never equal "BASILEA")
//   2. Jobs with no canton field leaked into every canton's page
function isCantonScoped(job: JobLike, cantonCode: string): boolean {
 return resolveJobCanton(job) === cantonCode;
}

function isTicinoScoped(job: JobLike): boolean {
 return isCantonScoped(job, 'TI');
}

function isOfficialGazetteJob(job: JobLike): boolean {
 const source = normalizeSpace(`${job.companyDomain || ''} ${job.url || ''} ${job.company || ''}`).toLowerCase();
 return source.includes('concorsi.ti.ch') || source.includes('ti.ch/concorsi');
}

function buildSearchHref(baseUrl: string, localePrefix: string, sectionSlug: string, locale: JobLandingLocale, term: string): string {
 const searchSlug = `${SEARCH_ROUTE_PREFIX[locale]}-${slugifyTerm(term) || 'ticino'}`;
 return ensureTrailingSlash(`${baseUrl}${`${localePrefix}/${sectionSlug}/${searchSlug}`.replace(/\/+/g, '/')}`);
}

function buildJobHref(baseUrl: string, localePrefix: string, sectionSlug: string, slug: string): string {
 return ensureTrailingSlash(`${baseUrl}${`${localePrefix}/${sectionSlug}/${slug}`.replace(/\/+/g, '/')}`);
}

function sortByFreshness(jobs: JobLike[], now: Date): JobLike[] {
 return [...jobs].sort((a, b) => {
 const aTime = getJobFreshnessDate(a)?.getTime() || 0;
 const bTime = getJobFreshnessDate(b)?.getTime() || 0;
 if (bTime !== aTime) return bTime - aTime;
 return normalizeSpace(a.title).localeCompare(normalizeSpace(b.title), 'it', { sensitivity: 'base' });
 });
}

/**
 * Strip from `latest` any entry whose href already appears in `primary`.
 *
 * Editorial location/type/sector landing pages render two job-tile lists:
 * - `feed.jobs` (capped at 18-30): all matching jobs, freshest first
 * - `latestJobs` (capped at 12-15): only jobs from the last 3 days
 *
 * Since `latestJobs` is built from the same `matches` array and sorted by
 * recency, when fewer than ~30 jobs match the city × sector slice (common
 * case for small cantons/sectors), the entire `latestJobs` slice duplicates
 * the head of `feed.jobs` — pushing rendered HTML over the 200 KB
 * page-weight gate without adding any new content for the user.
 *
 * Deduping at the model layer preserves both sections (and the structured-
 * data ItemList) while emitting each job-tile exactly once per page.
 *
 * @param latest Candidate "latest" entries (already capped + sorted by recency).
 * @param primary Entries already shown in the main feed.
 * @returns `latest` with any href present in `primary` removed.
 */
function dedupeAgainst(latest: LandingJobLink[], primary: LandingJobLink[]): LandingJobLink[] {
  if (latest.length === 0 || primary.length === 0) return latest;
  const seen = new Set(primary.map((j) => j.href));
  return latest.filter((j) => !seen.has(j.href));
}

function toLinkedJobs(jobs: JobLike[], now: Date, locale: JobLandingLocale, options: { baseUrl: string; localePrefix: string; sectionSlug: string; localizedSlug: (job: JobLike, locale: JobLandingLocale) => string }, max = 12): LandingJobLink[] {
 return sortByFreshness(jobs, now).slice(0, max).map((job) => {
  const j = job as Record<string, unknown>;
  const rawTitleByLocale =
   (j.titleByLocale as Record<string, unknown> | undefined) || {};
  // Normalize the title-by-locale dict so only string values survive into
  // the typed `Partial<Record<JobLandingLocale,string>>` shape.
  const titleByLocaleTyped = Object.fromEntries(
   Object.entries(rawTitleByLocale).filter(([, v]) => typeof v === 'string'),
  ) as Partial<Record<JobLandingLocale, string>>;
  const posted = getJobFreshnessDate(job as JobLike);
  const datePosted = posted
   ? posted.toISOString()
   : typeof j.postedDate === 'string'
    ? j.postedDate
    : typeof j.datePosted === 'string'
     ? j.datePosted
     : undefined;
  return {
   title: normalizeSpace(String(j.titleByLocale && typeof (j.titleByLocale as Record<string, unknown>)[locale] === 'string'
    ? (j.titleByLocale as Record<string, string>)[locale]
    : j.title || 'Offerta lavoro')),
   company: normalizeSpace(typeof j.company === 'string' ? j.company : ''),
   location: normalizeSpace(typeof j.location === 'string' ? j.location : ''),
   href: buildJobHref(options.baseUrl, options.localePrefix, options.sectionSlug, options.localizedSlug(job, locale)),
   datePosted,
   titleByLocale: titleByLocaleTyped,
   companyKey: typeof j.companyKey === 'string' ? j.companyKey : undefined,
   canton: typeof j.canton === 'string' ? j.canton : undefined,
   contract: typeof j.contract === 'string' ? j.contract : undefined,
   salaryMin: typeof j.salaryMin === 'number' ? j.salaryMin : undefined,
   salaryMax: typeof j.salaryMax === 'number' ? j.salaryMax : undefined,
   featured: j.featured === true,
   logo: typeof j.logo === 'string' ? j.logo : undefined,
   addressLocality:
    typeof j.addressLocality === 'string' ? j.addressLocality : undefined,
   companyDomain: typeof j.companyDomain === 'string' ? j.companyDomain : undefined,
   url: typeof j.url === 'string' ? j.url : undefined,
  };
 });
}

function normalizeLocation(value: string): string {
 const raw = normalizeSpace(value);
 const canonical = SUPPORTED_EDITORIAL_LOCATIONS.find((location) => location.toLowerCase() === raw.toLowerCase());
 return canonical || raw;
}

function getTypeDef(typeKey: JobLandingTypeKey) {
 return JOB_TYPE_DEFS[typeKey];
}

function getSectorDef(sectorKey: JobLandingSectorKey) {
 return JOB_SECTOR_DEFS[sectorKey];
}

function getCareClusterDef(clusterKey: JobCareClusterKey) {
 return CARE_CLUSTER_DEFS[clusterKey];
}

function findTypeKeyBySlug(slug: string): JobLandingTypeKey | null {
 const clean = normalizeSpace(slug);
 return (Object.keys(JOB_TYPE_DEFS) as JobLandingTypeKey[]).find((key) =>
 Object.values(JOB_TYPE_DEFS[key].slug).includes(clean),
 ) || null;
}

function findSectorKeyBySlug(slug: string): JobLandingSectorKey | null {
 const clean = normalizeSpace(slug);
 return (Object.keys(JOB_SECTOR_DEFS) as JobLandingSectorKey[]).find((key) =>
 Object.values(JOB_SECTOR_DEFS[key].slug).includes(clean),
 ) || null;
}

function findSectorKeyBySlugExtended(slug: string): JobLandingSectorKey | null {
 return findSectorKeyBySlug(slug) || SECTOR_SLUG_ALIASES[normalizeSpace(slug)] || null;
}

// Short-form (non-TI canton) care-cluster slugs — mapping locale slug → key.
// `clinics-it` short → `cliniche` (no canton suffix). For TI/GR/VS the slug
// keeps the canton suffix and is resolved via `CARE_CLUSTER_DEFS[key].slug`.
const CARE_CLUSTER_SHORT_SLUG_TO_KEY: Record<string, JobCareClusterKey> = {
 cliniche: 'clinics',
 clinics: 'clinics',
 kliniken: 'clinics',
 cliniques: 'clinics',
 'case-anziani': 'careHomes',
 'care-homes': 'careHomes',
 altersheime: 'careHomes',
 'maisons-retraite': 'careHomes',
 oss: 'oss',
 'healthcare-assistants': 'oss',
 pflegeassistenz: 'oss',
 educatori: 'educators',
 educators: 'educators',
 paedagogen: 'educators',
 educateurs: 'educators',
};

function findCareClusterKeyBySlug(slug: string): JobCareClusterKey | null {
 const clean = normalizeSpace(slug);
 // CARE_CLUSTER_DEFS is built from TI slugs only; check first for the
 // TI/GR/VS legacy long-form (kept byte-identical).
 const fromLegacy = (Object.keys(CARE_CLUSTER_DEFS) as JobCareClusterKey[]).find((key) =>
 Object.values(CARE_CLUSTER_DEFS[key].slug).includes(clean),
 );
 if (fromLegacy) return fromLegacy;
 // 2026-05-18: scan all 24 cantons × 4 locales for long-form per-canton
 // slugs (e.g. `cliniche-basilea`, `nurses-in-basel-jobs`). Without this
 // the router would mis-route them to the job-detail view.
 for (const key of Object.keys(CARE_CLUSTER_DEFS) as JobCareClusterKey[]) {
 for (const canton of Object.keys(CANTON_SLUG_LOCALE)) {
 for (const locale of ['it', 'en', 'de', 'fr'] as JobLandingLocale[]) {
 if (careClusterSlug(key, canton, locale) === clean) return key;
 }
 }
 }
 // Pre-2026-05-18 short-form aliases (`cliniche`, `clinics`, …).
 return CARE_CLUSTER_SHORT_SLUG_TO_KEY[clean] || null;
}

function matchesLocation(job: JobLike, location: string): boolean {
 return normalizeSpace(job.location || '').toLowerCase() === normalizeSpace(location).toLowerCase();
}

function buildLocationSlug(locale: JobLandingLocale, location: string): string {
 return `${SEARCH_ROUTE_PREFIX[locale]}-${slugifyTerm(location)}`;
}

function buildLocationTypeSlug(locale: JobLandingLocale, location: string, typeKey: JobLandingTypeKey): string {
 return `${buildLocationSlug(locale, location)}-${getTypeDef(typeKey).slug[locale]}`;
}

function buildLocationSectorSlug(locale: JobLandingLocale, location: string, sectorKey: JobLandingSectorKey): string {
 return `${buildLocationSlug(locale, location)}-${getSectorDef(sectorKey).slug[locale]}`;
}

/**
 * Pre-computed per-location job partitions, shared across the editorial
 * location/type/sector builders to avoid running `matchesLocation` (and its
 * `normalizeSpace().toLowerCase()` per job) on the full job array on every
 * call.
 *
 * Without this, each call to `buildLocation{Type,Sector}Links` ran a
 * full-array `matchesLocation` pass plus 3-7 nested type/sector filters,
 * and `buildJobLocation{Landing,Type,Sector}Model` repeated the same
 * `matchesLocation` filter once more — ~3 redundant full passes per
 * (location × locale) call.
 */
export interface LocationPartition {
 /** Canonical-location → all jobs that match `matchesLocation(job, location)`. */
 readonly byLocation: ReadonlyMap<string, readonly JobLike[]>;
 /** Canonical-location → typeKey → narrower subset matched by `typeDef.matcher`. */
 readonly byLocationType: ReadonlyMap<string, ReadonlyMap<JobLandingTypeKey, readonly JobLike[]>>;
 /** Canonical-location → sectorKey → narrower subset matched by `sectorDef.matcher`. */
 readonly byLocationSector: ReadonlyMap<string, ReadonlyMap<JobLandingSectorKey, readonly JobLike[]>>;
}

/**
 * Compute the per-location partition for the editorial section. Pass the
 * exact list of `locations` the editorial loops will use (typically the 5
 * editorial cities `editorialLocations`). Locations are normalized to the
 * canonical form via `normalizeLocation` before keying.
 */
export function partitionByLocation(
 jobs: readonly JobLike[],
 locations: readonly string[],
): LocationPartition {
 const byLocation = new Map<string, JobLike[]>();
 const byLocationType = new Map<string, Map<JobLandingTypeKey, JobLike[]>>();
 const byLocationSector = new Map<string, Map<JobLandingSectorKey, JobLike[]>>();
 const typeKeys = Object.keys(JOB_TYPE_DEFS) as JobLandingTypeKey[];
 const sectorKeys = Object.keys(JOB_SECTOR_DEFS) as JobLandingSectorKey[];
 for (const rawLocation of locations) {
 const location = normalizeLocation(rawLocation);
 if (byLocation.has(location)) continue;
 const locationJobs = jobs.filter((job) => matchesLocation(job, location));
 byLocation.set(location, locationJobs);
 const typeMap = new Map<JobLandingTypeKey, JobLike[]>();
 for (const typeKey of typeKeys) {
 const typeDef = getTypeDef(typeKey);
 typeMap.set(typeKey, locationJobs.filter((job) => typeDef.matcher(job)));
 }
 byLocationType.set(location, typeMap);
 const sectorMap = new Map<JobLandingSectorKey, JobLike[]>();
 for (const sectorKey of sectorKeys) {
 const sectorDef = getSectorDef(sectorKey);
 sectorMap.set(sectorKey, locationJobs.filter((job) => sectorDef.matcher(job)));
 }
 byLocationSector.set(location, sectorMap);
 }
 return { byLocation, byLocationType, byLocationSector };
}

function buildLocationTypeLinks(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 location: string;
 now: Date;
 baseUrl: string;
 localePrefix: string;
 sectionSlug: string;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 partition?: LocationPartition;
}): TypeLink[] {
 const partition = options.partition;
 const partitionMap = partition?.byLocationType.get(options.location);
 const locationJobs = partitionMap
 ? null
 : options.jobs.filter((job) => matchesLocation(job, options.location));
 return (Object.keys(JOB_TYPE_DEFS) as JobLandingTypeKey[])
 .map((typeKey) => {
 const typeDef = getTypeDef(typeKey);
 const count = partitionMap
 ? (partitionMap.get(typeKey)?.length ?? 0)
 : locationJobs!.filter((job) => typeDef.matcher(job)).length;
 return {
 key: typeKey,
 label: `${typeDef.label[options.locale]} a ${options.location}`,
 href: ensureTrailingSlash(`${options.baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationTypeSlug(options.locale, options.location, typeKey)}`.replace(/\/+/g, '/')}`),
 count,
 };
 })
 .filter((item) => item.count > 0)
 .sort((a, b) => b.count - a.count);
}

function buildLocationSectorLinks(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 location: string;
 now: Date;
 baseUrl: string;
 localePrefix: string;
 sectionSlug: string;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 partition?: LocationPartition;
}): SectorLink[] {
 const partition = options.partition;
 const partitionMap = partition?.byLocationSector.get(options.location);
 const locationJobs = partitionMap
 ? null
 : options.jobs.filter((job) => matchesLocation(job, options.location));
 return (Object.keys(JOB_SECTOR_DEFS) as JobLandingSectorKey[])
 .map((sectorKey) => {
 const sectorDef = getSectorDef(sectorKey);
 const count = partitionMap
 ? (partitionMap.get(sectorKey)?.length ?? 0)
 : locationJobs!.filter((job) => sectorDef.matcher(job)).length;
 return {
 key: sectorKey,
 label: `${sectorDef.label[options.locale]} a ${options.location}`,
 href: ensureTrailingSlash(`${options.baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationSectorSlug(options.locale, options.location, sectorKey)}`.replace(/\/+/g, '/')}`),
 count,
 };
 })
 .filter((item) => item.count > 0)
 .sort((a, b) => b.count - a.count);
}

// ── Recency-hub slug detection ───────────────────────────────────────
// Kept in this file (instead of jobRecencyLanding.ts) because the router
// resolver below needs it synchronously. The runtime model + copy live
// in jobRecencyLanding.ts to keep file sizes reasonable.
const RECENCY_SLUGS_BY_VARIANT: Record<'last-3-days' | 'since-yesterday', Record<JobLandingLocale, string>> = {
 'last-3-days': { it: 'ultimi-3-giorni', en: 'last-3-days', de: 'letzte-3-tage', fr: 'derniers-3-jours' },
 'since-yesterday': { it: 'da-ieri', en: 'since-yesterday', de: 'seit-gestern', fr: 'depuis-hier' },
};

function resolveRecencyDescriptor(slug: string): { kind: 'recency'; variant: 'last-3-days' | 'since-yesterday' } | null {
 const needle = slug.trim().toLowerCase();
 if (!needle) return null;
 for (const variant of Object.keys(RECENCY_SLUGS_BY_VARIANT) as Array<'last-3-days' | 'since-yesterday'>) {
  const map = RECENCY_SLUGS_BY_VARIANT[variant];
  for (const locale of Object.keys(map) as JobLandingLocale[]) {
   if (map[locale] === needle) return { kind: 'recency', variant };
  }
 }
 return null;
}

/**
 * Legacy short-form editorial slugs from the pre-2026-05-18 Phase-8d era,
 * when non-TI/GR/VS cantons used canton-less slugs (`infermieri`, `oggi`,
 * `cliniche`, …). These URLs were indexed by Google and may still appear
 * as inbound traffic / GSC orphan reports. The descriptor matcher returns
 * the same `kind` for them so the SPA router redirects to the canton's
 * new long-form canonical, and the canton-orphan-redirects plugin emits
 * a static HTML at the legacy path for the crawler.
 */
export const LEGACY_SHORT_FORM_SLUGS_BY_SLOT = {
 today: { it: 'oggi', en: 'today', de: 'heute', fr: 'aujourdhui' },
 nurses: { it: 'infermieri', en: 'nurses', de: 'pflege-jobs', fr: 'infirmiers' },
 partTime: { it: 'lavoro-part-time', en: 'part-time-jobs', de: 'teilzeit-jobs', fr: 'emploi-temps-partiel' },
 clinics: { it: 'cliniche', en: 'clinics', de: 'kliniken', fr: 'cliniques' },
 careHomes: { it: 'case-anziani', en: 'care-homes', de: 'altersheime', fr: 'maisons-retraite' },
 oss: { it: 'oss', en: 'healthcare-assistants', de: 'pflegeassistenz', fr: 'oss' },
 educators: { it: 'educatori', en: 'educators', de: 'paedagogen', fr: 'educateurs' },
} as const;

export function isJobTodayLandingSlug(value: string): boolean {
 const slug = normalizeSpace(value);
 for (const cantonSlugs of Object.values(JOB_TODAY_LANDING_SLUGS_BY_CANTON)) {
 if (Object.values(cantonSlugs).includes(slug as JobLandingLocale)) return true;
 }
 // Legacy short-form (pre-2026-05-18 Phase-8d-revert).
 if (Object.values(LEGACY_SHORT_FORM_SLUGS_BY_SLOT.today).includes(slug as never)) return true;
 return false;
}

export function resolveEditorialJobLandingDescriptor(value: string): EditorialLandingDescriptor | null {
 const slug = normalizeSpace(value);
 if (!slug) return null;
 // Recency hubs (last-3-days / since-yesterday) — checked first so their
 // slugs don't get mis-parsed as location pages.
 const recency = resolveRecencyDescriptor(slug);
 if (recency) return recency;
 if (isJobTodayLandingSlug(slug)) return { kind: 'today' };
 if (Object.values(JOB_OFFICIAL_GAZETTE_LANDING_SLUGS).includes(slug as (typeof JOB_OFFICIAL_GAZETTE_LANDING_SLUGS)[JobLandingLocale])) {
 return { kind: 'official-gazette' };
 }
 // Scan ALL canton variants for the nurses-hub and part-time slugs
 // (long-form per canton post-2026-05-18). The matcher also recognises
 // legacy short-form aliases (`infermieri`, `lavoro-part-time`, …) so
 // historical URLs continue to route through the SPA redirect → canton
 // canonical → static page.
 const nursesSlugSet = new Set<string>();
 for (const cantonSlugs of Object.values(JOB_NURSES_HUB_SLUGS_BY_CANTON)) {
 for (const localeSlug of Object.values(cantonSlugs)) nursesSlugSet.add(localeSlug);
 }
 for (const legacySlug of Object.values(LEGACY_SHORT_FORM_SLUGS_BY_SLOT.nurses)) nursesSlugSet.add(legacySlug);
 if (nursesSlugSet.has(slug) || slug === 'lavoro-infermieri') {
 return { kind: 'nurses-hub' };
 }
 const partTimeSlugSet = new Set<string>();
 for (const cantonSlugs of Object.values(JOB_PART_TIME_LANDING_SLUGS_BY_CANTON)) {
 for (const localeSlug of Object.values(cantonSlugs)) partTimeSlugSet.add(localeSlug);
 }
 for (const legacySlug of Object.values(LEGACY_SHORT_FORM_SLUGS_BY_SLOT.partTime)) partTimeSlugSet.add(legacySlug);
 if (partTimeSlugSet.has(slug)) {
 return { kind: 'part-time' };
 }
 const careClusterKey = findCareClusterKeyBySlug(slug);
 if (careClusterKey) return { kind: 'care-variant', clusterKey: careClusterKey };

 const parts = slug.split('-');
 if (parts.length < 2) return null;
 const prefixes = new Set(Object.values(SEARCH_ROUTE_PREFIX));
 if (!prefixes.has(parts[0])) return null;

 const locationPart = parts[1];
 const location = SUPPORTED_EDITORIAL_LOCATIONS.find((entry) => slugifyTerm(entry) === locationPart);
 if (!location) {
 // Try sector-region pattern: ricerca-{sector}-ticino / search-{sector}-ticino
 const REGION_SLUGS = new Set(
 Object.values(CANTON_SLUG_LOCALE).flatMap((localeMap) => Object.values(localeMap)),
 );
 const sectorSlug = parts.slice(1, -1).join('-'); // everything between prefix and last part
 const regionSlug = parts[parts.length - 1];
 if (parts.length >= 3 && REGION_SLUGS.has(regionSlug)) {
 const sectorKey = findSectorKeyBySlugExtended(sectorSlug);
 if (sectorKey) return { kind: 'sector-region', sectorKey };
 }
 // Also try entire suffix as sector (ricerca-sanita → sector without region)
 const fullSuffix = parts.slice(1).join('-');
 const directSectorKey = findSectorKeyBySlugExtended(fullSuffix);
 if (directSectorKey) return { kind: 'sector-region', sectorKey: directSectorKey };
 return null;
 }
 if (parts.length === 2) return { kind: 'location', location };

 const typeSlug = parts.slice(2).join('-');
 const typeKey = findTypeKeyBySlug(typeSlug);
 if (typeKey) return { kind: 'location-type', location, typeKey };
 const sectorKey = findSectorKeyBySlug(typeSlug);
 if (sectorKey) return { kind: 'location-sector', location, sectorKey };
 return null;
}

export function buildJobOfficialGazetteLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
}): JobOfficialGazetteLandingModel {
 const locale = options.locale;
 const copy = OFFICIAL_GAZETTE_COPY[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 const landingHref = ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${JOB_OFFICIAL_GAZETTE_LANDING_SLUGS[locale]}`.replace(/\/+/g, '/')}`);
 const officialJobs = options.jobs.filter((job) => isOfficialGazetteJob(job));
 const latestJobs = officialJobs.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const allJobsHref = ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}`.replace(/\/+/g, '/')}`);
 const feedJobs = toLinkedJobs(officialJobs, now, locale, { ...options, baseUrl }, 18);
 const latestJobsLinked = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12), feedJobs);
 return {
 kind: 'official-gazette',
 slug: JOB_OFFICIAL_GAZETTE_LANDING_SLUGS[locale],
 title: copy.title,
 heading: copy.heading,
 description: copy.description(officialJobs.length),
 intro: copy.intro,
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: officialJobs.length,
 feed: { label: copy.feedLabel, jobs: feedJobs },
 latestLabel: copy.latestLabel,
 latestJobs: latestJobsLinked,
 explainerTitle: copy.explainerTitle,
 explainerCards: copy.explainerCards,
 officialSourceLabel: copy.officialSourceLabel,
 officialSourceUrl: 'https://www.concorsi.ti.ch/',
 internalLinks: [
 { label: copy.internalLinks[0], href: `${landingHref}#official-competitions` },
 { label: copy.internalLinks[1], href: allJobsHref },
 ],
 faq: copy.faq,
 openAllLabel: copy.openAll,
 };
}

function isNursingHubJob(job: JobLike): boolean {
 return (Object.values(CARE_CLUSTER_DEFS) as Array<{ matcher: (job: JobLike) => boolean }>).some((cluster) => cluster.matcher(job));
}

/**
 * Pre-computed care-cluster job sets, shared across all
 * `buildJob{Nurses,CareVariant}LandingModel` calls in a single build to
 * avoid running the heavy `isNursingHubJob` regex matchers on the full job
 * array on every call.
 *
 * Without this, each builder ran 4 regex tests on the (title +
 * description ≈ 3 KB) of every one of ~2 500 jobs twice per call, and was
 * called ~60 times per build → ~85 s of pure regex evaluation. Computing
 * the partition once cuts that to a single ~700 ms scan.
 */
export interface CareClusterPartition {
 /** Every job whose title/description matches at least one care cluster. */
 readonly nursing: readonly JobLike[];
 /** Per-cluster narrowed subsets of `nursing`. */
 readonly byCluster: Readonly<Record<JobCareClusterKey, readonly JobLike[]>>;
}

/**
 * Run every care-cluster matcher on the input array exactly once and
 * return the resulting partition. Builders that accept an optional
 * `partition` parameter reuse this result and skip their internal filter
 * passes entirely.
 */
export function partitionCareClusters(jobs: readonly JobLike[]): CareClusterPartition {
 const nursing = jobs.filter((job) => isNursingHubJob(job));
 const clusterKeys = Object.keys(CARE_CLUSTER_DEFS) as JobCareClusterKey[];
 const byCluster = clusterKeys.reduce(
 (acc, key) => {
 const def = getCareClusterDef(key);
 acc[key] = nursing.filter((job) => def.matcher(job));
 return acc;
 },
 {} as Record<JobCareClusterKey, JobLike[]>,
 );
 return { nursing, byCluster };
}

function buildCareVariantLinks(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 now: Date;
 baseUrl: string;
 localePrefix: string;
 sectionSlug: string;
 partition?: CareClusterPartition;
 // Optional canton scope. When provided, sibling-variant counts are
 // restricted to jobs in that canton so badges on /cerca-lavoro-{canton}/
 // pages reflect that canton's supply, not Switzerland-wide totals.
 canton?: string;
}): CareVariantLink[] {
 const partition = options.partition;
 const nursingRaw: readonly JobLike[] = partition
 ? partition.nursing
 : options.jobs.filter((job) => isNursingHubJob(job));
 const nursing = options.canton
 ? nursingRaw.filter((job) => isCantonScoped(job, options.canton as string))
 : nursingRaw;
 return (Object.keys(CARE_CLUSTER_DEFS) as JobCareClusterKey[])
 .map((key) => {
 const def = getCareClusterDef(key);
 const count = options.canton
 ? nursing.filter((job) => def.matcher(job)).length
 : partition
   ? partition.byCluster[key].length
   : nursing.filter((job) => def.matcher(job)).length;
 return {
 key,
 label: def.label[options.locale],
 href: ensureTrailingSlash(`${options.baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${def.slug[options.locale]}`.replace(/\/+/g, '/')}`),
 count,
 };
 })
 .filter((item) => item.count > 0)
 .sort((a, b) => b.count - a.count);
}

export function buildJobNursesHubLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 canton?: string;
 /**
  * Optional pre-computed care-cluster partition (see `partitionCareClusters`).
  * When provided, skips the per-call full-array regex filter; builds with
  * identical input → byte-equivalent output.
  */
 partition?: CareClusterPartition;
}): JobNursesHubLandingModel {
 const locale = options.locale;
 const cantonCode = options.canton || 'TI';
 const copy = makeNursesHubCopy(cantonCode)[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 // Per-canton scoping: nurses-hub previously bypassed the canton filter so
 // every cathedral canton's `/cerca-lavoro-{canton}/infermieri/` page
 // surfaced all Swiss nursing jobs (mostly TI). When the caller supplies a
 // pre-computed partition we still need to narrow the nursing set to the
 // requested canton — the partition is canton-agnostic.
 const nursingPool: JobLike[] = options.partition
 ? [...options.partition.nursing]
 : options.jobs.filter((job) => isNursingHubJob(job));
 const matches: JobLike[] = nursingPool.filter((job) => isCantonScoped(job, cantonCode));
 const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const feedJobs = toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18);
 const latestJobsLinked = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12), feedJobs);
 return {
 kind: 'nurses-hub',
 slug: (JOB_NURSES_HUB_SLUGS_BY_CANTON[cantonCode] || JOB_NURSES_HUB_SLUGS)[locale],
 title: copy.title,
 heading: copy.heading,
 description: copy.description(matches.length),
 intro: copy.intro,
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: matches.length,
 feed: { label: copy.feedLabel, jobs: feedJobs },
 latestLabel: copy.latestLabel,
 latestJobs: latestJobsLinked,
 variantTitle: copy.variantTitle,
 variants: buildCareVariantLinks({ jobs: options.jobs, locale, now, baseUrl, localePrefix: options.localePrefix, sectionSlug: options.sectionSlug, partition: options.partition, canton: cantonCode }),
 explainerCards: copy.explainerCards,
 faq: copy.faq,
 openAllLabel: copy.openAll,
 };
}

export function buildJobCareVariantLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 clusterKey: JobCareClusterKey;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 canton?: string;
 /**
  * Optional pre-computed care-cluster partition (see `partitionCareClusters`).
  * When provided, skips the per-call full-array regex filter; builds with
  * identical input → byte-equivalent output.
  */
 partition?: CareClusterPartition;
}): JobCareVariantLandingModel {
 const locale = options.locale;
 const clusterKey = options.clusterKey;
 const cantonCode = options.canton || 'TI';
 const def = getCareClusterDef(clusterKey);
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 // Per-canton scoping: care-variant pages (clinics / care-homes / OSS /
 // educators) previously bypassed the canton filter so per-canton URLs
 // like /cerca-lavoro-basilea/cliniche-basilea/ listed clinic jobs from
 // across Switzerland. Narrow to the requested canton — the partition is
 // canton-agnostic, so the filter is applied in both branches.
 const matchesPool: JobLike[] = options.partition
 ? [...options.partition.byCluster[clusterKey]]
 : options.jobs.filter((job) => isNursingHubJob(job) && def.matcher(job));
 const matches: JobLike[] = matchesPool.filter((job) => isCantonScoped(job, cantonCode));
 const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const label = careClusterLabel(clusterKey, cantonCode, locale);
 const cd = CANTON_DISPLAY_LOCALE[cantonCode] || CANTON_DISPLAY_LOCALE['TI'];
 const isEducators = clusterKey === 'educators';
 // Title: the `label` already contains the canton display + preposition
 // (e.g. "Maisons de retraite dans le canton de Schaffhouse"). The trailing
 // suffix MUST NOT repeat the canton — duplicating it pushed FR/EN titles
 // past 80-104 chars and tanked the audit:title-length ratchet (Phase 8a
 // canton expansion). Short suffix only; brand dropped by titleSuffix.ts
 // when total exceeds the 66-char cap.
 const title = locale === 'it'
 ? isEducators
 ? `Concorso Educatore ${cd.it} | Offerte aggiornate`
 : `${label} | Offerte aggiornate`
 : locale === 'en'
 ? `${label} | Updated job offers`
 : locale === 'de'
 ? `${label} | Aktuelle Jobangebote`
 : `${label} | Offres a jour`;
 const description = locale === 'it'
 ? isEducators
 ? `Concorso educatore ${cd.it}: ${matches.length} offerte di lavoro per educatori dell'infanzia, educatrici e pedagoghi con candidature dirette.`
 : `Scopri ${matches.length} offerte per ${label.toLowerCase()} con annunci aggiornati, nuovi inserimenti degli ultimi 3 giorni e link diretti alle candidature ufficiali in ${cd.it}.`
 : locale === 'en'
 ? `Browse ${matches.length} ${label.toLowerCase()} job offers in ${cd.en}, with updated listings, jobs from the last 3 days and direct links to official applications.`
 : locale === 'de'
 ? `Entdecken Sie ${matches.length} Jobangebote fur ${label.toLowerCase()} ${germanCantonPrep(cd.de)} mit aktuellen Inseraten der letzten 3 Tage und direkten Bewerbungslinks.`
 : `Consultez ${matches.length} offres pour ${label.toLowerCase()} ${frenchCantonPrep(cd.fr)}, avec annonces a jour, offres des 3 derniers jours et liens directs vers la candidature officielle.`;
 const intro = locale === 'it'
 ? `Questa pagina restringe il cluster sanita ai profili ${label.toLowerCase()}, cosi puoi leggere solo gli annunci davvero pertinenti senza passare da una lista troppo ampia.`
 : locale === 'en'
 ? `This page narrows the healthcare hub down to ${label.toLowerCase()} roles, so you can focus on the most relevant listings without scanning a broad generic feed.`
 : locale === 'de'
 ? `Diese Seite fokussiert den Gesundheits-Hub auf ${label.toLowerCase()}, damit Sie die relevantesten Stellen schneller sehen.`
 : `Cette page resserre le hub sante sur les roles ${label.toLowerCase()} pour aller directement aux offres les plus pertinentes.`;
 const siblingLinks = buildCareVariantLinks({ jobs: options.jobs, locale, now, baseUrl, localePrefix: options.localePrefix, sectionSlug: options.sectionSlug, partition: options.partition, canton: cantonCode }).filter((entry) => entry.key !== clusterKey);
 const feedJobs = toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18);
 const latestJobsLinked = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12), feedJobs);
 return {
 kind: 'care-variant',
 slug: careClusterSlug(clusterKey, cantonCode, locale),
 clusterKey,
 title,
 heading: label,
 description,
 intro,
 updatedLabel: locale === 'it' ? 'Aggiornamento' : locale === 'en' ? 'Updated' : locale === 'de' ? 'Aktualisiert' : 'Mis a jour',
 countsLabel: locale === 'it' ? 'offerte attive' : locale === 'en' ? 'active job offers' : locale === 'de' ? 'aktive Angebote' : 'offres actives',
 totalJobs: matches.length,
 feed: {
 label: locale === 'it' ? `Offerte ${label.toLowerCase()}` : locale === 'en' ? `${label} job offers` : locale === 'de' ? `${label} Jobs` : `Offres ${label.toLowerCase()}`,
 jobs: feedJobs,
 },
 latestLabel: locale === 'it' ? `Nuove offerte ${label.toLowerCase()} negli ultimi 3 giorni` : locale === 'en' ? `Newest ${label.toLowerCase()} jobs in the last 3 days` : locale === 'de' ? `Neueste ${label.toLowerCase()} der letzten 3 Tage` : `Nouvelles offres ${label.toLowerCase()} des 3 derniers jours`,
 latestJobs: latestJobsLinked,
 parentHubHref: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${(JOB_NURSES_HUB_SLUGS_BY_CANTON[cantonCode] || JOB_NURSES_HUB_SLUGS)[locale]}`.replace(/\/+/g, '/')}`),
 siblingLinks,
 openAllLabel: locale === 'it' ? `Vedi tutte le offerte in ${cd.it}` : locale === 'en' ? `See all jobs in ${cd.en}` : locale === 'de' ? `Alle Jobs ${germanCantonPrep(cd.de)} ansehen` : `Voir toutes les offres ${frenchCantonPrep(cd.fr)}`,
 };
}

export function buildJobTodayLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 canton?: string;
}): JobTodayLandingModel {
 const locale = options.locale;
 const cantonCode = options.canton || 'TI';
 const copy = makeTodayCopy(cantonCode)[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 const todaySlugs = JOB_TODAY_LANDING_SLUGS_BY_CANTON[cantonCode] || JOB_TODAY_LANDING_SLUGS;
 const landingHref = ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${todaySlugs[locale]}`.replace(/\/+/g, '/')}`);
 // Per-canton scoping: the recent24h/recent3d/partTime feeds previously
 // skipped any canton filter, so /cerca-lavoro-{canton}/{today-slug}/
 // pages on every non-TI canton listed jobs from across Switzerland
 // (mostly TI). Restrict to the canton — `isCantonScoped` routes through
 // resolveJobCanton, so BASILEA matches BS+BL and APPENZELLO matches AI+AR.
 const cantonJobs = options.jobs.filter((job) => isCantonScoped(job, cantonCode));
 const recent24h = cantonJobs.filter((job) => isInLast24Hours(getJobFreshnessDate(job), now));
 const recent3d = cantonJobs.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const partTime = cantonJobs.filter((job) => isPartTime(job));
 const citySourceJobs = cantonJobs;
 const cityLeaders = Array.from(
 citySourceJobs.reduce<Map<string, number>>((map, job) => {
 const location = normalizeSpace(job.location || '');
 if (!location) return map;
 map.set(location, (map.get(location) || 0) + 1);
 return map;
 }, new Map<string, number>()),
 ) .map(([name, count]) => {
 // Only the 5 main Ticino hub cities have `/cerca-lavoro-ticino/ricerca-{city}/`
 // search pages generated. For any other city (Grigioni/Vallese villages,
 // Ticino rural locations, multi-word location strings) we leave href empty
 // so the template renders a plain-text card (no broken links).
 const slug = slugifyTerm(name) || '';
 const TICINO_RICERCA_HUBS = new Set(['lugano', 'bellinzona', 'mendrisio', 'locarno', 'chiasso']);
 const href = cantonCode === 'TI' && TICINO_RICERCA_HUBS.has(slug)
 ? buildSearchHref(baseUrl, options.localePrefix, options.sectionSlug, locale, name)
 : '';
 return { name, count, href };
 })
 .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }))
 .slice(0, 8);

 return {
 slug: todaySlugs[locale],
 title: copy.title,
 heading: copy.heading,
 description: copy.description,
 intro: copy.intro,
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: cantonJobs.length,
 sections: {
 last24Hours: { label: copy.fresh24h, jobs: toLinkedJobs(recent24h, now, locale, { ...options, baseUrl }) },
 last3Days: { label: copy.fresh3d, jobs: toLinkedJobs(recent3d, now, locale, { ...options, baseUrl }) },
 partTime: { label: copy.partTime, jobs: toLinkedJobs(partTime, now, locale, { ...options, baseUrl }) },
 cityHubLabel: copy.cityHub,
 cities: cityLeaders,
 },
 internalLinks: [
 { label: copy.internalLinks[0], href: `${landingHref}#last-24-hours` },
 { label: copy.internalLinks[1], href: `${landingHref}#last-3-days` },
 { label: copy.internalLinks[2], href: `${landingHref}#part-time` },
 ],
 openAllLabel: copy.openAll,
 };
}

export function buildJobLocationLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 location: string;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 /**
  * Optional pre-computed location partition (see `partitionByLocation`).
  * When provided, skips per-call `matchesLocation` full-array filters in
  * both this builder and its sibling helpers. Output unchanged.
  */
 partition?: LocationPartition;
}): JobLocationLandingModel {
 const locale = options.locale;
 const location = normalizeLocation(options.location);
 const copy = LOCATION_COPY[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 const partitionLocationJobs = options.partition?.byLocation.get(location);
 const locationJobs: JobLike[] = partitionLocationJobs
 ? [...partitionLocationJobs]
 : options.jobs.filter((job) => matchesLocation(job, location));
 const latestJobs = locationJobs.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const feedJobsLocCity = toLinkedJobs(locationJobs, now, locale, { ...options, baseUrl }, 25);
 const latestJobsLocCity = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12), feedJobsLocCity);
 return {
 kind: 'location',
 slug: buildLocationSlug(locale, location),
 location,
 title: copy.title(location),
 heading: copy.heading(location),
 description: copy.description(location, locationJobs.length),
 intro: copy.intro(location),
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: locationJobs.length,
 // Caps held at 25 (feed) + 12 (latest) to keep emitted city-hub HTML
 // strictly under the 195 KB hard budget enforced by audit:page-weight.
 // Earlier bump to 60 + 30 violated that budget on Lugano/Bellinzona
 // (376 KB); the 30 + 15 step also tripped the hard-fail at 203.5 KB on
 // lugano (commuter-context prose adds ~5-7 KB structural HTML on top of
 // the per-card cost). BFS reachability for the long tail of detail
 // pages is achieved via paginated /<city>/page-N/ archives + the
 // per-detail related-jobs cross-link block (see jobsSeoPagesPlugin),
 // not by packing more cards onto the city hub itself.
 feed: { label: copy.feedLabel(location), jobs: feedJobsLocCity },
 latestLabel: copy.latestLabel(location),
 latestJobs: latestJobsLocCity,
 relatedTypeLinks: buildLocationTypeLinks({ ...options, location, now, baseUrl, partition: options.partition }),
 relatedSectorLinks: buildLocationSectorLinks({ ...options, location, now, baseUrl, partition: options.partition }),
 openAllLabel: copy.openAll,
 };
}

export function buildJobLocationTypeLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 location: string;
 typeKey: JobLandingTypeKey;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 partition?: LocationPartition;
}): JobLocationTypeLandingModel {
 const locale = options.locale;
 const location = normalizeLocation(options.location);
 const typeKey = options.typeKey;
 const typeDef = getTypeDef(typeKey);
 const label = typeDef.label[locale];
 const copy = LOCATION_TYPE_COPY[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 const partitionMatches = options.partition?.byLocationType.get(location)?.get(typeKey);
 const matches: JobLike[] = partitionMatches
 ? [...partitionMatches]
 : options.jobs.filter((job) => matchesLocation(job, location) && typeDef.matcher(job));
 const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const siblingTypeLinks = buildLocationTypeLinks({ ...options, location, now, baseUrl, partition: options.partition }).filter((link) => link.key !== typeKey);
 const feedJobsLocType = toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 30);
 const latestJobsLocType = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 15), feedJobsLocType);
 return {
 kind: 'location-type',
 slug: buildLocationTypeSlug(locale, location, typeKey),
 location,
 typeKey,
 typeLabel: label,
 title: copy.title(label, location),
 heading: copy.heading(label, location),
 description: copy.description(label, location, matches.length),
 intro: copy.intro(label, location),
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: matches.length,
 // Page-weight cap (see buildJobLocationLandingModel comment).
 feed: { label: copy.feedLabel(label, location), jobs: feedJobsLocType },
 latestLabel: copy.latestLabel(label, location),
 latestJobs: latestJobsLocType,
 parentLocationHref: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationSlug(locale, location)}`.replace(/\/+/g, '/')}`),
 siblingTypeLinks,
 openAllLabel: copy.openAll,
 };
}

export function buildJobLocationSectorLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 location: string;
 sectorKey: JobLandingSectorKey;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 partition?: LocationPartition;
}): JobLocationSectorLandingModel {
 const locale = options.locale;
 const location = normalizeLocation(options.location);
 const sectorKey = options.sectorKey;
 const sectorDef = getSectorDef(sectorKey);
 const label = sectorDef.label[locale];
 const copy = LOCATION_SECTOR_COPY[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 const partitionMatches = options.partition?.byLocationSector.get(location)?.get(sectorKey);
 const matches: JobLike[] = partitionMatches
 ? [...partitionMatches]
 : options.jobs.filter((job) => matchesLocation(job, location) && sectorDef.matcher(job));
 const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const siblingSectorLinks = buildLocationSectorLinks({ ...options, location, now, baseUrl, partition: options.partition }).filter((link) => link.key !== sectorKey);
 const feedJobsLocSector = toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 30);
 const latestJobsLocSector = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 15), feedJobsLocSector);
 return {
 kind: 'location-sector',
 slug: buildLocationSectorSlug(locale, location, sectorKey),
 location,
 sectorKey,
 sectorLabel: label,
 title: copy.title(label, location),
 heading: copy.heading(label, location),
 description: copy.description(label, location, matches.length),
 intro: copy.intro(label, location),
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: matches.length,
 // Page-weight cap (see buildJobLocationLandingModel comment).
 feed: { label: copy.feedLabel(label, location), jobs: feedJobsLocSector },
 latestLabel: copy.latestLabel(label, location),
 latestJobs: latestJobsLocSector,
 parentLocationHref: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationSlug(locale, location)}`.replace(/\/+/g, '/')}`),
 siblingSectorLinks,
 openAllLabel: copy.openAll,
 };
}

function makeSectorRegionCopy(cantonCode: string): Record<JobLandingLocale, {
 heading: (label: string) => string;
 title: (label: string) => string;
 description: (label: string, count: number) => string;
 intro: (label: string) => string;
 countsLabel: string;
 updatedLabel: string;
 feedLabel: (label: string) => string;
 latestLabel: (label: string) => string;
 openAll: string;
}> {
 const cd = CANTON_DISPLAY_LOCALE[cantonCode] || CANTON_DISPLAY_LOCALE['TI'];
 return {
 it: {
 heading: (label) => `Lavoro ${label} in ${cd.it}`,
 title: (label) => `Lavoro ${label} in ${cd.it} | Offerte aggiornate`,
 description: (label, count) => `Scopri ${count} offerte di lavoro nel settore ${label.toLowerCase()} in ${cd.it}. Posizioni attive aggiornate ogni giorno per frontalieri.`,
 intro: (label) => `Tutte le offerte nel settore ${label.toLowerCase()} disponibili nel Canton ${cd.it}, ideale per chi cerca lavoro come frontaliere.`,
 countsLabel: 'annunci attivi',
 updatedLabel: 'Aggiornamento',
 feedLabel: (label) => `${label} attivi in ${cd.it}`,
 latestLabel: (label) => `Nuovi annunci ${label.toLowerCase()} in ${cd.it}`,
 openAll: `Vedi tutte le offerte in ${cd.it}`,
 },
 en: {
 heading: (label) => `${label} Jobs in ${cd.en}`,
 title: (label) => `${label} Jobs in ${cd.en} | Updated Listings`,
 description: (label, count) => `Browse ${count} ${label.toLowerCase()} job openings in ${cd.en}. Updated daily for cross-border workers.`,
 intro: (label) => `All ${label.toLowerCase()} positions available in Canton ${cd.en} for cross-border workers.`,
 countsLabel: 'active listings',
 updatedLabel: 'Updated',
 feedLabel: (label) => `${label} jobs in ${cd.en}`,
 latestLabel: (label) => `Latest ${label.toLowerCase()} jobs in ${cd.en}`,
 openAll: `View all ${cd.en} jobs`,
 },
 de: {
 heading: (label) => `${label}-Jobs ${germanCantonPrep(cd.de)}`,
 title: (label) => `${label}-Jobs ${germanCantonPrep(cd.de)} | Aktuelle Stellenangebote`,
 description: (label, count) => `Entdecken Sie ${count} offene Stellen im Bereich ${label} ${germanCantonPrep(cd.de)}. Taglich aktualisiert fur Grenzganger.`,
 intro: (label) => `Alle Stellenangebote im Bereich ${label} im Kanton ${cd.de} fur Grenzganger.`,
 countsLabel: 'aktive Inserate',
 updatedLabel: 'Aktualisiert',
 feedLabel: (label) => `${label}-Stellen ${germanCantonPrep(cd.de)}`,
 latestLabel: (label) => `Neueste ${label}-Stellen ${germanCantonPrep(cd.de)}`,
 openAll: `Alle Stellen ${germanCantonPrep(cd.de)} ansehen`,
 },
 fr: {
 heading: (label) => `Emplois ${label} ${frenchCantonPrep(cd.fr)}`,
 title: (label) => `Emplois ${label} ${frenchCantonPrep(cd.fr)}`,
 description: (label, count) => `Decouvrez ${count} offres d'emploi dans le secteur ${label.toLowerCase()} ${frenchCantonPrep(cd.fr)}. Mises a jour quotidiennement pour les frontaliers.`,
 intro: (label) => `Toutes les offres dans le secteur ${label.toLowerCase()} disponibles ${frenchCantonPrep(cd.fr)} pour les frontaliers.`,
 countsLabel: 'annonces actives',
 updatedLabel: 'Mis a jour',
 feedLabel: (label) => `Emplois ${label} ${frenchCantonPrep(cd.fr)}`,
 latestLabel: (label) => `Derniers emplois ${label.toLowerCase()} ${frenchCantonPrep(cd.fr)}`,
 openAll: `Voir toutes les offres ${frenchCantonPrep(cd.fr)}`,
 },
 };
}

const SECTOR_REGION_COPY = makeSectorRegionCopy('TI');

export function buildJobSectorRegionLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 sectorKey: JobLandingSectorKey;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 canton?: string;
}): JobSectorRegionLandingModel {
 const locale = options.locale;
 const cantonCode = options.canton || 'TI';
 const sectorKey = options.sectorKey;
 const sectorDef = getSectorDef(sectorKey);
 const label = sectorDef.label[locale];
 const copy = makeSectorRegionCopy(cantonCode)[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 const sectorSlug = sectorDef.slug[locale];
 const cantonSlug = CANTON_SLUG_LOCALE[cantonCode]?.[locale] || CANTON_SLUG_LOCALE['TI'][locale];
 const slug = `${SEARCH_ROUTE_PREFIX[locale]}-${sectorSlug}-${cantonSlug}`;
 const matches = options.jobs.filter((job) => sectorDef.matcher(job));
 const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));
 const siblingSectorLinks = (Object.keys(JOB_SECTOR_DEFS) as JobLandingSectorKey[])
 .filter((k) => k !== sectorKey)
 .map((k) => {
 const def = getSectorDef(k);
 const count = options.jobs.filter((job) => def.matcher(job)).length;
 if (count === 0) return null;
 const kSlug = def.slug[locale];
 const kRegion = CANTON_SLUG_LOCALE[cantonCode]?.[locale] || CANTON_SLUG_LOCALE['TI'][locale];
 return {
 key: k,
 label: def.label[locale],
 count,
 href: ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${SEARCH_ROUTE_PREFIX[locale]}-${kSlug}-${kRegion}`.replace(/\/+/g, '/')}`),
 };
 })
 .filter(Boolean) as SectorLink[];

 const feedJobsSectorRegion = toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18);
 const latestJobsSectorRegion = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12), feedJobsSectorRegion);
 return {
 kind: 'sector-region',
 slug,
 sectorKey,
 title: copy.title(label),
 heading: copy.heading(label),
 description: copy.description(label, matches.length),
 intro: copy.intro(label),
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: matches.length,
 feed: { label: copy.feedLabel(label), jobs: feedJobsSectorRegion },
 latestLabel: copy.latestLabel(label),
 latestJobs: latestJobsSectorRegion,
 siblingSectorLinks,
 openAllLabel: copy.openAll,
 };
}

function makePartTimeCopy(cantonCode: string): Record<JobLandingLocale, {
 title: string;
 heading: string;
 description: (count: number) => string;
 intro: string;
 updatedLabel: string;
 countsLabel: string;
 feedLabel: string;
 latestLabel: string;
 cityHub: string;
 openAll: string;
 faq: Array<{ question: string; answer: string }>;
}> {
 const cd = CANTON_DISPLAY_LOCALE[cantonCode] || CANTON_DISPLAY_LOCALE['TI'];
 return {
 it: {
 title: `Lavoro part-time ${cd.it} | Posti flessibili frontalieri`,
 heading: `Lavoro part-time in ${cd.it}`,
 description: (count) => `Scopri ${count} offerte part-time in ${cd.it} per frontalieri. Posizioni a tempo parziale aggiornate da aziende svizzere, con filtri per citta e settore.`,
 intro: `Questa landing raccoglie tutte le offerte a tempo parziale disponibili nel Canton ${cd.it}, ideale per chi cerca flessibilita lavorativa come frontaliere. Le posizioni spaziano da contratti al 20% fino al 80% e coprono tutti i principali settori.`,
 updatedLabel: 'Aggiornamento',
 countsLabel: 'annunci part-time attivi',
 feedLabel: `Offerte part-time in ${cd.it}`,
 latestLabel: 'Nuove offerte part-time negli ultimi 3 giorni',
 cityHub: 'Part-time per citta',
 openAll: `Vedi tutte le offerte di lavoro in ${cd.it}`,
 faq: [
 {
 question: 'Cosa si intende per lavoro part-time in Svizzera?',
 answer: 'In Svizzera il lavoro part-time indica qualsiasi contratto con un grado di occupazione inferiore al 100%. Puo essere espresso in percentuale (es. 60%, 80%) o in ore settimanali. Anche contratti al 90% sono considerati part-time.',
 },
 {
 question: 'Un frontaliere puo lavorare part-time con il permesso G?',
 answer: "Si, il permesso G consente anche contratti a tempo parziale. L'importante e che il rapporto di lavoro sia regolare e dichiarato. Il part-time non influisce sulla validita del permesso.",
 },
 {
 question: 'Come vengono filtrate le offerte part-time?',
 answer: "Il nostro sistema identifica le offerte part-time analizzando il titolo, il contratto e la percentuale di impiego indicata nell'annuncio. Le posizioni con percentuale tra 1% e 99% vengono automaticamente classificate come part-time.",
 },
 ],
 },
 en: {
 title: `Part-time jobs in ${cd.en} | Flexible cross-border roles`,
 heading: `Part-time jobs in ${cd.en}`,
 description: (count) => `Browse ${count} part-time jobs in ${cd.en} for cross-border workers. Flexible positions updated daily, filterable by city, sector and employment percentage.`,
 intro: `This page collects all part-time positions available in Canton ${cd.en}, ideal for cross-border workers seeking flexibility. Roles range from 20% to 80% contracts across all major sectors.`,
 updatedLabel: 'Updated',
 countsLabel: 'active part-time jobs',
 feedLabel: `Part-time jobs in ${cd.en}`,
 latestLabel: 'New part-time jobs in the last 3 days',
 cityHub: 'Part-time by city',
 openAll: `See all jobs in ${cd.en}`,
 faq: [
 {
 question: 'What counts as part-time work in Switzerland?',
 answer: 'In Switzerland, part-time means any contract with an employment level below 100%. It can be expressed as a percentage (e.g. 60%, 80%) or weekly hours. Even 90% contracts are considered part-time.',
 },
 {
 question: 'Can a cross-border worker hold a part-time job with a G permit?',
 answer: 'Yes, the G permit allows part-time contracts. The key requirement is that the employment relationship is regular and declared. Part-time status does not affect permit validity.',
 },
 {
 question: 'How are part-time jobs identified?',
 answer: 'Our system identifies part-time jobs by analysing the title, contract type and employment percentage stated in the listing. Positions with a percentage between 1% and 99% are automatically classified as part-time.',
 },
 ],
 },
 de: {
 title: `Teilzeitjobs ${germanCantonPrep(cd.de)} | Flexible Stellen`,
 heading: `Teilzeitjobs ${germanCantonPrep(cd.de)}`,
 description: (count) => `Entdecken Sie ${count} Teilzeitstellen ${germanCantonPrep(cd.de)} fur Grenzganger. Flexible Positionen taglich aktualisiert, filterbar nach Stadt und Branche.`,
 intro: `Diese Seite sammelt alle Teilzeitstellen im Kanton ${cd.de}, ideal fur Grenzganger auf der Suche nach flexibler Arbeit. Die Positionen reichen von 20%- bis 80%-Vertragen in allen wichtigen Branchen.`,
 updatedLabel: 'Aktualisiert',
 countsLabel: 'aktive Teilzeitstellen',
 feedLabel: `Teilzeitstellen ${germanCantonPrep(cd.de)}`,
 latestLabel: 'Neue Teilzeitstellen der letzten 3 Tage',
 cityHub: 'Teilzeit nach Stadt',
 openAll: `Alle Jobs ${germanCantonPrep(cd.de)} ansehen`,
 faq: [
 {
 question: 'Was gilt in der Schweiz als Teilzeitarbeit?',
 answer: 'In der Schweiz bezeichnet Teilzeitarbeit jeden Vertrag mit einem Beschaftigungsgrad unter 100%. Er kann als Prozentsatz (z. B. 60%, 80%) oder in Wochenstunden angegeben werden. Auch 90%-Vertrage gelten als Teilzeit.',
 },
 {
 question: 'Darf ein Grenzganger mit G-Bewilligung Teilzeit arbeiten?',
 answer: 'Ja, die G-Bewilligung erlaubt auch Teilzeitvertrage. Wichtig ist, dass das Arbeitsverhaltnis regulaer und gemeldet ist. Der Teilzeitstatus beeinflusst die Gultigkeit der Bewilligung nicht.',
 },
 {
 question: 'Wie werden Teilzeitstellen erkannt?',
 answer: 'Unser System erkennt Teilzeitstellen anhand von Titel, Vertragsart und angegebenem Beschaftigungsgrad. Positionen mit einem Pensum zwischen 1% und 99% werden automatisch als Teilzeit klassifiziert.',
 },
 ],
 },
 fr: {
 title: `Temps partiel ${frenchCantonPrep(cd.fr)} | Postes flexibles`,
 heading: `Emploi temps partiel ${frenchCantonPrep(cd.fr)}`,
 description: (count) => `Consultez ${count} offres a temps partiel ${frenchCantonPrep(cd.fr)} pour frontaliers. Postes flexibles mis a jour quotidiennement, filtrables par ville et secteur.`,
 intro: `Cette page regroupe toutes les offres a temps partiel disponibles dans le canton ${cd.fr}, ideales pour les frontaliers a la recherche de flexibilite. Les postes vont de contrats a 20% jusqu'a 80% dans tous les secteurs majeurs.`,
 updatedLabel: 'Mis a jour',
 countsLabel: 'offres temps partiel actives',
 feedLabel: `Offres a temps partiel ${frenchCantonPrep(cd.fr)}`,
 latestLabel: 'Nouvelles offres temps partiel des 3 derniers jours',
 cityHub: 'Temps partiel par ville',
 openAll: `Voir toutes les offres ${frenchCantonPrep(cd.fr)}`,
 faq: [
 {
 question: "Qu'est-ce que le temps partiel en Suisse ?",
 answer: "En Suisse, le temps partiel designe tout contrat avec un taux d'occupation inferieur a 100%. Il peut etre exprime en pourcentage (ex. 60%, 80%) ou en heures hebdomadaires. Meme les contrats a 90% sont consideres comme du temps partiel.",
 },
 {
 question: "Un frontalier peut-il travailler a temps partiel avec un permis G ?",
 answer: "Oui, le permis G autorise egalement les contrats a temps partiel. L'essentiel est que la relation de travail soit reguliere et declaree. Le statut a temps partiel n'affecte pas la validite du permis.",
 },
 {
 question: "Comment les offres a temps partiel sont-elles identifiees ?",
 answer: "Notre systeme identifie les offres a temps partiel en analysant le titre, le type de contrat et le taux d'occupation indique dans l'annonce. Les postes avec un taux entre 1% et 99% sont automatiquement classes comme temps partiel.",
 },
 ],
 },
 };
}

const PART_TIME_COPY = makePartTimeCopy('TI');

export function buildJobPartTimeLandingModel(options: {
 jobs: JobLike[];
 locale: JobLandingLocale;
 now?: string | Date;
 localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
 baseUrl: string;
 sectionSlug: string;
 localePrefix: string;
 canton?: string;
}): JobPartTimeLandingModel {
 const locale = options.locale;
 const cantonCode = options.canton || 'TI';
 const copy = makePartTimeCopy(cantonCode)[locale];
 const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
 const baseUrl = options.baseUrl.replace(/\/+$/, '');
 const matches = options.jobs.filter((job) => isCantonScoped(job, cantonCode) && isPartTime(job));
 const latestJobs = matches.filter((job) => isInLast3Days(getJobFreshnessDate(job), now));

 // Build city breakdown for part-time jobs
 const cityCountMap = new Map<string, number>();
 for (const job of matches) {
 const loc = normalizeSpace(job.location || '');
 if (!loc) continue;
 const cantonLocations = EDITORIAL_LOCATIONS_BY_CANTON[cantonCode] || EDITORIAL_LOCATIONS_BY_CANTON['TI'];
 const canonical = cantonLocations.find((l) => l.toLowerCase() === loc.toLowerCase());
 if (canonical) {
 cityCountMap.set(canonical, (cityCountMap.get(canonical) || 0) + 1);
 }
 }
 const cityLinks: CityLeader[] = Array.from(cityCountMap.entries())
 .map(([name, count]) => {
 // Only Ticino `/ricerca-{city}-part-time/` pages are generated. For other
 // cantons, render plain-text city cards to avoid broken links.
 const href = cantonCode === 'TI'
 ? ensureTrailingSlash(`${baseUrl}${`${options.localePrefix}/${options.sectionSlug}/${buildLocationTypeSlug(locale, name, 'partTime')}`.replace(/\/+/g, '/')}`)
 : '';
 return { name, count, href };
 })
 .sort((a, b) => b.count - a.count);

 const feedJobsPartTime = toLinkedJobs(matches, now, locale, { ...options, baseUrl }, 18);
 const latestJobsPartTime = dedupeAgainst(toLinkedJobs(latestJobs, now, locale, { ...options, baseUrl }, 12), feedJobsPartTime);
 return {
 kind: 'part-time',
 // Phase 8 sub-PR (d): the canton-aware table is the single source of
 // truth. TI/GR/VS rows preserve the legacy long-form (`lavoro-part-time-
 // ticino`) byte-identically; non-TI cantons collapse to the short form
 // (`lavoro-part-time`) because the canton is encoded in the section
 // segment. `JOB_PART_TIME_LANDING_SLUGS` is kept as a backward-compatible
 // short-form export and must NOT be consulted from the model — using it
 // for TI would silently change the indexed URL.
 slug: (JOB_PART_TIME_LANDING_SLUGS_BY_CANTON[cantonCode] || JOB_PART_TIME_LANDING_SLUGS_BY_CANTON['TI'])[locale],
 title: copy.title,
 heading: copy.heading,
 description: copy.description(matches.length),
 intro: copy.intro,
 updatedLabel: copy.updatedLabel,
 countsLabel: copy.countsLabel,
 totalJobs: matches.length,
 feed: { label: copy.feedLabel, jobs: feedJobsPartTime },
 latestLabel: copy.latestLabel,
 latestJobs: latestJobsPartTime,
 cityLinks,
 cityHubLabel: copy.cityHub,
 faq: copy.faq,
 openAllLabel: copy.openAll,
 };
}
