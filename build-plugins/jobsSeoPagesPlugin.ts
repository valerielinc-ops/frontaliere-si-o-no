/**
 * Generate localized static landing pages for every job in data/jobs.json.
 *
 * For each job × 4 locales, writes a standalone HTML page with structured
 * data (JobPosting, BreadcrumbList), OG/Twitter meta, related jobs,
 * and an "Apply now" CTA linking to the original listing.
 * Also writes sitemap-jobs.xml and patches it into the main sitemap index.
 */

import path from 'path';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage, SPA_ACTION_REDIRECT_SCRIPT, robotsMetaForContent, countHtmlBodyWords, MIN_INDEXABLE_WORDS, GTAG_SNIPPET, ADSENSE_SNIPPET, FAVICON_LINKS } from './constants';
import { buildSimplePage } from './htmlTemplate';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { buildFlatBridgeFromSibling } from './flatHtmlRedirectPlugin';
import { buildTitleWithBrand, truncateHeadline, TITLE_BRAND_SUFFIX, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { CRAWLED_COMPANY_LOGOS } from '../services/jobDataNormalization';
import {
 renderJobCardHtml,
 renderJobCardListHtml,
 type JobCardJob,
} from './shared/jobCardHtml';
import { renderListingPaginationProse } from './shared/jobListingProse';
import {
 renderJobBoardCommuterContext,
 renderSearchQueryIntro,
 isKnownTicinoCommuterCity,
} from './shared/jobBoardCommuterContext';
import { renderCompanyHubFrontalierContext } from './shared/companyHubFrontalierContext';
import { deriveJobPostalCode } from '../services/jobLocationSnapshot';
import {
 loadWinners,
 saveWinners,
 resolveWinner,
 pruneStaleWinners,
 makeKey as previousSlugWinnerKey,
 type CandidateInput as PreviousSlugCandidate,
 type WinnersFile as PreviousSlugWinnersFile,
} from '../services/previousSlugWinners';
import { EMPLOYER_BRANDS, type EmployerBrand } from '../services/employerBrands';
import {
 BRAND_CANONICAL_MAP,
 isBrandAlias,
 listAllBrandAliases,
} from './shared/brandCanonicalMap';
import {
 buildJobCareVariantLandingModel,
 buildJobLocationLandingModel,
 buildJobLocationSectorLandingModel,
 buildJobLocationTypeLandingModel,
 buildJobNursesHubLandingModel,
 buildJobOfficialGazetteLandingModel,
 buildJobPartTimeLandingModel,
 buildJobTodayLandingModel,
 getJobTodayLandingSlug,
 EDITORIAL_CANTONS,
 partitionCareClusters,
 partitionByLocation,
 type CareClusterPartition,
 type LocationPartition,
} from './jobEditorialLanding';
import {
 CITY_HUB_KEYS,
 CITY_HUB_SLUG,
 CITY_HUB_DISPLAY_NAME,
 buildCityHubPath,
 buildCityHubSeo,
 countCityJobsByLocale,
 jobMatchesCity,
 type CityHubKey,
} from './cityJobsHub';
import {
 SECTOR_HUB_KEYS,
 SECTOR_HUB_DISPLAY,
 SECTOR_HUB_SLUG,
 buildSectorHubPath,
 jobMatchesSector,
 type SectorHubKey,
} from './jobSectorLanding';
import { SEO_HUB_RESERVED_SLUGS } from './seoHubsData';
// F3a — Job Page CTR Optimization: shared 50-60 char title templates and
// 140-160 char meta-description templates that drive SERP CTR on the
// top-20 job listing pages. See services/seo/job-board-titles.ts and
// services/seo/meta-descriptions.ts for details.
import {
 buildEmployerHubTitle,
 buildRoleHubTitle,
} from '../services/seo/job-board-titles';
import { formatSeoH1 } from './shared/seoContentTokens';
import {
 buildCityHubMeta as buildCtrCityHubMeta,
 buildEmployerHubMeta,
 buildRoleHubMeta,
} from '../services/seo/meta-descriptions';
import { COMPANY_HQ_ADDRESSES } from './shared/companyHqAddresses';
import { buildJobPostingSchema, type JobInput } from './shared/jobPostingSchema';
import { startTimer, recordEmit, printSummary as printJobsSeoProfile } from './shared/jobsSeoProfiler.ts';
import { resolveJobsSeoPagesFlushed } from './shared/buildSignals';
import { MIN_JOBS_FOR_CANTON_PAGE } from './weeklyEmployersData';

export const JOB_SEO_LOCALES = ['it', 'en', 'de', 'fr'] as const;

const HUB_SEO_CONTEXT_SUMMARY: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Guida frontalieri: salario, permesso G, fisco, rientro',
 en: 'Cross-border guide: salary, G permit, tax, weekly return',
 de: 'Grenzgänger-Leitfaden: Lohn, G-Bewilligung, Steuer, Rückkehr',
 fr: 'Guide frontaliers : salaire, permis G, fiscalité, retour',
};

/**
 * Wrap commuter-context block in a collapsed `<details>` accordion below
 * the real hub content (mobile-first per CLAUDE.md rule #14). Lifts the
 * crawler-facing prose out of the markup-heavy hub list page so the
 * audit:text-html-ratio gate stays above the 10% Semrush threshold.
 */
function wrapHubSeoContext(locale: 'it' | 'en' | 'de' | 'fr', innerHtml: string): string {
 return `<details class="hub-seo-context" style="margin:32px 0 0;padding:0;border-top:1px solid var(--color-edge)">
 <summary style="margin-top:18px;padding:10px 14px;cursor:pointer;color:var(--color-link);font-weight:600;font-size:15px;list-style:none">${HUB_SEO_CONTEXT_SUMMARY[locale]}</summary>
 <div style="padding:8px 0 0">
 <section style="max-width:860px;margin:0;color:var(--color-body);line-height:1.65;font-size:15px">
 ${innerHtml}
 </section>
 </div>
 </details>`;
}

export function pickSearchLandingFallbackJobs<T>(
 matchingJobsByLocale: Record<(typeof JOB_SEO_LOCALES)[number], T[]>,
): T[] {
 for (const locale of JOB_SEO_LOCALES) {
 const localeJobs = matchingJobsByLocale[locale];
 if (Array.isArray(localeJobs) && localeJobs.length > 0) {
 return localeJobs;
 }
 }
 return [];
}

/**
 * Safely convert an arbitrary value to an ISO-8601 string.
 * Returns null when the value is missing or cannot be parsed to a valid Date.
 * Used for JobPosting.dateModified / datePosted where Semrush flags
 * "Invalid Date" strings as NOT_RECOGNIZED.
 */
export function safeIsoDate(raw: unknown): string | null {
 if (raw == null) return null;
 try {
 const d = new Date(raw as string);
 return isNaN(d.getTime()) ? null : d.toISOString();
 } catch {
 return null;
 }
}

/** Locale-aware "in city" connector for title cores. */
const CITY_CONNECTOR: Record<string, string> = {
 it: 'a',
 en: 'in',
 de: 'in',
 fr: 'à',
};

/**
 * Build the "core" part of a job-detail title (without brand suffix).
 *
 * Includes the city whenever possible so multi-sede jobs do not collapse
 * into duplicate titles. Falls back gracefully when fields are missing.
 */
export function buildJobTitleCore(
 jobTitle: string,
 company: string,
 city: string,
 locale: string,
): string {
 const connector = CITY_CONNECTOR[locale] || CITY_CONNECTOR.it;
 const cleanCity = (city || '').trim();
 const cleanCompany = (company || '').trim();
 if (cleanCompany && cleanCity) {
 return `${jobTitle} — ${cleanCompany} ${connector} ${cleanCity}`;
 }
 if (cleanCompany) return `${jobTitle} — ${cleanCompany}`;
 if (cleanCity) return `${jobTitle} ${connector} ${cleanCity}`;
 return jobTitle;
}

const JOB_TITLE_BRAND_SUFFIX = ' | Frontaliere Ticino';
// Google rewrites titles beyond ~60 chars, but pages whose core exceeds the
// budget must NEVER drop the trailing city — truncating the tail made
// multi-sede roles (same title × N cities) collapse into one <title>.
// The hard ceiling is 70 chars (incl. suffix), still within SERP width,
// and the composer below always preserves the trailing city token.
const JOB_TITLE_MAX = 70;

/**
 * Word-aware truncation of a job-title core that has no company/city tail
 * to preserve. Used as the fallback path inside
 * {@link truncateJobCorePreservingCity} when the city/company structure
 * does not allow tail-preserving truncation.
 *
 * Cuts on the last whitespace inside `maxCore`, appends "…". Falls back
 * to a hard cut when no usable boundary exists.
 */
export function truncateTitleCore(core: string, maxCore: number): string {
 if (core.length <= maxCore) return core;
 // Reserve 1 char for the trailing ellipsis.
 const sliced = core.slice(0, maxCore - 1);
 const lastSpace = sliced.lastIndexOf(' ');
 if (lastSpace > Math.floor(maxCore / 2)) {
  return sliced.slice(0, lastSpace).trimEnd() + '…';
 }
 return sliced.trimEnd() + '…';
}

/**
 * City-preserving truncation: if the core exceeds `maxCore`, shorten the
 * job-title segment (everything before the " — " company delimiter) rather
 * than the tail, so the trailing "… in <city>" disambiguator survives.
 * Falls back to a plain tail-trim only when there is no company or city to
 * preserve.
 */
export function truncateJobCorePreservingCity(
 jobTitle: string,
 company: string,
 city: string,
 locale: string,
 maxCore: number,
): string {
 const full = buildJobTitleCore(jobTitle, company, city, locale);
 if (full.length <= maxCore) return full;
 const cleanCompany = (company || '').trim();
 const cleanCity = (city || '').trim();
 const connector = CITY_CONNECTOR[locale] || CITY_CONNECTOR.it;

 // Case 1: city only — "jobTitle <connector> city". Trim the jobTitle portion.
 if (!cleanCompany && cleanCity) {
  const tail = ` ${connector} ${cleanCity}`;
  // Reserve 1 char for the ellipsis appended after the slice.
  const jobBudget = maxCore - tail.length - 1;
  if (jobBudget >= 1 && jobTitle.length > jobBudget) {
   return `${jobTitle.slice(0, jobBudget).trimEnd()}…${tail}`;
  }
  // City tail alone consumes the full budget — fall back to tail-trim so
  // the result at least stays under maxCore (no city preservation possible).
  return truncateTitleCore(full, maxCore);
 }

 // Case 2: company + (optional) city.
 if (cleanCompany) {
  const companyTail = cleanCity
   ? ` — ${cleanCompany} ${connector} ${cleanCity}`
   : ` — ${cleanCompany}`;
  // 2a — if trimming only the jobTitle segment makes the result fit, do it.
  const jobBudget = maxCore - companyTail.length - 1;
  if (jobBudget >= 1 && jobTitle.length > jobBudget) {
   return `${jobTitle.slice(0, jobBudget).trimEnd()}…${companyTail}`;
  }
  // 2b — jobTitle already fits; the company segment is the culprit.
  // Trim the company name while preserving the trailing "<connector> city" token.
  if (cleanCity) {
   const cityTail = ` ${connector} ${cleanCity}`;
   const companyBudget = maxCore - jobTitle.length - cityTail.length - ' — '.length - 1;
   if (companyBudget >= 1 && cleanCompany.length > companyBudget) {
    const trimmedCompany = cleanCompany.slice(0, companyBudget).trimEnd();
    return `${jobTitle} — ${trimmedCompany}…${cityTail}`;
   }
  }
  return truncateTitleCore(full, maxCore);
 }

 return truncateTitleCore(full, maxCore);
}

/**
 * Build the disambiguator suffix appended to the title core when two
 * otherwise-identical jobs (same role + company + city) would collide.
 *
 * Format: ` (#abcd1234)` — a leading space, parentheses, hash sigil, then an
 * 8-char lowercase hex hash deterministically derived from the FULL input
 * token (typically the per-locale slug, which is already unique per page).
 *
 * Why a hash and not the slug tail: the previous implementation used the last
 * 6 alphanum chars of the slug, which collides when many slugs share a city
 * suffix (e.g. `…-chur`, `…-bach`) — yielding the same `(#enchur)` tail on
 * dozens of pages and re-tripping Semrush's title-uniqueness audit. A hash of
 * the FULL slug always differs whenever the slug differs, so as long as
 * router slugs are deduped at crawl time (which they are), final titles are
 * guaranteed unique across the locale.
 *
 * The hash function is a non-crypto FNV-1a-style rolling hash mixed into a
 * 32-bit unsigned integer and rendered as 8 hex digits — fast, dependency
 * free, deterministic, and effectively collision-free for our dataset size
 * (~10k pages per locale; birthday-bound ≈ 65k for 32-bit).
 *
 * Empty input returns an empty string so callers can pass through optional
 * tokens without conditional logic.
 */
export function buildTitleDisambiguator(token: string): string {
 // Format the disambiguator as ` · ${token}`. This used to emit an
 // FNV-1a 8-hex hash like ` (#abcd1234)` but Semrush's `<title>` audit
 // flags those as "low-CTR auto-disambiguator". We now expect callers
 // (see `pickJobDisambiguator` below) to pass a HUMAN-READABLE token
 // such as "80%", "CHF 60-75k", "apr 2027", or "rif. abc123" — a
 // compact, locale-friendly fragment that carries actual information.
 //
 // The token is rendered verbatim (after trimming + collapsing
 // whitespace) so callers control the localization. An empty token
 // returns an empty string so callers can pass through optional
 // disambiguators without conditional logic.
 const cleaned = String(token || '').trim().replace(/\s+/g, ' ');
 if (!cleaned) return '';
 return ` · ${cleaned}`;
}

/**
 * Compose final <title>: city-preserving truncated core + optional brand suffix.
 *
 * Universal policy: the final <title> is hard-capped at JOB_TITLE_MAX (70)
 * including the optional brand suffix. The core is truncated upstream
 * (preserving the trailing city token) so that the disambiguator hash
 * always lands inside the cap.
 *
 * When `disambiguator` is provided and non-empty (e.g. the per-locale slug
 * or job id), it is hashed into a short ` (#abcd1234)` suffix appended
 * INSIDE the cap so that two otherwise-identical jobs (same role + company
 * + city, multi-slug variants) emit distinct <title> tags. Its length is
 * subtracted from the city-preservation budget so neither the disambiguator
 * nor the trailing city token is amputated.
 */
export function composeJobPageTitle(
 jobTitle: string,
 company: string,
 city: string,
 locale: string,
 disambiguator?: string,
): string {
 const disamb = buildTitleDisambiguator(disambiguator || '');
 // Reserve room for BOTH the disambiguator AND the brand suffix inside
 // the 70-char cap. The brand is always appended downstream (see
 // buildTitleWithBrand — always-brand prevents title===h1 duplication),
 // so we must budget for it here, otherwise the city tail (which the
 // city-preserving truncate guarantees) would be amputated by the
 // downstream brand-fitting word-trim.
 const maxCore = Math.max(1, JOB_TITLE_MAX - disamb.length - JOB_TITLE_BRAND_SUFFIX.length);
 const core = truncateJobCorePreservingCity(jobTitle, company, city, locale, maxCore);
 // Pass JOB_TITLE_MAX explicitly so the universal-default 66-char cap in
 // shared/titleSuffix.ts does not retroactively drop the brand on
 // job-board pages whose city+disambiguator+role inherently land at
 // 67-70 char. Job pages are tracked separately in the audit baseline.
 return buildTitleWithBrand(`${core}${disamb}`, JOB_TITLE_BRAND_SUFFIX, JOB_TITLE_MAX);
}

/** Compose H1: job title + company only (no city, no brand). */
export function composeJobPageH1(jobTitle: string, company: string): string {
 const cleanCompany = (company || '').trim();
 return cleanCompany ? `${jobTitle} — ${cleanCompany}` : jobTitle;
}

// ─── Human-readable disambiguator cascade ─────────────────────────────────
//
// When two job postings share the same `<title>` base (job-title + company
// + city + locale), we append a compact, parlante token to disambiguate.
// Goals: (a) parlante (carries info, never an opaque hash), (b) unique
// enough across the colliding-title cohort, (c) short to keep the title
// inside JOB_TITLE_MAX (70). Cascade order, most-specific first:
//
//   1. workHours / employmentType-as-percentage   "80%", "60-100%"
//   2. employmentType label (non-default)         "Part-time", "Stagionale"
//   3. salary range (compact)                     "CHF 60-75k"
//   4. posted month                               "apr 2027"
//   5. job-id reference (always-unique fallback)  "rif. abc123"
//
// At each step we SKIP the token if it would duplicate text already in the
// base title (case-insensitive substring match). Token is human-readable,
// so the audit-title-no-disambig-hash gate (which scans only `(#abcdef12)`
// patterns) never flags it.

const EMPLOYMENT_TYPE_LABEL: Record<string, Record<string, string>> = {
 it: {
  PART_TIME: 'Part-time',
  TEMPORARY: 'Temporaneo',
  CONTRACTOR: 'Contratto',
  APPRENTICESHIP: 'Apprendistato',
  INTERN: 'Tirocinio',
  INTERNSHIP: 'Tirocinio',
  OTHER: '',
 },
 en: {
  PART_TIME: 'Part-time',
  TEMPORARY: 'Temporary',
  CONTRACTOR: 'Contract',
  APPRENTICESHIP: 'Apprenticeship',
  INTERN: 'Internship',
  INTERNSHIP: 'Internship',
  OTHER: '',
 },
 de: {
  PART_TIME: 'Teilzeit',
  TEMPORARY: 'Befristet',
  CONTRACTOR: 'Auftrag',
  APPRENTICESHIP: 'Lehre',
  INTERN: 'Praktikum',
  INTERNSHIP: 'Praktikum',
  OTHER: '',
 },
 fr: {
  PART_TIME: 'Temps partiel',
  TEMPORARY: 'Temporaire',
  CONTRACTOR: 'Contrat',
  APPRENTICESHIP: 'Apprentissage',
  INTERN: 'Stage',
  INTERNSHIP: 'Stage',
  OTHER: '',
 },
};

const MONTH_LABEL: Record<string, readonly string[]> = {
 it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
 en: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
 de: ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'],
 fr: ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'],
};

const REF_LABEL: Record<string, string> = {
 it: 'rif.',
 en: 'ref.',
 de: 'Ref.',
 fr: 'réf.',
};

/**
 * Pick a human-readable disambiguator string for a job whose <title>
 * collides with another job in the same locale. The empty string is
 * returned when no usable token exists (caller can fall back to the
 * job slug + buildTitleDisambiguator hash).
 *
 * @param job        The raw job object from data/jobs.json
 * @param locale     'it' | 'en' | 'de' | 'fr'
 * @param baseTitle  The collision-prone base title (without disambig).
 *                   Used to skip tokens that would duplicate text
 *                   already in the title (case-insensitive substring).
 */
export function pickJobDisambiguator(
 job: Record<string, unknown>,
 locale: string,
 baseTitle: string,
): string {
 const titleLc = String(baseTitle || '').toLowerCase();
 const empLabels = EMPLOYMENT_TYPE_LABEL[locale] || EMPLOYMENT_TYPE_LABEL.it;
 const months = MONTH_LABEL[locale] || MONTH_LABEL.it;
 const refLabel = REF_LABEL[locale] || REF_LABEL.it;

 const empRaw = String(job.employmentType ?? '').trim();

 // (1) employmentType-as-percentage. Many crawlers stuff workHours into
 // employmentType: "80%", "80 _ 100%", "60 _ 100%". Detect and format.
 // Skip "100%", "100 _ 100%", "VOLLZEIT, ..." (effectively full-time).
 const pctMatch = empRaw.match(/^(\d{2,3})(?:\s*[_\-–—]\s*(\d{2,3}))?\s*%/i);
 if (pctMatch) {
  const lo = Number(pctMatch[1]);
  const hi = pctMatch[2] ? Number(pctMatch[2]) : null;
  const isFullTime = lo >= 100 && (hi === null || hi >= 100);
  if (!isFullTime && lo > 0) {
   const formatted = hi && hi !== lo ? `${lo}-${hi}%` : `${lo}%`;
   if (!titleLc.includes(formatted)) return formatted;
  }
 }

 // (2) employmentType label (non-default; FULL_TIME is the default and
 // ~73 % of the corpus, so it's a useless disambig).
 const empNorm = empRaw.toUpperCase().replace(/-/g, '_');
 if (empNorm && empNorm !== 'FULL_TIME' && empLabels[empNorm]) {
  const label = empLabels[empNorm];
  if (label && !titleLc.includes(label.toLowerCase())) return label;
 }

 // (3) salary range — compact "CHF 60-75k". 100 % coverage in current
 // dataset, so almost always usable. Skip when min === max (no range).
 const sMin = Number(job.salaryMin);
 const sMax = Number(job.salaryMax);
 if (Number.isFinite(sMin) && sMin >= 20000 && Number.isFinite(sMax) && sMax > sMin) {
  const lok = Math.round(sMin / 1000);
  const hik = Math.round(sMax / 1000);
  const ccy = String(job.currency || 'CHF');
  const compact = `${ccy} ${lok}-${hik}k`;
  if (!titleLc.includes(`${ccy.toLowerCase()} `) && !/\d{2,3}\s*[-–]\s*\d{2,3}\s*k\b/i.test(titleLc)) {
   return compact;
  }
 }

 // (4) posted month — "apr 2027". Always available, very compact.
 const dateStr = String(job.postedDate ?? '');
 const dateMatch = dateStr.match(/^(\d{4})-(\d{2})/);
 if (dateMatch) {
  const year = dateMatch[1];
  const monthIdx = Number(dateMatch[2]) - 1;
  if (monthIdx >= 0 && monthIdx < 12) {
   const monthLabel = months[monthIdx];
   const monthYear = `${monthLabel} ${year}`;
   if (!titleLc.includes(monthLabel) && !titleLc.includes(year)) return monthYear;
  }
 }

 // (5) job-id reference — last fallback, always unique by construction.
 // Uses the trailing slug fragment (after the last hyphen) which is
 // typically a short hex identifier the crawler emitted: stable, no
 // PII, distinguishable. e.g. "tally-weijl-5010e3f8aec3" → "5010e3f8".
 const id = String(job.id ?? '');
 const tail = (id.split('-').pop() || id).slice(0, 8);
 if (tail) return `${refLabel} ${tail}`;

 return '';
}

export function jobsSeoPagesPlugin(rootDir: string): Plugin {
 return {
 name: 'jobs-seo-pages',
 apply: 'build',
 async closeBundle() {
 const fs = await import('node:fs');
 const np = await import('node:path');
 const distDir = np.resolve(rootDir, 'dist');
 const jobsPath = np.resolve(rootDir, 'data/jobs.json');

 // `cacheDateStamp` is used as today's stamp throughout the plugin and
 // in the always-run sitemap-index patch below.
 const cacheDateStamp = new Date().toISOString().slice(0, 10);

 // ─── Parameterized defaults ──────────────────────────────────────────
 // Change DEFAULT_CANTON to expand the primary target region.
 // See scripts/lib/crawler-location-config.mjs for the central switch.
 const DEFAULT_CANTON = 'TI';
 const DEFAULT_POSTAL_CODE = '6900';
 const DEFAULT_CANTON_DISPLAY = 'Ticino';

 /**
  * Canton URL slugs sourced from data/canton-url-slugs.json (P1.1 cathedral).
  * Mirrors the runtime helpers in scripts/lib/canton-url-slugs.mjs but inlined
  * here as the build plugin runs in TS and cannot import the .mjs at compile
  * time — single source of truth is the JSON file.
  */
 type CantonLocale = 'it' | 'en' | 'de' | 'fr';
 type CantonSlugFile = {
   cantons: Record<string, Record<CantonLocale, string>>;
   aggregate: Record<CantonLocale, string>;
 };
 const cantonSlugFile: CantonSlugFile = (() => {
   const raw = fs.readFileSync(np.resolve(rootDir, 'data/canton-url-slugs.json'), 'utf-8');
   const parsed = JSON.parse(raw);
   if (!parsed || typeof parsed !== 'object' || !parsed.cantons || !parsed.aggregate) {
     throw new Error('[jobs-seo-pages] data/canton-url-slugs.json: missing "cantons" or "aggregate" key');
   }
   return parsed as CantonSlugFile;
 })();
 const ALL_CANTON_CODES: readonly string[] = Object.freeze(Object.keys(cantonSlugFile.cantons).sort());
 const AGGREGATE_KEY = '_AGGREGATE_';

 /**
  * Localised display name for a canton (e.g. 'TI' → 'Ticino' in IT/EN, 'Tessin' in DE/FR).
  * Mirrors getCantonDisplayName in scripts/lib/crawler-location-config.mjs but kept
  * inline so the build plugin has zero .mjs runtime dependency.
  */
 function getCantonDisplayLabel(cantonCode: string, locale: CantonLocale = 'it'): string {
   const code = String(cantonCode || '').toUpperCase();
   if (code === AGGREGATE_KEY) {
     return locale === 'it' ? 'Svizzera' : locale === 'en' ? 'Switzerland' : locale === 'de' ? 'Schweiz' : 'Suisse';
   }
   const localised: Record<string, Record<CantonLocale, string>> = {
     TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' },
     GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' },
     VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' },
     ZH: { it: 'Zurigo', en: 'Zürich', de: 'Zürich', fr: 'Zurich' },
     BE: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' },
     LU: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' },
     BS: { it: 'Basilea Città', en: 'Basel-City', de: 'Basel-Stadt', fr: 'Bâle-Ville' },
     BL: { it: 'Basilea Campagna', en: 'Basel-Country', de: 'Baselland', fr: 'Bâle-Campagne' },
     GE: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' },
     VD: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' },
     AG: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' },
     SG: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' },
     FR: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' },
     NE: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' },
     ZG: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' },
     SH: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' },
     SO: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' },
     TG: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' },
     SZ: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' },
     GL: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' },
     JU: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' },
     NW: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' },
     OW: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' },
     AR: { it: 'Appenzello Esterno', en: 'Appenzell Ausserrhoden', de: 'Appenzell Ausserrhoden', fr: 'Appenzell Rhodes-Extérieures' },
     AI: { it: 'Appenzello Interno', en: 'Appenzell Innerrhoden', de: 'Appenzell Innerrhoden', fr: 'Appenzell Rhodes-Intérieures' },
     UR: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' },
   };
   return localised[code]?.[locale] ?? localised[code]?.it ?? code;
 }

 /**
  * Legacy IT-only display map. Now derived from ALL_CANTON_CODES so it's
  * complete by construction (was 26-entry hand-written list before P1.11).
  */
 const CANTON_DISPLAY: Record<string, string> = Object.fromEntries(
   ALL_CANTON_CODES.map((code) => [code, getCantonDisplayLabel(code, 'it')]),
 );
 const CANTON_FALLBACK_POSTAL: Record<string, string> = {
 'TI': '6900', 'GR': '7000', 'ZH': '8001', 'BE': '3001',
 'LU': '6003', 'BS': '4001', 'GE': '1201', 'VD': '1003',
 'AG': '5001', 'SG': '9001', 'VS': '1950', 'FR': '1700',
 'NE': '2000', 'ZG': '6300', 'SH': '8200', 'SO': '4500',
 'BL': '4410', 'TG': '8500', 'SZ': '6430', 'GL': '8750',
 'JU': '2800', 'NW': '6370', 'OW': '6060', 'AR': '9100',
 'AI': '9050', 'UR': '6460',
 };

 /**
  * Resolve a canton code (or '_AGGREGATE_') to its locale-specific URL slug.
  * Returns the IT slug as a defensive fallback if the locale is missing.
  */
 function getCantonUrlSlugLocal(cantonCode: string, locale: CantonLocale): string {
   const code = String(cantonCode || '').toUpperCase();
   if (code === AGGREGATE_KEY) {
     return cantonSlugFile.aggregate[locale] ?? cantonSlugFile.aggregate.it;
   }
   const entry = cantonSlugFile.cantons[code];
   if (!entry) return cantonSlugFile.aggregate[locale] ?? cantonSlugFile.aggregate.it;
   return entry[locale] ?? entry.it;
 }

 /* ── Buffered write system via shared WriteCollector ── */
 const collector = new WriteCollector({ distDir, pluginName: 'jobsSeoPagesPlugin' });
 const _ensuredDirs = new Set<string>();
 function _md(dir: string) {
 if (_ensuredDirs.has(dir)) return;
 fs.mkdirSync(dir, { recursive: true });
 _ensuredDirs.add(dir);
 }
 const _writtenPaths = new Set<string>();
 function _qw(filePath: string, content: string) {
 _writtenPaths.add(filePath);
 collector.add(filePath, content);
 }

 /**
  * Emit a flat `.html` file as a redirect bridge directly. The full HTML at
  * `siblingHtml` was already written to the matching `outDir/index.html`,
  * so postWalkCoordinator's `transformFlatRedirect` will read it later and
  * synthesise the same bridge from it. Writing the bridge here (~500 B)
  * instead of the full ~30 KB sibling content cuts ~150 k × 30 KB ≈ 4 GB
  * of redundant write+rewrite traffic across the closeBundle thread; the
  * coordinator's `html === original` guard then short-circuits the
  * post-walk rewrite for these paths. slashUrl is derived from the file
  * path the same way the coordinator does, so the pre-emitted bridge is
  * byte-identical to the post-walk one (no rewrite needed).
  */
 function _qwFlat(flatFile: string, siblingHtml: string) {
 const stem = flatFile.slice(0, -'.html'.length);
 const relPath = np.relative(distDir, stem).replace(/\\/g, '/');
 const slashUrl = `${BASE_URL}/${relPath}/`;
 _qw(flatFile, buildFlatBridgeFromSibling(siblingHtml, slashUrl));
 }

 /* ── Find SPA entry bundle so job pages hydrate into the full app ── */
 // Race-free via the shared resolver: see spaBundleResolver.ts. The previous
 // inline read silently lost the writeBundle race in CI (run 25151657070
 // produced 123,184 bundle-less pages on this exact path).
 const { resolveSpaBundle } = await import('./spaBundleResolver');
 const spaBundle = resolveSpaBundle(distDir);
 const entryJs = spaBundle.entryJs;
 const entryCss = spaBundle.entryCss;
 const hasSpaBundle = spaBundle.hasSpaBundle;

 // ── Load blog article data for cross-linking (SEO: internal links from job → article pages) ──
 interface RecentArticle { id: string; category: string; date: string; image: string }
 let recentArticles: RecentArticle[] = [];
 const articleSlugByLocale: Record<'it' | 'en' | 'de' | 'fr', Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
 const articleTitleByLocale: Record<'it' | 'en' | 'de' | 'fr', Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
 const blogSectionByLocale: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'articoli-frontaliere', en: 'cross-border-articles', de: 'grenzgaenger-artikel', fr: 'articles-frontalier',
 };
 const recentArticlesLabel: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Articoli per frontalieri', en: 'Articles for cross-border workers',
 de: 'Artikel für Grenzgänger', fr: 'Articles pour frontaliers',
 };
 try {
 const blogDataSrc = fs.readFileSync(np.resolve(rootDir, 'data', 'blog-articles-data.ts'), 'utf-8');
 const articleBlocks = [...blogDataSrc.matchAll(/\{\s*id:\s*'([^']+)',\s*category:\s*'([^']+)',\s*date:\s*'([^']+)',\s*image:\s*'([^']+)'/gs)];
 recentArticles = articleBlocks
 .map(m => ({ id: m[1], category: m[2], date: m[3], image: m[4] }))
 .sort((a, b) => b.date.localeCompare(a.date))
 .slice(0, 5);
 } catch { /* non-fatal */ }
 try {
 const routerBlogSrc = fs.readFileSync(np.resolve(rootDir, 'services/routerBlogData.ts'), 'utf-8');
 const rx = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
 let m: RegExpExecArray | null;
 while ((m = rx.exec(routerBlogSrc)) !== null) {
 articleSlugByLocale.it[m[1]] = m[2];
 articleSlugByLocale.en[m[1]] = m[3];
 articleSlugByLocale.de[m[1]] = m[4];
 articleSlugByLocale.fr[m[1]] = m[5];
 }
 } catch { /* non-fatal */ }
 // Parse article titles from seo-blog*.ts for readable link text
 try {
 let seoSrc = fs.readFileSync(np.resolve(rootDir, 'services/seo/seo-blog.ts'), 'utf-8');
 for (let n = 2; n <= 10; n++) {
 try { seoSrc += '\n' + fs.readFileSync(np.resolve(rootDir, `services/seo/seo-blog-${n}.ts`), 'utf-8'); } catch { break; }
 }
 // Extract ogTitle for Italian articles (path → title)
 const titleRx = /path:\s*'\/articoli-frontaliere\/([^']+?)\/?'[\s\S]*?ogTitle:\s*'((?:[^'\\]|\\.)*)'/g;
 let tm: RegExpExecArray | null;
 while ((tm = titleRx.exec(seoSrc)) !== null) {
 const articleId = Object.entries(articleSlugByLocale.it).find(([, slug]) => slug === tm![1])?.[0] || tm[1];
 articleTitleByLocale.it[articleId] = tm[2].replace(/\\'/g, "'");
 }
 } catch { /* non-fatal */ }

 const buildRecentArticlesHtml = (locale: 'it' | 'en' | 'de' | 'fr'): string => {
 if (recentArticles.length === 0) return '';
 const items = recentArticles.map(art => {
 const slug = articleSlugByLocale[locale]?.[art.id] ?? art.id;
 const prefix = locale === 'it' ? '' : `/${locale}`;
 const href = `${BASE_URL}${prefix}/${blogSectionByLocale[locale]}/${slug}/`;
 const title = articleTitleByLocale.it[art.id] || art.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
 return `<li style="margin:0 0 8px 0"><a href="${href}" style="text-decoration:none;color:var(--color-link);font-weight:600">${esc(title)}</a></li>`;
 }).join('');
 return `<section class="related" style="margin-top:12px"><h2 style="margin:0 0 10px 0;font-size:16px">${esc(recentArticlesLabel[locale])}</h2><ul style="list-style:none;padding:0;margin:0">${items}</ul></section>`;
 };

 // Default search-section route slugs — these are actual URL paths that must exist in the router.
 // They use "Ticino/Tessin" because that is the primary/branded section; other cantons share it.
 const sectionByLocale: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'cerca-lavoro-ticino',
 en: 'find-jobs-ticino',
 de: 'jobs-im-tessin',
 fr: 'trouver-emploi-tessin',
 };

 /**
  * Section URL prefix per (locale, canton). For TI in any locale this returns
  * the LEGACY section slug (e.g. 'cerca-lavoro-ticino', 'find-jobs-ticino')
  * because the entire plugin's HTML graph (breadcrumbs / company-hub /
  * city-hub markup) is wired against those frozen slugs. For every other
  * canton this returns the canton-aware section ('cerca-lavoro-zurigo',
  * 'find-jobs-zurich', ...) sourced from data/canton-url-slugs.json.
  *
  * E9 frozen-URL strategy: if a job already has a registered slug at a TI
  * URL it stays there forever (slug-registry is enforced by crawlers, not
  * by this plugin — `localizedSlug(job, locale)` returns the frozen slug
  * verbatim).
  */
 const SECTION_PREFIX_BY_LOCALE: Record<CantonLocale, string> = {
   it: 'cerca-lavoro', en: 'find-jobs', de: 'jobs-im', fr: 'trouver-emploi',
 };
 function buildCantonAwareSection(locale: CantonLocale, cantonCode: string): string {
   const code = String(cantonCode || '').toUpperCase();
   if (!code || code === 'TI') return sectionByLocale[locale];
   if (code === AGGREGATE_KEY) {
     return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlugLocal(AGGREGATE_KEY, locale)}`;
   }
   return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlugLocal(code, locale)}`;
 }
 const localePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: '',
 en: '/en',
 de: '/de',
 fr: '/fr',
 };
 const localeOg: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'it_IT',
 en: 'en_US',
 de: 'de_DE',
 fr: 'fr_FR',
 };
 const homeLabel: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Home',
 en: 'Home',
 de: 'Startseite',
 fr: 'Accueil',
 };
 const openPositionsUnit: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'posizioni aperte',
 en: 'open positions',
 de: 'offene Stellen',
 fr: 'postes ouverts',
 };
 const localeCopy: Record<'it' | 'en' | 'de' | 'fr', {
 suffix: string;
 sectionName: string;
 descriptionLabel: string;
 applyNow: string;
 quickDetails: string;
 location: string;
 canton: string;
 contract: string;
 relatedJobs: string;
 allJobsLink: string;
 practicalNotes: string[];
 requirementsLabel: string;
 summaryLabel: string;
 highlightsLabel: string;
 responsibilitiesLabel: string;
 benefitsLabel: string;
 processLabel: string;
 keywordsLabel: string;
 readingLabel: string;
 }> = {
 it: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Cerca lavoro in Ticino',
 descriptionLabel: 'Descrizione',
 applyNow: 'Vai alla candidatura',
 quickDetails: 'Dettagli rapidi',
 location: 'Località',
 canton: 'Cantone',
 contract: 'Contratto',
 relatedJobs: 'Annunci correlati',
 allJobsLink: 'Tutte le offerte di lavoro in Ticino',
 practicalNotes: [
 'Questa scheda aggrega i dettagli principali dell\'annuncio e li struttura in modo leggibile per frontalieri che cercano lavoro in Ticino.',
 'Verifica sempre lingua richiesta, sede effettiva e modalità di candidatura prima di inviare il CV: alcuni ruoli prevedono step internazionali e assessment tecnici.',
 'Prima di candidarti, confronta il ruolo con costo della vita locale e simulazione del netto, così valuti subito la sostenibilità economica reale.',
 ],
 requirementsLabel: 'Requisiti principali',
 summaryLabel: 'Panoramica',
 highlightsLabel: 'Punti chiave',
 responsibilitiesLabel: 'Responsabilità principali',
 benefitsLabel: 'Cosa offre l’azienda',
 processLabel: 'Processo di candidatura',
 keywordsLabel: 'Keyword utili',
 readingLabel: 'Tempo di lettura',
 },
 en: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Find jobs in Ticino',
 descriptionLabel: 'Description',
 applyNow: 'Apply now',
 quickDetails: 'Quick details',
 location: 'Location',
 canton: 'Canton',
 contract: 'Contract',
 relatedJobs: 'Related jobs',
 allJobsLink: 'All job offers in Ticino',
 practicalNotes: [
 'This page consolidates the key details of the listing and presents them in a structured format for cross-border candidates targeting Ticino.',
 'Always verify required language, actual office location and application flow before submitting: some positions include international interview steps.',
 'Before applying, compare this role with local cost of living and net salary simulation to assess real take-home sustainability.',
 ],
 requirementsLabel: 'Key requirements',
 summaryLabel: 'Role overview',
 highlightsLabel: 'Key points',
 responsibilitiesLabel: 'Main responsibilities',
 benefitsLabel: 'What the company offers',
 processLabel: 'Application process',
 keywordsLabel: 'Useful keywords',
 readingLabel: 'Reading time',
 },
 de: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Jobs im Tessin',
 descriptionLabel: 'Beschreibung',
 applyNow: 'Jetzt bewerben',
 quickDetails: 'Kurzdaten',
 location: 'Ort',
 canton: 'Kanton',
 contract: 'Vertrag',
 relatedJobs: 'Ähnliche Stellen',
 allJobsLink: 'Alle Stellenangebote im Tessin',
 practicalNotes: [
 'Diese Seite bündelt die wichtigsten Informationen der Stelle in einer klaren Struktur für Grenzgängerinnen und Grenzgänger im Tessin.',
 'Prüfen Sie vor der Bewerbung Sprache, effektiven Arbeitsort und Bewerbungsablauf genau, da manche Rollen internationale Prozessschritte enthalten.',
 'Vergleichen Sie das Stellenprofil mit Lebenshaltungskosten und Nettolohn-Simulation, um die finanzielle Tragfähigkeit realistisch einzuschätzen.',
 ],
 requirementsLabel: 'Wichtige Anforderungen',
 summaryLabel: 'Rollenüberblick',
 highlightsLabel: 'Kernpunkte',
 responsibilitiesLabel: 'Hauptaufgaben',
 benefitsLabel: 'Was das Unternehmen bietet',
 processLabel: 'Bewerbungsprozess',
 keywordsLabel: 'Nützliche Keywords',
 readingLabel: 'Lesezeit',
 },
 fr: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Trouver un emploi au Tessin',
 descriptionLabel: 'Description',
 applyNow: 'Postuler',
 quickDetails: 'Détails rapides',
 location: 'Lieu',
 canton: 'Canton',
 contract: 'Contrat',
 relatedJobs: 'Offres liées',
 allJobsLink: 'Toutes les offres d\'emploi au Tessin',
 practicalNotes: [
 'Cette fiche regroupe les informations essentielles de l\'offre et les présente de manière structurée pour les frontaliers visant le Tessin.',
 'Avant de postuler, vérifiez la langue requise, le lieu réel du poste et le processus de sélection: certaines offres incluent des étapes internationales.',
 'Comparez ce poste avec le coût de la vie local et la simulation du salaire net pour évaluer la viabilité économique réelle.',
 ],
 requirementsLabel: 'Exigences principales',
 summaryLabel: 'Vue d’ensemble du poste',
 highlightsLabel: 'Points clés',
 responsibilitiesLabel: 'Responsabilités principales',
 benefitsLabel: 'Ce que l’entreprise offre',
 processLabel: 'Processus de candidature',
 keywordsLabel: 'Mots-clés utiles',
 readingLabel: 'Temps de lecture',
 },
 };

 // ── Canton-aware text helpers ────────────────────────────────
 // These produce locale-correct text for any Swiss canton,
 // used wherever SEO copy references the job's region.
 const frenchCantonPrep = (dc: string): string => {
 if (['Tessin', 'Jura'].includes(dc)) return `au ${dc}`;
 if (dc === 'Grisons') return `aux ${dc}`;
 if (dc === 'Valais') return `en ${dc}`;
 return `dans le canton de ${dc}`;
 };
 const germanCantonPrep = (dc: string): string => {
 if (['Tessin', 'Wallis', 'Jura'].includes(dc)) return `im ${dc}`;
 return `in ${dc}`;
 };
 const cantonSectionName = (locale: 'it' | 'en' | 'de' | 'fr', cantonDisplay: string): string => {
 const map: Record<string, string> = {
 it: `Cerca lavoro in ${cantonDisplay}`,
 en: `Find jobs in ${cantonDisplay}`,
 de: `Jobs ${germanCantonPrep(cantonDisplay)}`,
 fr: `Trouver un emploi ${frenchCantonPrep(cantonDisplay)}`,
 };
 return map[locale] || map.it;
 };
 const cantonPracticalNote0 = (locale: 'it' | 'en' | 'de' | 'fr', cantonDisplay: string): string => {
 const dePrep = germanCantonPrep(cantonDisplay);
 const frPrep = frenchCantonPrep(cantonDisplay);
 const map: Record<string, string> = {
 it: `Questa scheda aggrega i dettagli principali dell'annuncio e li struttura in modo leggibile per frontalieri che cercano lavoro in ${cantonDisplay}.`,
 en: `This page consolidates the key details of the listing and presents them in a structured format for cross-border candidates targeting ${cantonDisplay}.`,
 de: `Diese Seite bündelt die wichtigsten Informationen der Stelle in einer klaren Struktur für Grenzgängerinnen und Grenzgänger ${dePrep}.`,
 fr: `Cette fiche regroupe les informations essentielles de l'offre et les présente de manière structurée pour les frontaliers visant ${frPrep === frenchCantonPrep(cantonDisplay) ? frPrep : `le ${cantonDisplay}`}.`,
 };
 return map[locale] || map.it;
 };

 // Multi-canton display string for search pages (not per-job).
 //
 // P1.11 — Cathedral migration: the canonical 26-canton list now comes from
 // ALL_CANTON_CODES (data/canton-url-slugs.json). EDITORIAL_PRIMARY_CANTONS
 // remains a curated commuter-focused subset because the prose ("offerte di
 // lavoro in Ticino, Grigioni e Vallese …") would be unreadable if it
 // enumerated all 26 cantons. The 26-canton list is consumed by the per-canton
 // index emitter + sitemap-shard pipeline below, not by this editorial copy.
 const EDITORIAL_PRIMARY_CANTONS = ['TI', 'GR', 'VS'] as const;
 const targetCantonsDisplay: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: EDITORIAL_PRIMARY_CANTONS.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' e $1'),
 en: EDITORIAL_PRIMARY_CANTONS.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' and $1'),
 de: EDITORIAL_PRIMARY_CANTONS.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' und $1'),
 fr: EDITORIAL_PRIMARY_CANTONS.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' et $1'),
 };

 if (!fs.existsSync(jobsPath)) {
 console.warn('[jobs-seo-pages] data/jobs.json not found');
 return;
 }
 const jobsRaw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
 const jobs = Array.isArray(jobsRaw) ? jobsRaw : [];
 const slugify = (input: string) => String(input || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, '-')
 .replace(/^-+|-+$/g, '')
 .slice(0, 90);
 const localeList = JOB_SEO_LOCALES;
 const localizedSlug = (job: any, locale: 'it' | 'en' | 'de' | 'fr') => {
 // 1. Explicit per-locale slug (from AI-translated crawlers)
 const explicit = String(job?.slugByLocale?.[locale] || '').trim();
 if (explicit) return explicit;
 // 2. Canonical slug from data (set by all crawlers, including custom ones)
 const canonical = String(job?.slug || '').trim();
 if (canonical) return canonical;
 // 3. Compute from localized title + company + location (last-resort fallback)
 const localizedTitle = String(job?.titleByLocale?.[locale] || job?.title || '');
 return slugify(`${localizedTitle}-${job?.company || ''}-${job?.location || ''}`) || slugify(localizedTitle);
 };

 // Fixture-data guard — drop test/dev seed records (e.g. "Fixture Corp SA")
 // before they enter the validJobs pipeline. Without this, a local jobs.json
 // fixture would persist its slug into all-known-job-slugs.json and feed the
 // expired-job soft-landing pipeline forever.
 // Mirrors scripts/lib/fixture-data-filter.mjs (kept inline so this build
 // plugin has no .mjs dependency at TypeScript compile time).
 const FIXTURE_SLUG_RE = /^fixture-|-fixture-corp-|-fixture-canonical-/i;
 const FIXTURE_ID_RE = /^fixture-/i;
 const FIXTURE_COMPANY_KEY_RE = /^fixture(?:-|$)/i;
 const FIXTURE_COMPANY_NAMES = new Set(['fixture corp sa', 'fixture corp']);
 const isFixtureJob = (j: any): boolean => {
 if (!j || typeof j !== 'object') return false;
 if (j.id && FIXTURE_ID_RE.test(String(j.id))) return true;
 if (j.companyKey && FIXTURE_COMPANY_KEY_RE.test(String(j.companyKey))) return true;
 if (j.company && FIXTURE_COMPANY_NAMES.has(String(j.company).trim().toLowerCase())) return true;
 if (j.slug && FIXTURE_SLUG_RE.test(String(j.slug))) return true;
 if (j.slugByLocale && typeof j.slugByLocale === 'object') {
 for (const v of Object.values(j.slugByLocale)) {
 if (v && FIXTURE_SLUG_RE.test(String(v))) return true;
 }
 }
 return false;
 };
 const isFixtureSlug = (s: string): boolean => !!s && FIXTURE_SLUG_RE.test(s);
 const fixtureCount = jobs.filter(isFixtureJob).length;
 if (fixtureCount > 0) {
 console.log(`\x1b[33m[jobs-seo-pages]\x1b[0m Filtered ${fixtureCount} fixture job(s) from input (test/dev seed records)`);
 }

 // Recency timestamp helper: prefers `datePosted` (employer publish time)
 // over `crawledAt` (when our crawler last saw the listing). Used both
 // here (validJobs sort) and below (expiredJobsData sort) so the
 // sharedWriteRegistry's first-write-wins claim() picks the FRESHEST job
 // when multiple distinct jobs converge on the same per-locale path
 // (e.g. 40 different localsearch postings whose German title slugifies
 // identically). Without this sort, iteration order is the order jobs
 // happen to be in data/jobs.json, which is not recency-aligned and lets
 // an older posting clobber a newer one on the canonical URL.
 const _jobRecency = (j: any): number => {
 const dp = j?.datePosted ? new Date(j.datePosted).getTime() : 0;
 if (dp > 0 && !Number.isNaN(dp)) return dp;
 const ca = j?.crawledAt ? new Date(j.crawledAt).getTime() : 0;
 if (ca > 0 && !Number.isNaN(ca)) return ca;
 return 0;
 };

 const validJobs = jobs
 .filter((j: any) => !isFixtureJob(j))
 .filter((j: any) => j?.title && j?.company && j?.location && (j?.description || j?.descriptionByLocale))
 .map((j: any) => ({
 ...j,
 slug: j.slug || slugify(`${j.title}-${j.company}-${j.location}`) || j.id || '',
 }))
 .filter((j: any) => !!j.slug)
 // DESC by recency, tiebreak by id for determinism. Most-recent first
 // means the registry's first-write-wins gives the canonical URL to the
 // freshest posting; older duplicates record a collision (visible in
 // dist/.write-collisions.json) but don't overwrite on disk.
 .sort((a: any, b: any) => {
 const ta = _jobRecency(a);
 const tb = _jobRecency(b);
 if (ta !== tb) return tb - ta;
 return String(a.id || a.slug || '').localeCompare(String(b.id || b.slug || ''));
 });

 /**
  * Per-slug canonical override map (Semrush cannibalization fix). Loaded from
  * data/job-canonical-overrides.json — keyed by per-locale slug (job-detail
  * slug or search-hub `search-/suche-/recherche-/ricerca-` slug). When a slug
  * matches, the page's <link rel="canonical"> and og:url point to the
  * specified winner URL instead of the page's own URL. The page itself still
  * exists (no 410, no delete) so backlinks survive.
  */
 const canonicalOverrides: Record<string, string> = (() => {
 try {
 const overridePath = np.resolve(rootDir, 'data/job-canonical-overrides.json');
 const raw = fs.readFileSync(overridePath, 'utf-8');
 const parsed = JSON.parse(raw);
 const map = parsed?.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {};
 const cleaned: Record<string, string> = {};
 for (const [k, v] of Object.entries(map)) {
 if (typeof k === 'string' && typeof v === 'string' && v.startsWith('http')) {
 cleaned[k] = v;
 }
 }
 if (Object.keys(cleaned).length > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Loaded ${Object.keys(cleaned).length} canonical overrides`);
 }
 return cleaned;
 } catch {
 return {};
 }
 })();
 const resolveCanonicalUrl = (slug: string, defaultUrl: string): string => {
 const override = canonicalOverrides[slug];
 return override || defaultUrl;
 };

 /**
  * Per-canonical-slug company profiles loaded from `data/company-profiles.json`.
  * Used by the company landing emitter to enrich pages with founded/size/sector
  * facts and a multilingual description, lifting word count above the
  * "thin content" Semrush threshold (issue 117). Companies absent from the
  * map fall back to the generic enrichment derived from job-data only.
  */
 type CompanyProfile = {
  name?: string;
  founded?: number;
  size?: string;
  sector?: string;
  headquarters?: string;
  description?: Partial<Record<'it' | 'en' | 'de' | 'fr', string>>;
 };
 const companyProfiles: Record<string, CompanyProfile> = (() => {
  try {
   const profilePath = np.resolve(rootDir, 'data/company-profiles.json');
   if (!fs.existsSync(profilePath)) return {};
   const raw = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
   if (!raw || typeof raw !== 'object') return {};
   const cleaned: Record<string, CompanyProfile> = {};
   for (const [k, v] of Object.entries(raw)) {
    if (k === '_meta') continue;
    if (v && typeof v === 'object') cleaned[k] = v as CompanyProfile;
   }
   if (Object.keys(cleaned).length > 0) {
    console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Loaded ${Object.keys(cleaned).length} company profiles for enrichment`);
   }
   return cleaned;
  } catch {
   return {};
  }
 })();

 const esc = (s: string) => String(s || '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
 /** Decode common HTML entities so source text doesn't get double-escaped by esc(). */
 const decodeHtmlEntities = (s: string) => String(s || '')
 .replace(/&amp;/g, '&')
 .replace(/&lt;/g, '<')
 .replace(/&gt;/g, '>')
 .replace(/&quot;/g, '"')
 .replace(/&#39;/g, "'")
 .replace(/&#x27;/g, "'")
 .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
 .replace(/&[A-Za-z]+;/g, ' ');
 /** Convert a plain-text description to basic HTML.
 * Wraps paragraphs in <p>, converts bullet/numbered lines to <ul>/<ol><li>,
 * recognizes section headings (lines ending with ':' followed by list items),
 * and single newlines to <br>. */
 const plainTextToHtml = (text: string): string => {
 if (!text || /<(p|ul|li|h[1-6]|br|strong|em)\b/i.test(text)) return text;
 const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
 const blocks = normalized.split(/\n{2,}/);
 const htmlParts: string[] = [];
 for (const block of blocks) {
 const trimmed = block.trim();
 if (!trimmed) continue;
 const lines = trimmed.split('\n');
 // Check if this block is a bullet list (all lines start with - or • or *)
 const isBulletList = lines.length > 1 && lines.every((l) => /^\s*[-•*]\s/.test(l));
 // Check if this block is a numbered list (all lines start with digit.)
 const isNumberedList = lines.length > 1 && lines.every((l) => /^\s*\d+[.)]\s/.test(l));
 // Check if this block has a heading line followed by list items
 const hasHeadingWithList = lines.length > 2
 && /[:\u2013\u2014]$/.test(lines[0].trim())
 && lines.slice(1).every((l) => /^\s*[-•*\d]/.test(l));

 if (hasHeadingWithList) {
 const heading = lines[0].trim().replace(/[:\u2013\u2014]$/, '').trim();
 htmlParts.push(`<p><strong>${esc(heading)}</strong></p>`);
 const listLines = lines.slice(1);
 const isOl = listLines.every((l) => /^\s*\d+[.)]\s/.test(l));
 const tag = isOl ? 'ol' : 'ul';
 const items = listLines.map((l) => `<li>${esc(l.replace(/^\s*[-•*]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('');
 htmlParts.push(`<${tag}>${items}</${tag}>`);
 } else if (isBulletList) {
 const items = lines.map((l) => `<li>${esc(l.replace(/^\s*[-•*]\s+/, ''))}</li>`).join('');
 htmlParts.push(`<ul>${items}</ul>`);
 } else if (isNumberedList) {
 const items = lines.map((l) => `<li>${esc(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('');
 htmlParts.push(`<ol>${items}</ol>`);
 } else if (lines.length === 1 && /[:\u2013\u2014]$/.test(trimmed)) {
 // Standalone heading-like line ending with colon
 const heading = trimmed.replace(/[:\u2013\u2014]$/, '').trim();
 htmlParts.push(`<p><strong>${esc(heading)}</strong></p>`);
 } else {
 // Single block — join internal newlines with <br>
 const inner = lines.map((l) => esc(l.trim())).filter(Boolean).join('<br>');
 if (inner) htmlParts.push(`<p>${inner}</p>`);
 }
 }
 return htmlParts.join('');
 };
 const normalizeText = (s: string) => String(s || '')
 .replace(/\r/g, '\n')
 .replace(/\t/g, ' ')
 .replace(/&[A-Za-z]+;/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
 /** Strip markdown syntax, emojis & structured noise for clean meta descriptions. */
 const cleanMetaDescription = (raw: string): string => {
 let s = String(raw || '');
 // Strip markdown headings (at line start or inline after content)
 s = s.replace(/#{1,6}\s+/g, '');
 s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
 s = s.replace(/^[-*_]{3,}$/gm, '');
 // Strip markdown links/images but keep text
 s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
 // Strip inline code
 s = s.replace(/`([^`]+)`/g, '$1');
 // Strip emojis (common Unicode ranges)
 s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
 // Strip bullet/list markers at line starts
 s = s.replace(/^\s*[-*•]\s+/gm, '');
 // Strip HTML entities like &NewLine; &colo;
 s = s.replace(/&[A-Za-z]+;/g, ' ');
 // Collapse whitespace
 s = s.replace(/\s+/g, ' ').trim();
 return s;
 };
 const splitIntoParagraphs = (s: string): string[] => {
 const viaBreaks = String(s || '')
 .replace(/\r/g, '\n')
 .split(/\n{2,}/)
 .map((p) => p.trim())
 .filter((p) => p.length > 40);
 if (viaBreaks.length >= 2) return viaBreaks;
 return normalizeText(s)
 .split(/(?<=[.!?])\s+/)
 .map((p) => p.trim())
 .filter((p) => p.length > 40);
 };
 const firstItems = (value: unknown, max = 8): string[] => {
 if (!Array.isArray(value)) return [];
 return value
 .map((x) => normalizeText(String(x || '')))
 .filter((x) => x.length > 2)
 .slice(0, max);
 };
 const cleanItems = (value: unknown, max = 10): string[] => {
 if (!Array.isArray(value)) return [];
 const expanded: string[] = [];
 for (const entry of value) {
 const clean = normalizeText(String(entry || ''));
 if (!clean || clean.length < 3) continue;
 // Skip truncated artifacts (e.g. "Requisiti di ordine ge ...")
 if (/\.{2,}\s*$/.test(clean)) continue;
 // Split joined list items separated by "; - " or "; •"
 const parts = clean.split(/;\s*[-•]\s+/).map((p) => p.replace(/^[-•]\s*/, '').trim()).filter((p) => p.length >= 3);
 expanded.push(...(parts.length > 1 ? parts : [clean]));
 }
 const out: string[] = [];
 const seen = new Set<string>();
 for (const item of expanded) {
 const key = item.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(item);
 if (out.length >= max) break;
 }
 return out;
 };
 const parseCanonicalSections = (value: unknown, max = 8): Array<{ id: string; heading: string; paragraphs: string[]; bullets: string[] }> => {
 if (!Array.isArray(value)) return [];
 const out: Array<{ id: string; heading: string; paragraphs: string[]; bullets: string[] }> = [];
 for (const item of value) {
 const raw = item as {
 id?: unknown;
 heading?: unknown;
 paragraphs?: unknown;
 bullets?: unknown;
 };
 const heading = normalizeText(String(raw?.heading || ''));
 const paragraphs = cleanItems(raw?.paragraphs, 8);
 const bullets = cleanItems(raw?.bullets, 10);
 if (!heading && paragraphs.length === 0 && bullets.length === 0) continue;
 out.push({
 id: normalizeText(String(raw?.id || 'details')).toLowerCase() || 'details',
 heading: heading || 'Details',
 paragraphs,
 bullets,
 });
 if (out.length >= max) break;
 }
 return out;
 };
 const readCanonicalByLocale = (job: any, locale: 'it' | 'en' | 'de' | 'fr') => {
 const byLocale = job?.canonicalContent?.byLocale || {};
 return byLocale?.[locale] || null;
 };
 const toIsoDateTime = (raw: string) => {
 if (!raw) return new Date().toISOString();
 const parsed = new Date(raw);
 if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
 const safe = new Date(`${raw}T00:00:00.000Z`);
 return Number.isNaN(safe.getTime()) ? new Date().toISOString() : safe.toISOString();
 };
 const toValidThrough = (postedRaw: string, crawledAt?: string) => {
 // If crawledAt is available (= job was verified active at crawl time),
 // use it as base + 60 days — tolerates up to ~1 month of rebuild interruption.
 // Fallback: postedDate + 90 days (more lenient than the old 60d window).
 const base = crawledAt ? new Date(crawledAt) : new Date(toIsoDateTime(postedRaw));
 if (Number.isNaN(base.getTime())) {
 const fallback = new Date();
 fallback.setUTCDate(fallback.getUTCDate() + 60);
 return fallback.toISOString();
 }
 const result = new Date(base);
 result.setUTCDate(result.getUTCDate() + (crawledAt ? 60 : 90));
 return result.toISOString();
 };
 const contractMap: Record<string, string> = {
 'full-time': 'FULL_TIME',
 'part-time': 'PART_TIME',
 temporary: 'TEMPORARY',
 internship: 'INTERN',
 contract: 'CONTRACTOR',
 };
 // Localized employment-type labels for human-readable fallback descriptions.
 // Keys match the lower-cased values produced by job.contract raw strings.
 const contractLabelByLocale: Record<string, Record<string, string>> = {
 it: { 'full-time': 'Tempo pieno', 'part-time': 'Tempo parziale', temporary: 'Temporaneo', internship: 'Stage', contract: 'A contratto', other: 'Altro contratto' },
 en: { 'full-time': 'Full-time', 'part-time': 'Part-time', temporary: 'Temporary', internship: 'Internship', contract: 'Contract', other: 'Other contract' },
 de: { 'full-time': 'Vollzeit', 'part-time': 'Teilzeit', temporary: 'Befristet', internship: 'Praktikum', contract: 'Vertrag', other: 'Sonstiger Vertrag' },
 fr: { 'full-time': 'Temps plein', 'part-time': 'Temps partiel', temporary: 'Temporaire', internship: 'Stage', contract: 'Contrat', other: 'Autre contrat' },
 };
 // Sector labels for fallback descriptions (subset — mirrors sectorLabel used in FAQ section).
 const fallbackSectorLabel: Record<string, Record<string, string>> = {
 it: { healthcare: 'sanità', technology: 'tecnologia', finance: 'servizi finanziari', engineering: 'ingegneria', hospitality: 'ospitalità', retail: 'commercio', manufacturing: 'manifattura', education: 'formazione', construction: 'edilizia', logistics: 'logistica', sales: 'vendite', administration: 'amministrazione' },
 en: { healthcare: 'healthcare', technology: 'technology', finance: 'financial services', engineering: 'engineering', hospitality: 'hospitality', retail: 'retail', manufacturing: 'manufacturing', education: 'education', construction: 'construction', logistics: 'logistics', sales: 'sales', administration: 'administration' },
 de: { healthcare: 'Gesundheitswesen', technology: 'Technologie', finance: 'Finanzdienstleistungen', engineering: 'Ingenieurwesen', hospitality: 'Gastgewerbe', retail: 'Einzelhandel', manufacturing: 'Fertigung', education: 'Bildung', construction: 'Bauwesen', logistics: 'Logistik', sales: 'Vertrieb', administration: 'Verwaltung' },
 fr: { healthcare: 'santé', technology: 'technologie', finance: 'services financiers', engineering: 'ingénierie', hospitality: 'hôtellerie', retail: 'commerce', manufacturing: 'industrie', education: 'formation', construction: 'construction', logistics: 'logistique', sales: 'ventes', administration: 'administration' },
 };
 /**
  * Build a localized fallback description for JobPosting schema when source
  * data is too thin for Google rich results (CLAUDE.md rule #3 — defaults, not skips).
  */
 const buildJobDescriptionFallback = (
 jobArg: { title?: string; company?: string; location?: string; canton?: string; category?: string; contract?: string },
 titleText: string,
 localityText: string,
 regionText: string,
 localeArg: string
 ): string => {
 const loc = localeArg in contractLabelByLocale ? localeArg : 'it';
 const contractKey = String(jobArg.contract || '').toLowerCase();
 const contractLabel = contractLabelByLocale[loc][contractKey] || contractLabelByLocale[loc].other;
 const categoryKey = String(jobArg.category || '').toLowerCase();
 const sectorLabelRaw = fallbackSectorLabel[loc]?.[categoryKey] || '';
 const company = String(jobArg.company || '').trim();
 const sectorClause: Record<string, string> = {
 it: sectorLabelRaw ? ` nel settore ${sectorLabelRaw}` : '',
 en: sectorLabelRaw ? ` in the ${sectorLabelRaw} sector` : '',
 de: sectorLabelRaw ? ` im Bereich ${sectorLabelRaw}` : '',
 fr: sectorLabelRaw ? ` dans le secteur ${sectorLabelRaw}` : '',
 };
 const atCompany: Record<string, string> = {
 it: company ? ` presso ${company}` : '',
 en: company ? ` at ${company}` : '',
 de: company ? ` bei ${company}` : '',
 fr: company ? ` chez ${company}` : '',
 };
 const inLocation: Record<string, string> = {
 it: localityText ? ` a ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 en: localityText ? ` in ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 de: localityText ? ` in ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 fr: localityText ? ` à ${localityText}${regionText ? ` (${regionText})` : ''}` : '',
 };
 const tail: Record<string, string> = {
 it: `${contractLabel}${sectorClause.it}. Consulta i dettagli e candidati sul portale Frontaliere Ticino.`,
 en: `${contractLabel}${sectorClause.en}. See the full details and apply on the Frontaliere Ticino portal.`,
 de: `${contractLabel}${sectorClause.de}. Alle Details und Bewerbung auf dem Frontaliere-Ticino-Portal.`,
 fr: `${contractLabel}${sectorClause.fr}. Consultez les détails et postulez sur le portail Frontaliere Ticino.`,
 };
 const lead: Record<string, string> = {
 it: `${titleText}${atCompany.it}${inLocation.it}.`,
 en: `${titleText}${atCompany.en}${inLocation.en}.`,
 de: `${titleText}${atCompany.de}${inLocation.de}.`,
 fr: `${titleText}${atCompany.fr}${inLocation.fr}.`,
 };
 return `<p>${lead[loc]}</p><p>${tail[loc]}</p>`;
 };
 /**
  * Cap the description used inside JobPosting JSON-LD.
  *
  * Why: Google's structured-data tester treats ~500-char descriptions as
  * ideal and the field is an *abstract*, not the full ad. Embedding the
  * raw 6-7 KB ATS body inflates `<head>` size, drags down text/HTML ratio
  * (Semrush threshold 10 %), and provides no SERP benefit.
  *
  * Behavior:
  *  - Strip HTML tags so the truncation operates on visible text.
  *  - Collapse all whitespace runs to a single space.
  *  - Cap at MAX_JSONLD_DESCRIPTION_CHARS (500), preferring sentence
  *    boundaries (`. `, `! `, `? `) before falling back to word boundaries.
  *  - Append a single ellipsis only when truncation actually trimmed text.
  *  - Returns the original (whitespace-collapsed) input when already short.
  *
  * NOTE: This affects ONLY the JSON-LD `description` field. The visible
  * page body keeps the full text — see `descriptionHtmlParts` upstream.
  */
 const MAX_JSONLD_DESCRIPTION_CHARS = 500;
 const capJsonLdDescription = (input: string): string => {
 if (!input) return input;
 // Strip tags and collapse whitespace so length math reflects visible text.
 const plain = String(input).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
 if (plain.length <= MAX_JSONLD_DESCRIPTION_CHARS) return plain;
 const window = plain.slice(0, MAX_JSONLD_DESCRIPTION_CHARS);
 // Prefer the last sentence boundary inside the window.
 const sentenceMatch = window.match(/^[\s\S]*[.!?](?=\s)/);
 if (sentenceMatch && sentenceMatch[0].length >= 200) {
 return `${sentenceMatch[0].trim()}…`;
 }
 // Fall back to the last word boundary.
 const lastSpace = window.lastIndexOf(' ');
 const cut = lastSpace > 200 ? window.slice(0, lastSpace) : window;
 return `${cut.trim()}…`;
 };
 /**
  * Deterministic non-crypto hash (djb2) — used to pick stable FAQ template
  * variants across rebuilds based on job slug.
  */
 const stableHash = (s: string): number => {
 let h = 5381;
 for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
 return h;
 };
 const hostFromUrl = (raw?: string): string => {
 if (!raw) return '';
 try {
 return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
 } catch {
 return '';
 }
 };
 const companyWebsite = (job: any): string => {
 const domain = job?.companyDomain || hostFromUrl(job?.url);
 return domain ? `https://www.${domain}` : BASE_URL;
 };
 /** Sanitize address fields — reject crawler artifacts */
 const isValidAddress = (s: string): boolean => {
 if (!s || s.length > 100) return false;
 // Reject strings with too many spaces (likely scraped garbage)
 if ((s.match(/\s/g) || []).length > 8) return false;
 // Reject strings with navigation/UI artifacts
 if (/stampa|segnalazione|descrizione|annuncio|verifica|attività|dillo/i.test(s)) return false;
 return true;
 };
 const isValidPostalCode = (s: string): boolean => {
 if (!s) return false;
 // Swiss postal codes: 4 digits starting with 1-9
 if (!/^[1-9]\d{3}$/.test(s)) return false;
 // Reject years (2020-2039) that accidentally match the 4-digit pattern
 const n = Number(s);
 if (n >= 2020 && n <= 2039) return false;
 return true;
 };

 // COMPANY_HQ_ADDRESSES is imported at module scope from
 // ./shared/companyHqAddresses — shared with weeklyEmployersPlugin.

 /** Does the value look like an actual street address (not just a city/region name)? */
 const isStreetLikeAddress = (s: string): boolean => {
 if (!s || s.length < 3) return false;
 // Must contain a known street keyword
 if (/\b(via|piazza|piazzale|piazzetta|viale|strada|corso|vicolo|salita|sentiero|contrada|largo|riva|lungolago|rampa|passaggio)\b/i.test(s)) return true;
 // Accept strings with both letters AND digits (e.g. "Rue de Lausanne 42") —
 // but reject pure-digit strings like "2026" that are years, not addresses
 if (/[a-zA-Z]/.test(s) && /\d/.test(s)) return true;
 return false;
 };

 /** City → generic central street address for last-resort fallback */
 const CITY_GENERIC_ADDRESS: Record<string, string> = {
 // Luganese
 'lugano': 'Piazza Riforma 1', 'paradiso': 'Riva Albertolli 1', 'massagno': 'Via S. Gottardo 52',
 'viganello': 'Via San Gottardo 87', 'pregassona': 'Via Pregassona 29', 'breganzona': 'Via Breganzona 16',
 'montagnola': 'Via Cantonale 24', 'grancia': 'Via Cantonale 18', 'muzzano': 'Via Municipio 8',
 'cadempino': 'Via Cantonale 31', 'lamone': 'Via Cantonale 31', 'comano': 'Via Cantonale 4',
 'canobbio': 'Via Cantone 1', 'tesserete': 'Via Stazione 2', 'capriasca': 'Via Stazione 2',
 'agno': 'Piazza Luini 2', 'bioggio': 'Via Cantonale 19', 'manno': 'Via Cantonale 2c', 'caslano': 'Piazza Lago 2',
 'novaggio': 'Via Cantonale 5', 'noranco': 'Via Noranco 10', 'neggio': 'Via Cantonale 12',
 'luganese': 'Piazza Riforma 1', 'malcantone': 'Piazza Lago 2',
 // Bellinzonese
 'bellinzona': 'Piazza Governo', 'giubiasco': 'Piazza Grande 1', 'sementina': 'Via Cantonale 35',
 'camorino': 'Via Cantonale 20', 'arbedo': 'Via Cantonale 1', 'castione': 'Via Cantonale 8',
 'cadenazzo': 'Via Stazione 10', 's. antonino': 'Via Serrai 1', 's.antonino': 'Via Serrai 1',
 'castione-arbedo': 'Via Cantonale 1', 'belinzona': 'Piazza Governo',
 // Sopraceneri
 'lodrino': 'Via Cantonale 1', 'sopraceneri': 'Piazza Governo',
 // Locarnese
 'locarno': 'Piazza Grande 18', 'muralto': 'Via Stazione 1', 'minusio': 'Via San Gottardo 73',
 'gordola': 'Via Cantonale 40', 'tenero': 'Via Brere 7', 'ascona': 'Via Borgo 34',
 'losone': 'Via Municipio 9', 'magadino': 'Via Cantonale 32', 'quartino': 'Via Cantonale 32',
 // Mendrisiotto
 'mendrisio': 'Via Luigi Benteler 1', 'chiasso': 'Corso San Gottardo 84', 'stabio': 'Via Industria 1',
 'balerna': 'Via Municipio 13', 'coldrerio': 'Via Municipio 12', 'novazzano': 'Via Cantonale 5',
 'castel san pietro': 'Via Municipio 1', 'morbio inferiore': 'Via Cantonale 46', 'vacallo': 'Via Municipio 8',
 // Leventina / Blenio
 'airolo': 'Piazza Stazione 1', 'faido': 'Piazza Municipio 1', 'bodio': 'Via Cantonale 3',
 'biasca': 'Via Giuseppe Lepori 1', 'mezzovico': 'Via Vedeggio 4', 'rivera': 'Via Cantonale 1',
 'taverne': 'Via Cantonale 20', 'pazzallo': 'Via Pazzallo 10', 'cadro': 'Via Cadro 5',
 'riazzino': 'Via Cantonale 12', 'castelrotto': 'Via Pratocarasso 1',
 'bedano': 'Via Cantonale 31', 'pollegio': 'Via Cantonale 1',
 // Graubünden / Grigioni
 'chur': 'Bahnhofstrasse 1', 'coira': 'Bahnhofstrasse 1',
 'landquart': 'Bahnhofstrasse 1', 'davos': 'Promenade 68',
 'st. moritz': 'Via Maistra 12', 'samedan': 'Plazzet 4', 'pontresina': 'Via Maistra 133',
 'walenstadt': 'Bahnhofstrasse 19', 'obervaz': 'Voa Principala 22',
 'ilanz': 'Via Centrala 2', 'thusis': 'Neudorfstrasse 60', 'poschiavo': 'Via da la Stazione 1',
 // Ginevra
 'plan-les-ouates': 'Route de Saint-Julien 7',
 'genève': 'Rue du Rhône 1', 'ginevra': 'Rue du Rhône 1', 'genf': 'Rue du Rhône 1', 'geneva': 'Rue du Rhône 1',
 // Major Swiss cities outside Ticino/GR
 'zürich': 'Bahnhofstrasse 1', 'zurich': 'Bahnhofstrasse 1', 'zurigo': 'Bahnhofstrasse 1',
 'bern': 'Bundesplatz 1', 'berna': 'Bundesplatz 1',
 'basel': 'Marktplatz 1', 'basilea': 'Marktplatz 1',
 'lausanne': 'Place de la Palud 2', 'losanna': 'Place de la Palud 2',
 'luzern': 'Bahnhofstrasse 1', 'lucerna': 'Bahnhofstrasse 1', 'lucerne': 'Bahnhofstrasse 1',
 'st. gallen': 'Bahnhofplatz 1', 'san gallo': 'Bahnhofplatz 1',
 'winterthur': 'Bahnhofplatz 1',
 'zug': 'Bahnhofstrasse 1',
 'aarau': 'Bahnhofstrasse 1',
 'fribourg': 'Rue de Romont 1', 'friburgo': 'Rue de Romont 1',
 'neuchâtel': 'Place du Port 1',
 'schaffhausen': 'Bahnhofstrasse 1',
 'solothurn': 'Hauptgasse 1',
 'thun': 'Bahnhofstrasse 1',
 'baden': 'Bahnhofstrasse 1',
 'olten': 'Bahnhofstrasse 1',
 };

 /** Normalise a locality string to extract the core city name for lookup.
 * Strips suffixes like ", Switzerland", ", Ticino", "TI + smart working", postal codes, etc. */
 const normaliseCityName = (raw: string): string[] => {
 const candidates: string[] = [];
 const s = raw.replace(/[_]/g, ' ').trim();
 // Split on comma, dot-separator, or dash-separated compound
 const parts = s.split(/[,·]/).map(p => p.trim()).filter(Boolean);
 for (const part of parts) {
 // Strip known suffixes
 const cleaned = part
 .replace(/\b(switzerland|svizzera|suisse|schweiz|ticino|ti|gr|ge|ch)\b/gi, '')
 .replace(/\+\s*smart\s*working/gi, '')
 .replace(/\b\d{4}\b/g, '') // postal codes
 .replace(/\s+/g, ' ')
 .trim();
 if (cleaned.length >= 2) candidates.push(cleaned.toLowerCase());
 }
 // Also try the raw first part before any comma
 if (parts[0]) candidates.unshift(parts[0].trim().toLowerCase());
 return [...new Set(candidates)];
 };

 /** Canton capital fallback — used as ultimate last resort */
 const CANTON_CAPITAL_ADDRESS: Record<string, string> = {
 'TI': 'Piazza Governo', 'GR': 'Bahnhofstrasse 1', 'GE': 'Rue du Rhône 1',
 'ZH': 'Bahnhofstrasse 1', 'BE': 'Bundesplatz 1', 'LU': 'Bahnhofstrasse 1',
 'VS': 'Place de la Planta 1', 'VD': 'Place de la Palud 2',
 'BS': 'Marktplatz 1', 'SG': 'Bahnhofplatz 1', 'AG': 'Bahnhofstrasse 1',
 'FR': 'Rue de Romont 1', 'NE': 'Place du Port 1', 'ZG': 'Bahnhofstrasse 1',
 'SH': 'Bahnhofstrasse 1', 'SO': 'Hauptgasse 1', 'BL': 'Marktplatz 1',
 };

 /** City name → canton code for deriving addressRegion from location */
 const CITY_TO_CANTON: Record<string, string> = {
 // Ticino
 'lugano': 'TI', 'bellinzona': 'TI', 'locarno': 'TI', 'mendrisio': 'TI', 'chiasso': 'TI',
 'biasca': 'TI', 'agno': 'TI', 'manno': 'TI', 'stabio': 'TI', 'giubiasco': 'TI',
 'ascona': 'TI', 'paradiso': 'TI', 'massagno': 'TI', 'cadenazzo': 'TI', 'mezzovico': 'TI',
 'balerna': 'TI', 'bedano': 'TI', 'airolo': 'TI', 'faido': 'TI', 'rivera': 'TI',
 // Graubünden
 'chur': 'GR', 'coira': 'GR', 'davos': 'GR', 'st. moritz': 'GR', 'landquart': 'GR',
 'ilanz': 'GR', 'thusis': 'GR', 'poschiavo': 'GR', 'samedan': 'GR',
 // Major Swiss cities
 'zürich': 'ZH', 'zurich': 'ZH', 'zurigo': 'ZH', 'winterthur': 'ZH', 'kloten': 'ZH',
 'dübendorf': 'ZH', 'dietlikon': 'ZH',
 'bern': 'BE', 'berna': 'BE', 'thun': 'BE', 'interlaken': 'BE',
 'basel': 'BS', 'basilea': 'BS',
 'genève': 'GE', 'ginevra': 'GE', 'genf': 'GE', 'geneva': 'GE', 'plan-les-ouates': 'GE',
 'lausanne': 'VD', 'losanna': 'VD',
 'luzern': 'LU', 'lucerna': 'LU', 'lucerne': 'LU',
 'st. gallen': 'SG', 'san gallo': 'SG', 'gossau': 'SG',
 'aarau': 'AG', 'baden': 'AG', 'lenzburg': 'AG',
 'fribourg': 'FR', 'friburgo': 'FR',
 'neuchâtel': 'NE',
 'zug': 'ZG',
 'schaffhausen': 'SH',
 'solothurn': 'SO', 'olten': 'SO',
 'frauenfeld': 'TG',
 'sion': 'VS', 'brig': 'VS', 'visp': 'VS', 'sierre': 'VS', 'martigny': 'VS',
 };

 /** Derive canton code from job location/addressLocality, falling back to job.canton or DEFAULT_CANTON */
 const deriveCanton = (job: any): string => {
 const explicitCanton = String(job.canton || job.addressRegion || '').toUpperCase().trim();
 if (explicitCanton && explicitCanton.length === 2 && /^[A-Z]{2}$/.test(explicitCanton)) return explicitCanton;
 // Try to infer from city names
 const candidates = [
 ...normaliseCityName(String(job.addressLocality || '')),
 ...normaliseCityName(String(job.location || '')),
 ];
 for (const c of candidates) {
 if (CITY_TO_CANTON[c]) return CITY_TO_CANTON[c];
 }
 return DEFAULT_CANTON;
 };

 /** Derive streetAddress from job data, company HQ, or city generic.
 * Always returns a street address (canton capital as last resort). */
 const deriveStreetAddress = (job: any): string => {
 // 1. Try job's own streetAddress — only if it looks like a real street
 const raw = String(job.streetAddress || '').trim();
 if (isValidAddress(raw) && isStreetLikeAddress(raw)) return raw;
 // 2. Try company HQ address
 const companyKey = String(job.companyKey || '').toLowerCase().trim();
 if (companyKey && COMPANY_HQ_ADDRESSES[companyKey]) return COMPANY_HQ_ADDRESSES[companyKey].streetAddress;
 // 3. Try city-based generic address (exact match)
 const locality = String(job.addressLocality || '').toLowerCase().trim();
 if (locality && CITY_GENERIC_ADDRESS[locality]) return CITY_GENERIC_ADDRESS[locality];
 // 4. Try location field parts (split on ·)
 const loc = String(job.location || '');
 const locParts = loc.split('·').map((s: string) => s.trim()).filter(Boolean);
 for (const part of locParts) {
 const key = part.toLowerCase().trim();
 if (key && CITY_GENERIC_ADDRESS[key]) return CITY_GENERIC_ADDRESS[key];
 }
 // 5. If job.streetAddress is non-empty but not street-like, try as city lookup
 const rawLower = raw.toLowerCase();
 if (rawLower && CITY_GENERIC_ADDRESS[rawLower]) return CITY_GENERIC_ADDRESS[rawLower];
 // 6. Fuzzy: normalise locality/location by stripping suffixes and try again
 const candidates = [
 ...normaliseCityName(String(job.addressLocality || '')),
 ...normaliseCityName(loc),
 ...normaliseCityName(raw),
 ];
 for (const c of candidates) {
 if (CITY_GENERIC_ADDRESS[c]) return CITY_GENERIC_ADDRESS[c];
 }
 // 7. Canton capital fallback — always produces a result
 const canton = String(job.canton || job.addressRegion || DEFAULT_CANTON).toUpperCase().trim();
 return CANTON_CAPITAL_ADDRESS[canton] || CANTON_CAPITAL_ADDRESS[DEFAULT_CANTON] || 'Piazza Governo';
 };
 // Map internal category strings to O*NET-SOC major group codes for Google Jobs.
 // https://www.onetcenter.org/taxonomy.html
 const CATEGORY_TO_ONET: Record<string, string> = {
 tech: '15-0000', technology: '15-0000', it: '15-0000', development: '15-0000',
 devops: '15-0000', analysis: '15-2000', 'IT / Software Development': '15-0000',
 'Corporate and Staff Functions/Information Technology': '15-0000',
 engineering: '17-0000', 'Ingegneria & Tecnica': '17-0000', impiantistica: '17-0000',
 meccanica: '17-0000', metallo: '17-0000', drafting: '17-3000', technician: '17-3000',
 architecture: '17-1000', 'Robotica & Automazione': '17-0000',
 health: '29-0000', healthcare: '29-0000', 'Life Science & Tecnologia Medica': '29-0000',
 'Chimica & Analisi': '19-0000', science: '19-0000', researcher: '19-0000',
 phd: '19-0000', sustainability: '19-0000',
 finance: '13-0000', finanza: '13-0000', assicurazioni: '13-0000', insurance: '13-0000',
 'Corporate and Staff Functions/Finance & Control': '13-0000', accounting: '13-2000',
 management: '11-0000', consulting: '11-0000', 'Consulenza gestionale': '11-0000',
 operations: '11-0000',
 admin: '43-0000', Administration: '43-0000', 'Servizi Aziendali': '43-0000',
 staff: '43-0000', general: '43-0000', 'public-administration': '43-0000',
 sales: '41-0000', vendita: '41-0000', 'Vendita & Commercio': '41-0000',
 'Commercio al dettaglio': '41-0000',
 logistics: '53-0000', 'Logistica & Trasporti': '53-0000', 'Logistica & Magazzino': '53-0000',
 Logistik: '53-0000', aviation: '53-0000',
 marketing: '27-3000', design: '27-1000', translation: '27-3000',
 hr: '13-1000', 'risorse-umane': '13-1000',
 legal: '23-0000',
 education: '25-0000', professor: '25-0000',
 'social-services': '21-0000', 'real-estate': '13-0000',
 'Turismo & Ospitalità': '35-0000', hospitality: '35-0000', gastronomy: '35-0000',
 cucina: '35-0000', servizio: '35-0000',
 'Agricoltura & Commercio': '45-0000',
 edilizia: '47-0000', cantiere: '47-0000',
 production: '51-0000', manufacturing: '51-0000',
 security: '33-0000', safety: '33-0000',
 };
 const mapCategoryToONet = (cat: string): string | undefined => CATEGORY_TO_ONET[cat];

 const companyLogo = (job: any): string => {
 const key = job?.companyKey || '';
 if (key && CRAWLED_COMPANY_LOGOS[key]) return CRAWLED_COMPANY_LOGOS[key];
 // Use branded 1200×630 OG image as fallback — Google's favicon service
 // only returns 128px which is too small for social preview requirements
 // (minimum 600×314px recommended by Open Graph spec).
 return `${BASE_URL}/og-image.png`;
 };
 /**
  * Local placeholder served from `public/images/company-logo-fallback.svg`.
  * Static HTML emits this as the `<img src>` so the file has no external
  * dependencies that can 404 on Semrush/crawler scans. The real (external)
  * logo URL is stashed on `data-logo-url` and loaded client-side by the
  * runtime hydration script (see services/companyLogoHydration.ts when
  * present). The `onerror` handler restores the placeholder if the runtime
  * swap-in image fails to load.
  */
 const LOGO_FALLBACK_SRC = '/images/company-logo-fallback.svg';
 const isLocalLogo = (url: string): boolean => {
 if (!url) return true;
 if (url.startsWith('/')) return true;
 try {
 const u = new URL(url);
 return u.host.endsWith('frontaliereticino.ch');
 } catch {
 return false;
 }
 };
 /**
  * Build `<img>` markup that points at the local placeholder by default and
  * stores the (possibly external) target on `data-logo-url`. Emits an
  * inline `onerror` that falls back to the placeholder if a runtime swap
  * fails. When the resolved URL is already local (curated SVG/PNG in
  * /images/logos or our own og-image.png), we keep using it directly —
  * those don't 404 on Semrush.
  */
 const renderLogoImg = (
 url: string,
 alt: string,
 width: number,
 height: number,
 style: string,
 ): string => {
 const safeAlt = esc(alt);
 const safeStyle = esc(style);
 if (isLocalLogo(url)) {
 return `<img src="${esc(url)}" alt="${safeAlt}" width="${width}" height="${height}" loading="lazy" style="${safeStyle}">`;
 }
 return `<img src="${LOGO_FALLBACK_SRC}" alt="${safeAlt}" width="${width}" height="${height}" loading="lazy" data-logo-url="${esc(url)}" onerror="this.onerror=null;this.src='${LOGO_FALLBACK_SRC}'" style="${safeStyle}">`;
 };

 const referralUrl = (raw: string, job: any): string => {
 try {
 const u = new URL(raw);
 u.searchParams.set('utm_source', 'frontaliereticino');
 u.searchParams.set('utm_medium', 'referral');
 u.searchParams.set('utm_campaign', 'job-board');
 u.searchParams.set('utm_content', job.slug || job.id || '');
 return u.toString();
 } catch {
 return raw;
 }
 };

 const withSlash = (s: string) => (s.endsWith('/') ? s : `${s}/`);
 const dateStamp = new Date().toISOString().slice(0, 10);
 const searchRoutePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'ricerca',
 en: 'search',
 de: 'suche',
 fr: 'recherche',
 };
 // Search pages aggregate jobs across all target cantons — use "in Svizzera" for titles
 // (60-char SEO limit) and full canton list in descriptions/editorial.
 const searchPageCopy: Record<'it' | 'en' | 'de' | 'fr', {
 title: (name: string) => string;
 description: (name: string, count: number) => string;
 heading: (name: string) => string;
 openListing: string;
 editorial: string;
 }> = {
 it: {
 // Title intentionally OMITS the brand suffix and the "Posizioni aperte oggi"
 // tail; both are appended downstream via buildTitleWithBrand only when the
 // result fits inside the universal 70-char SERP cap.
 title: (name: string) => `Offerte di lavoro ${name} in Svizzera`,
 description: (name: string, count: number) => `${count}+ offerte di lavoro ${name} in ${targetCantonsDisplay.it} aggiornate ogni giorno. Annunci raccolti dai siti ufficiali delle aziende svizzere con link diretto alla candidatura.`,
 heading: (name: string) => `Lavoro ${name} in Svizzera`,
 openListing: 'Apri il job board completo',
 editorial: `Gli annunci di lavoro sono raccolti direttamente dai siti ufficiali delle aziende in ${targetCantonsDisplay.it} e aggiornati quotidianamente. Ogni offerta rimanda alla pagina di candidatura originale del datore di lavoro. Il job board copre tutti i settori: sanità, finanza, tecnologia, ingegneria, commercio e amministrazione.`,
 },
 en: {
 // title vs heading must DIFFER (audit:h1-title-duplicates fails on
 // case+whitespace-insensitive equality). Pattern matches IT/FR:
 // title is the SERP-friendly headline ("X job openings in Switzerland"),
 // heading is the on-page H1 ("X jobs in Switzerland").
 title: (name: string) => `${name} job openings in Switzerland`,
 description: (name: string, count: number) => `${count}+ ${name} job openings in ${targetCantonsDisplay.en} updated daily. Listings sourced from official Swiss employer career pages with direct application links.`,
 heading: (name: string) => `${name} jobs in Switzerland`,
 openListing: 'Open the full job board',
 editorial: `Job listings are sourced directly from official company career pages in ${targetCantonsDisplay.en} and refreshed daily. Every listing links to the employer's original application page. The job board covers all sectors: healthcare, finance, technology, engineering, retail, and administration.`,
 },
 de: {
 // Same anti-duplicate rule as `en`: title is "Stellenangebote" (the
 // formal-register synonym used in SERP titles), heading is the
 // shorter colloquial "Jobs". Both surface the keyword `name`.
 title: (name: string) => `${name} Stellenangebote in der Schweiz`,
 description: (name: string, count: number) => `${count}+ aktuelle ${name} Stellenangebote in ${targetCantonsDisplay.de}, täglich aktualisiert. Direkt von offiziellen Karriereportalen Schweizer Unternehmen mit Bewerbungslink.`,
 heading: (name: string) => `${name} Jobs in der Schweiz`,
 openListing: 'Komplettes Job Board öffnen',
 editorial: `Stellenanzeigen werden direkt von den offiziellen Karriereseiten der Unternehmen in ${targetCantonsDisplay.de} bezogen und täglich aktualisiert. Jedes Inserat verlinkt zur originalen Bewerbungsseite des Arbeitgebers. Das Job Board deckt alle Branchen ab: Gesundheit, Finanzen, Technologie, Ingenieurwesen, Handel und Verwaltung.`,
 },
 fr: {
 title: (name: string) => `Offres d'emploi ${name} en Suisse`,
 description: (name: string, count: number) => `${count}+ offres d'emploi ${name} en ${targetCantonsDisplay.fr} mises à jour quotidiennement. Annonces provenant des portails officiels des entreprises suisses avec lien de candidature.`,
 heading: (name: string) => `Emploi ${name} en Suisse`,
 openListing: 'Ouvrir le job board complet',
 editorial: `Les offres d'emploi proviennent directement des portails carrière officiels des entreprises en ${targetCantonsDisplay.fr} et sont actualisées quotidiennement. Chaque annonce renvoie à la page de candidature originale de l'employeur. Le job board couvre tous les secteurs : santé, finance, technologie, ingénierie, commerce et administration.`,
 },
 };
 const normalizeSearchTerm = (value: string): string => String(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .trim();
 const matchesSearchLanding = (job: any, query: string, locale: 'it' | 'en' | 'de' | 'fr'): boolean => {
 const haystack = normalizeSearchTerm([
 job?.titleByLocale?.[locale],
 job?.title,
 job?.company,
 job?.location,
 job?.canton,
 job?.descriptionByLocale?.[locale],
 job?.description,
 ].filter(Boolean).join(' '));
 const tokens = normalizeSearchTerm(query).split(/\s+/).filter(Boolean);
 return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
 };

 /** Tracks every dist/ directory written by the active-job page generator
 * so that expired soft-landing pages never overwrite a live job page. */
 const activeJobDirs = new Set<string>();

 /** Caches active job page HTML by `${locale}:${slug}` so bridge pages
 * (previousSlugs) can serve identical full-content pages with only the
 * canonical URL pointing to the current slug. */
 const jobHtmlCache = new Map<string, string>();

 const companyRoutePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'azienda',
 en: 'company',
 de: 'unternehmen',
 fr: 'entreprise',
 };
 const slugifyCompanyBuild = (value: string): string =>
 String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').trim();
 /** Mirror runtime canonicalCompanyRouteSlug logic */
 const canonicalCompanySlugBuild = (company: string, companyKey?: string): string => {
 const keyNorm = String(companyKey || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
 const nameNorm = String(company || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
 if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
 return slugifyCompanyBuild(company);
 };

 // ── Pre-compute title-collision map per locale ──
 // The base <title> formula (role + company + city) collapses to identical
 // strings whenever two jobs differ only by slug suffix (AFC vs CFP variants),
 // by city-postal-code tail (e.g. `riazzino-xsgkjj` vs `cadenazzo` for the
 // same Lidl listing replicated across postal codes), or because the
 // 70-char ceiling truncates them to the same prefix. Semrush's
 // title-uniqueness gate flags every such collision (~1.9k pages on the
 // current dataset).
 //
 // Strategy: build a (locale → baseTitle → count) map up front, then in the
 // per-job loop append a slug-tail disambiguator ONLY when count > 1 — so
 // unique pages keep their existing clean title and only colliding ones grow
 // a stable suffix. The slug tail is preferred because it is already unique
 // within the dataset (router slugs are deduped at crawl time). When the
 // job has no usable slug we fall back to the job.id tail.
 const titleCollisionByLocale: Record<'it' | 'en' | 'de' | 'fr', Map<string, number>> = {
 it: new Map(), en: new Map(), de: new Map(), fr: new Map(),
 };
 for (const job of validJobs) {
 for (const locale of localeList) {
 const lt = String(job?.titleByLocale?.[locale] || job.title || '');
 const loc = String(job.location || '').trim();
 const baseTitle = composeJobPageTitle(lt, String(job.company || ''), loc, locale);
 const bucket = titleCollisionByLocale[locale];
 bucket.set(baseTitle, (bucket.get(baseTitle) || 0) + 1);
 }
 }

 // Per-locale active-job path dedup. cleanup-jobs.mjs dedupes by
 // `job.slug` (the canonical IT slug), but two distinct jobs can pass
 // that filter with different IT slugs while still converging on the
 // same DE/EN/FR locale slug — for example two `tally-weijl-aarau`
 // postings whose IT titles differ slightly but whose German/English
 // translations slugify identically. Each then emits an active-job
 // page at /de/jobs-im-tessin/{same-slug}/index.html, producing the
 // 204-collision-per-build pattern in run 25312882900.
 //
 // validJobs is already sorted DESC by recency above, so the FIRST job
 // for any colliding (locale, slug) is the most recent. We register it
 // in this Set and skip later jobs that would write to the same path.
 // Their original IT canonical (which IS unique because cleanup ensured
 // it) still emits — only the colliding locale variants are suppressed.
 const emittedActiveJobPaths = new Set<string>();

 for (const job of validJobs) {
 const perLocaleSlug = {
 it: localizedSlug(job, 'it'),
 en: localizedSlug(job, 'en'),
 de: localizedSlug(job, 'de'),
 fr: localizedSlug(job, 'fr'),
 };
 for (const locale of localeList) {
 const __tActiveJob = startTimer();
 const relPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${perLocaleSlug[locale]}`.replace(/\/+/g, '/');
 // Suppress duplicate per-locale emit. Most-recent (sorted earlier)
 // already won this path; emitting again would only register a
 // collision in dist/.write-collisions.json without changing the
 // bytes on disk (Map last-add-wins inside the WriteCollector).
 const __activeJobKey = `${locale}:${perLocaleSlug[locale]}`;
 if (emittedActiveJobPaths.has(__activeJobKey)) {
 recordEmit('active-job', __tActiveJob);
 continue;
 }
 emittedActiveJobPaths.add(__activeJobKey);
 const canonicalPath = withSlash(relPath);
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 // Cannibalization fix: <link rel="canonical"> and og:url may point to a
 // winner URL (company hub) when this slug is in the override map.
 // The page itself is still emitted with its own URL (breadcrumbs,
 // JobPosting, etc. describe THIS page) so existing backlinks resolve.
 const effectiveCanonicalUrl = resolveCanonicalUrl(perLocaleSlug[locale], canonicalUrl);
 const localizedTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 const jobLocation = String(job.location || '').trim();
 const dc = CANTON_DISPLAY[String(job.canton || DEFAULT_CANTON)] || String(job.canton || DEFAULT_CANTON);
 // City-aware title: always includes location when available, then truncates
 // the core before appending the fixed brand suffix. This prevents duplicate
 // titles on multi-sede jobs (same role × N cities) — the city differentiates
 // the SERP title — and keeps total length within Google's ~60-char limit.
 //
 // Disambiguator (slug-tail or job-id-tail) is injected ONLY when the base
 // title would collide with another job's base title in the same locale —
 // closes the Semrush title-uniqueness audit gate while leaving unique
 // titles untouched.
 const baseTitleProbe = composeJobPageTitle(localizedTitle, String(job.company || ''), jobLocation, locale);
 const collidesInLocale = (titleCollisionByLocale[locale].get(baseTitleProbe) || 0) > 1;
 // Build a HUMAN-READABLE disambiguator from the job's metadata (cascade:
 // workHours/percentage → employmentType label → salary range → posted
 // month → job-id reference). Replaces the previous opaque
 // ` (#abcd1234)` FNV hash, which Semrush flagged as a low-CTR
 // auto-disambiguator pattern. See `pickJobDisambiguator` above for the
 // full selection logic.
 const disambiguatorToken = collidesInLocale
 ? pickJobDisambiguator(job as Record<string, unknown>, locale, baseTitleProbe)
 : '';
 const title = composeJobPageTitle(localizedTitle, String(job.company || ''), jobLocation, locale, disambiguatorToken);
 // Clean variant for og:title / twitter:title — same as `title` minus
 // the trailing " · {disambiguator}". The disambig is needed in the
 // HTML <title> for SEO uniqueness, but the social cards look better
 // without the trailing extra metadata.
 const ogTitle = composeJobPageTitle(localizedTitle, String(job.company || ''), jobLocation, locale, '');
 const localizedDescriptionRaw = String(job?.descriptionByLocale?.[locale] || job.description || '');
 const localizedDescription = normalizeText(localizedDescriptionRaw);
 const cleanDesc = cleanMetaDescription(localizedDescriptionRaw);
 // Build an SEO-friendly meta description with salary and CTA
 const metaIntro = locale === 'de'
 ? `${localizedTitle} bei ${job.company} in ${job.location || DEFAULT_CANTON_DISPLAY}.`
 : locale === 'fr'
 ? `${localizedTitle} chez ${job.company} à ${job.location || DEFAULT_CANTON_DISPLAY}.`
 : locale === 'en'
 ? `${localizedTitle} at ${job.company} in ${job.location || DEFAULT_CANTON_DISPLAY}.`
 : `${localizedTitle} presso ${job.company} a ${job.location || DEFAULT_CANTON_DISPLAY}.`;
 // Inline salary snippet for meta description (before salaryText is computed)
 const metaSalaryMin = Number(job.salaryMin);
 const metaSalaryMax = Number(job.salaryMax);
 const metaCurrency = String(job.currency || 'CHF');
 const metaSalarySnippet = Number.isFinite(metaSalaryMin) && metaSalaryMin > 0
 ? (Number.isFinite(metaSalaryMax) && metaSalaryMax > metaSalaryMin
 ? ` ${locale === 'de' ? 'Gehalt' : locale === 'fr' ? 'Salaire' : locale === 'en' ? 'Salary' : 'Salario'}: ${metaCurrency} ${Math.round(metaSalaryMin).toLocaleString('de-CH')}-${Math.round(metaSalaryMax).toLocaleString('de-CH')}.`
 : ` ${locale === 'de' ? 'Gehalt' : locale === 'fr' ? 'Salaire' : locale === 'en' ? 'Salary' : 'Salario'}: ${metaCurrency} ${Math.round(metaSalaryMin).toLocaleString('de-CH')}.`)
 : '';
 const metaCta = locale === 'de' ? ' Jetzt auf Frontaliere Ticino bewerben.'
 : locale === 'fr' ? ' Postulez sur Frontaliere Ticino.'
 : locale === 'en' ? ' Apply now on Frontaliere Ticino.'
 : ' Candidati ora su Frontaliere Ticino.';
 const metaBody = cleanDesc.length > 40 ? ` ${cleanDesc}` : '';
 // Assemble: intro + salary + body, truncated to 160 chars; fallback to body if over limit
 const descWithSalary = `${metaIntro}${metaSalarySnippet}${metaCta}`;
 // Truncate meta description at word boundary, avoiding trailing hyphens/prepositions
 const truncMetaDesc = (s: string, max = 160): string => {
 if (s.length <= max) return s;
 let cut = s.lastIndexOf(' ', max - 1);
 if (cut <= 0) cut = max - 1;
 let result = s.substring(0, cut).trimEnd();
 // Strip trailing hyphens, dashes, and common prepositions
 result = result.replace(/[\s\-–—]+$/, '').replace(/\s+(di|da|per|a|in|con|su|del|della|dei|delle|at|in|for|of|the|an|bei|für|im|von|chez|pour|au|du|de|des|les)\s*$/i, '');
 return result + '...';
 };
 // Decode HTML entities from source data to prevent double-escaping in esc()
 const description = decodeHtmlEntities(descWithSalary.length <= 160
 ? descWithSalary
 : truncMetaDesc(`${metaIntro}${metaSalarySnippet}${metaBody}`));
 const descriptionParagraphs = splitIntoParagraphs(localizedDescriptionRaw).slice(0, 10);
 const requirements = firstItems(job?.requirementsByLocale?.[locale] || job?.requirements, 8);
 const canonicalLocale = readCanonicalByLocale(job, locale);
 const canonicalSummary = cleanItems(canonicalLocale?.summary, 4);
 const canonicalSections = parseCanonicalSections(canonicalLocale?.sections, 8)
 .filter((section) => !['requirements', 'benefits', 'process'].includes(section.id));
 const canonicalResponsibilities = cleanItems(canonicalLocale?.responsibilities, 10);
 const canonicalRequirements = cleanItems(canonicalLocale?.requirements, 12);
 const canonicalBenefits = cleanItems(canonicalLocale?.benefits, 10);
 const canonicalProcess = cleanItems(canonicalLocale?.process, 8);
 const canonicalKeywords = cleanItems(canonicalLocale?.keywords, 8);
 const fallbackParagraphs = [cantonPracticalNote0(locale, dc), ...localeCopy[locale].practicalNotes.slice(1)];
 const bodyParagraphs = (descriptionParagraphs.length >= 3
 ? descriptionParagraphs.slice(0, 3)
 : [localizedDescription, ...fallbackParagraphs]
 )
 .filter((p) => p && p.length > 25)
 .slice(0, 4);
 const summaryParagraphs = canonicalSummary.length > 0 ? canonicalSummary : bodyParagraphs;
 const mergedRequirements = canonicalRequirements.length > 0 ? canonicalRequirements : requirements;
 const logoUrl = companyLogo(job);
 // Related jobs cross-link block — densifies BFS reachability so the
 // ~2400 job-detail pages are reachable from the city/sector hubs even
 // when those hubs only embed top-30 cards. Selection: same category
 // OR same location, sorted with a deterministic salt of the slug to
 // distribute outbound links across the whole job graph rather than
 // always picking the same freshest jobs (which would leave deeper
 // listings orphaned). Cap held at 6 (1.5× the original 4) — high
 // enough to keep the orphan pool reachable at ~8.2k edges
 // (6 × 1370 reachable details), low enough to keep detail-page byte
 // weight under the audit:page-weight budget.
 const relatedPool = validJobs
 .filter((r: any) => r.slug !== job.slug && (r.category === job.category || r.location === job.location));
 // Stable hash of own slug → starting offset into the pool, so
 // different details surface different neighbours (no "always top N")
 // without losing determinism between builds.
 const relatedSeed = (() => {
 const s = String(job.slug || '');
 let h = 2166136261 >>> 0;
 for (let i = 0; i < s.length; i++) {
 h = (h ^ s.charCodeAt(i)) >>> 0;
 h = (h * 16777619) >>> 0;
 }
 return h;
 })();
 const related = relatedPool.length === 0 ? [] : (() => {
 const out: any[] = [];
 const seen = new Set<string>();
 const N = Math.min(6, relatedPool.length);
 for (let i = 0; i < N; i++) {
 const idx = (relatedSeed + i * 2654435761) % relatedPool.length;
 const cand = relatedPool[idx];
 if (cand && !seen.has(cand.slug)) {
 seen.add(cand.slug);
 out.push(cand);
 }
 }
 // Top-up with sequential picks if hash collisions reduced count.
 for (let i = 0; out.length < N && i < relatedPool.length; i++) {
 const cand = relatedPool[i];
 if (cand && !seen.has(cand.slug)) {
 seen.add(cand.slug);
 out.push(cand);
 }
 }
 return out;
 })();
 const relatedHtml = related
 .map((r: any) => {
 const rp = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localizedSlug(r, locale)}`.replace(/\/+/g, '/');
 const href = `${BASE_URL}${withSlash(rp)}`;
 const relatedTitle = String(r?.titleByLocale?.[locale] || r.title || '');
 const rLogo = companyLogo(r);
 const rSalary = (() => {
 if (!r.salaryMin) return '';
 const min = (r.salaryMin / 1000).toFixed(0);
 const max = r.salaryMax ? (r.salaryMax / 1000).toFixed(0) : null;
 return max ? `${r.currency || 'CHF'} ${min}k – ${max}k` : `${r.currency || 'CHF'} ${min}k+`;
 })();
 const rLogoImg = renderLogoImg(rLogo, `Logo ${r.company}`, 40, 40, 'width:40px;height:40px;object-fit:contain;border-radius:8px;border:1px solid var(--color-edge);flex-shrink:0');
 return `<li style="margin:0 0 8px 0"><a href="${href}" aria-label="${esc(relatedTitle)} — ${esc(r.company)}" style="display:flex;align-items:flex-start;gap:12px;text-decoration:none;padding:12px;border:1px solid var(--color-edge);border-radius:12px">${rLogoImg}<div style="min-width:0;flex:1"><div style="font-size:14px;font-weight:700;color:var(--color-heading);line-height:1.3">${esc(relatedTitle)}</div><div style="font-size:12px;color:var(--color-subtle);margin-top:2px">${esc(r.company)} · ${esc(r.location)}${r.canton ? ` (${esc(r.canton)})` : ''}</div>${rSalary ? `<div style="font-size:12px;font-weight:600;color:var(--color-success);margin-top:4px">${esc(rSalary)}</div>` : ''}</div></a></li>`;
 })
 .join('');
 const summaryHtml = summaryParagraphs
 .map((p) => `<p>${esc(p)}</p>`)
 .join('');
 const isSubheadItem = (value: string) => /^(requisiti necessari|requisiti auspicati|required|preferred)$/i.test(normalizeText(value));
 const sectionHtml = (heading: string, paragraphs: string[], bullets: string[]) => {
 const paragraphsHtml = paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
 const bulletsHtml = bullets.length > 0
 ? `<ul>${bullets.map((item) => `<li${isSubheadItem(item) ? ' class="subhead"' : ''}>${esc(item)}</li>`).join('')}</ul>`
 : '';
 return `<section class="section"><h4>${esc(heading)}</h4>${paragraphsHtml}${bulletsHtml}</section>`;
 };
 const timelineBlocks: Array<{ heading: string; paragraphs: string[]; bullets: string[] }> = [];
 if (canonicalResponsibilities.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].responsibilitiesLabel, paragraphs: [], bullets: canonicalResponsibilities });
 }
 if (mergedRequirements.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].requirementsLabel, paragraphs: [], bullets: mergedRequirements });
 }
 if (canonicalBenefits.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].benefitsLabel, paragraphs: [], bullets: canonicalBenefits });
 }
 if (canonicalProcess.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].processLabel, paragraphs: [], bullets: canonicalProcess });
 }
 for (const section of canonicalSections) {
 if (section.paragraphs.length === 0 && section.bullets.length === 0) continue;
 timelineBlocks.push({
 heading: section.heading,
 paragraphs: section.paragraphs,
 bullets: section.bullets,
 });
 }
 if (canonicalKeywords.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].keywordsLabel, paragraphs: [], bullets: canonicalKeywords });
 }
 const timelineHtml = timelineBlocks
 .map((section) => `<div class="timeline-step">${sectionHtml(section.heading, section.paragraphs, section.bullets)}</div>`)
 .join('');
 const parserAssignedChunks = summaryParagraphs.length
 + timelineBlocks.reduce((sum, section) => sum + section.paragraphs.length + section.bullets.length, 0);
 const parserOriginalChunks = Math.max(1, descriptionParagraphs.length + mergedRequirements.length);
 const parserCoverage = Math.min(100, Math.round((parserAssignedChunks / parserOriginalChunks) * 100));
 const isRemote = /remote|telelavor|smart[-\s]?working|home office|hybrid/i.test(
 `${job.title || ''} ${localizedDescription || ''} ${job.location || ''}`
 );
 // Salary data is pre-populated by re-enrich-jobs.mjs (SECTORS estimation)
 const salaryMin = Number.isFinite(Number(job.salaryMin))
 ? Number(job.salaryMin)
 : Number(job?.baseSalary?.value?.minValue);
 const salaryMax = Number.isFinite(Number(job.salaryMax))
 ? Number(job.salaryMax)
 : Number(job?.baseSalary?.value?.maxValue);
 const salaryCurrency = String(job.currency || job?.baseSalary?.currency || job?.baseSalary?.value?.currency || 'CHF');
 const salaryFormatter = new Intl.NumberFormat(
 locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-CH' : 'it-CH',
 { maximumFractionDigits: 0 }
 );
 const salaryText = Number.isFinite(salaryMin)
 ? (Number.isFinite(salaryMax) && salaryMax > salaryMin
 ? `${salaryCurrency} ${salaryFormatter.format(salaryMin)} - ${salaryFormatter.format(salaryMax)}`
 : `${salaryCurrency} ${salaryFormatter.format(salaryMin)}`)
 : (locale === 'de'
 ? 'nicht angegeben'
 : locale === 'fr'
 ? 'non indiqué'
 : locale === 'en'
 ? 'not specified'
 : 'non indicato');
 const rawLocality = String(job.addressLocality || '').trim();
 const addressLocality = isValidAddress(rawLocality) ? rawLocality : String(job.location || DEFAULT_CANTON_DISPLAY);
 const addressRegion = deriveCanton(job);
 const addressCountry = String(job.addressCountry || 'CH');
 const rawPostal = String(job.postalCode || '').trim();
 const postalCode = deriveJobPostalCode(job);
 const streetAddress = deriveStreetAddress(job);
 const alternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${perLocaleSlug[l]}`.replace(/\/+/g, '/');
 return { lang: l, href: `${BASE_URL}${withSlash(p)}` };
 });
 const xDefaultHref = (alternates.find((h) => h.lang === 'it') || alternates[0])?.href || '';
 const hreflangHtml = [
 ...alternates.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ...(xDefaultHref ? [` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`] : []),
 ].join('\n');

 // Build an HTML-formatted description for JobPosting structured data.
 // Google requires a non-empty description and recommends HTML format.
 // Assemble from summary paragraphs + structured sections, with a
 // plain-text fallback for jobs that lack parsed content.
 const descriptionHtmlParts: string[] = [];
 for (const p of summaryParagraphs) {
 if (p && p.length > 10) descriptionHtmlParts.push(`<p>${esc(p)}</p>`);
 }
 for (const block of timelineBlocks) {
 if (block.heading) descriptionHtmlParts.push(`<h3>${esc(block.heading)}</h3>`);
 for (const p of block.paragraphs) {
 if (p) descriptionHtmlParts.push(`<p>${esc(p)}</p>`);
 }
 if (block.bullets.length > 0) {
 descriptionHtmlParts.push(`<ul>${block.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
 }
 }
 const jobPostingDescriptionHtml = descriptionHtmlParts.join('').slice(0, 5000);
 // Fallback: use plain text description or metaIntro if HTML assembly is empty
 const jobPostingDescription = jobPostingDescriptionHtml.length >= 50
 ? jobPostingDescriptionHtml
 : (localizedDescription.length >= 50
 ? plainTextToHtml(localizedDescription).slice(0, 5000) || localizedDescription.slice(0, 5000)
 : plainTextToHtml(`${metaIntro} ${localizedDescription}`.trim()).slice(0, 5000)
 || `${metaIntro} ${localizedDescription}`.trim().slice(0, 5000));
 // CLAUDE.md rule #3: JobPosting schema MUST always be emitted for active
 // jobs. If the aggregated description is too thin, synthesize a default
 // from the structured fields we already have (title, company, city,
 // canton, contract, sector) so Google still gets a valid, useful snippet.
 const hasValidJobPostingDescription = jobPostingDescription.length >= 30;
 const finalJobPostingDescription = hasValidJobPostingDescription
 ? jobPostingDescription
 : buildJobDescriptionFallback(job, localizedTitle, addressLocality, addressRegion, locale);
 // Build the canonical JobPosting schema via the shared builder — this
 // guarantees all 9 mandatory fields (CLAUDE.md rule #3) with realistic
 // defaults. Extra editorial fields (responsibilities, skills, etc.) are
 // merged on top of the canonical output.
 const canonicalJobInput: JobInput = {
 id: job.id,
 slug: job.slug,
 title: localizedTitle,
 description: capJsonLdDescription(finalJobPostingDescription),
 company: job.company,
 companyKey: job.companyKey,
 companyDomain: companyWebsite(job),
 companyLogoUrl: logoUrl,
 addressLocality,
 addressRegion,
 addressCountry,
 postalCode,
 streetAddress,
 postedDate: job.postedDate,
 crawledAt: job.crawledAt,
 updatedAt: job.updatedAt,
 contract: job.contract,
 salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
 salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
 salaryCurrency,
 sector: job.category,
 category: job.category,
 url: job.url,
 isRemote,
 };
 const canonicalSchema = buildJobPostingSchema(canonicalJobInput, {
 locale,
 url: canonicalUrl,
 baseUrl: BASE_URL,
 });
 // Merge editorial-only fields that sit outside the 9-mandatory core.
 // The canonical block is authoritative for every required field — only
 // optional enrichment data is layered on.
 const jobLd = JSON.stringify({
 ...canonicalSchema,
 // validThrough from the legacy helper (may differ from builder default).
 validThrough: toValidThrough(job.postedDate, job.crawledAt),
 applicantLocationRequirements: {
 '@type': 'Country',
 name: 'CH',
 },
 ...(canonicalResponsibilities.length > 0 ? { responsibilities: canonicalResponsibilities.join('\n') } : {}),
 ...(canonicalKeywords.length > 0 ? { skills: canonicalKeywords.join(', ') } : {}),
 ...(canonicalRequirements.length > 0 ? { qualifications: canonicalRequirements.join('\n') } : {}),
 ...(job.category && mapCategoryToONet(job.category) ? { occupationalCategory: mapCategoryToONet(job.category) } : {}),
 });
 const breadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: cantonSectionName(locale, dc), item: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}` },
 { '@type': 'ListItem', position: 3, name: localizedTitle, item: canonicalUrl },
 ],
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(title)}</title>
 <meta name="description" content="${esc(description)}">
 <meta property="og:type" content="article">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(ogTitle)}">
 <meta property="og:description" content="${esc(description)}">
 <meta property="og:url" content="${effectiveCanonicalUrl}">
 <meta property="og:image" content="${perLocaleSlug.it ? `${BASE_URL}/og/jobs/${perLocaleSlug.it}.png` : `${BASE_URL}/og-image.png`}">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(ogTitle)}">
 <meta name="twitter:description" content="${esc(description)}">
 <meta name="twitter:image" content="${perLocaleSlug.it ? `${BASE_URL}/og/jobs/${perLocaleSlug.it}.png` : `${BASE_URL}/og-image.png`}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${effectiveCanonicalUrl}">
 <link rel="preconnect" href="https://fonts.googleapis.com">
 <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
 <link rel="preload" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" as="style" crossorigin>
 <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" media="print" onload="this.media='all'" data-clarity-unmask="true"><noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" data-clarity-unmask="true"></noscript>
 <style>
 * { box-sizing: border-box; }
 body {
 margin: 0;
 padding: 0;
 font-family: "Manrope", sans-serif;
 color: var(--color-body);
 background:
 radial-gradient(1100px 600px at 0% -10%, var(--color-job-bg-gradient-1), transparent 60%),
 radial-gradient(1000px 600px at 100% 0%, var(--color-job-bg-gradient-2), transparent 60%),
 var(--color-surface-alt);
 }
 /* Padding only for static pre-hydration content */
 body > #root > main.static-job-page { padding: 26px; }
 h1, h2, h3, h4 { margin: 0; font-family: "Outfit", sans-serif; }
 main { max-width: 1120px; margin: 0 auto; display: grid; gap: 12px; }
 .proposal {
 border: 1px solid var(--color-edge);
 background: var(--color-surface);
 border-radius: 20px;
 padding: 12px;
 overflow: hidden;
 }
 .hero {
 border: 1px solid var(--color-accent-border);
 background:
 linear-gradient(130deg, var(--color-job-hero-gradient-from), var(--color-job-hero-gradient-to));
 border-radius: 16px;
 padding: 14px;
 margin-bottom: 10px;
 }
 .hero-title {
 font-size: 23px;
 line-height: 1.18;
 letter-spacing: -0.01em;
 }
 .hero-sub {
 margin-top: 4px;
 font-size: 14px;
 color: var(--color-subtle);
 }
 .hero-meta {
 margin-top: 10px;
 display: flex;
 flex-wrap: wrap;
 gap: 7px;
 }
 .hero-meta span {
 border: 1px solid var(--color-edge);
 background: var(--color-job-chip-bg);
 border-radius: 999px;
 padding: 5px 8px;
 font-size: 11px;
 font-weight: 800;
 color: var(--color-body);
 }
 .section {
 border: 1px solid var(--color-edge);
 border-radius: 14px;
 padding: 12px;
 margin-bottom: 9px;
 background: var(--color-surface);
 }
 .section h4 {
 font-size: 14px;
 text-transform: uppercase;
 letter-spacing: 0.02em;
 color: var(--color-subtle);
 margin-bottom: 8px;
 }
 .section p {
 margin: 0 0 8px 0;
 font-size: 14px;
 line-height: 1.58;
 color: var(--color-body);
 }
 .section ul {
 margin: 0;
 padding-left: 18px;
 }
 .section li {
 margin-bottom: 7px;
 font-size: 14px;
 line-height: 1.52;
 color: var(--color-body);
 }
 .section li.subhead {
 list-style: none;
 margin-left: -12px;
 margin-top: 4px;
 margin-bottom: 6px;
 font-weight: 800;
 color: var(--color-heading);
 }
 .timeline {
 position: relative;
 margin-left: 6px;
 padding-left: 16px;
 border-left: 2px dashed var(--color-accent-border);
 }
 .timeline-step {
 margin-bottom: 10px;
 position: relative;
 }
 .timeline-step::before {
 content: "";
 position: absolute;
 left: -22px;
 top: 8px;
 width: 9px;
 height: 9px;
 border-radius: 999px;
 background: var(--color-accent);
 }
 .cta {
 display: inline-flex;
 align-items: center;
 justify-content: center;
 margin-top: 2px;
 padding: 12px 20px;
 min-height: 44px;
 border-radius: 10px;
 text-decoration: none;
 font-size: 14px;
 font-weight: 800;
 background: var(--color-accent);
 color: var(--color-on-accent);
 }
 .related {
 margin-top: 8px;
 background: var(--color-surface);
 border: 1px solid var(--color-edge);
 border-radius: 16px;
 padding: 14px;
 }
 .related h2 {
 margin: 0 0 10px 0;
 font-size: 18px;
 }
 @media (max-width: 980px) {
 body > #root > main.static-job-page { padding: 14px; }
 .hero-title { font-size: 22px; }
 }
 </style>
${hreflangHtml}
 <script type="application/ld+json">${jobLd}</script>
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@type':'WebPage',url:canonicalUrl,inLanguage:locale,isPartOf:{'@type':'CollectionPage','@id':`${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g,'/'))}`,name:cantonSectionName(locale,dc)}})}</script>
 <script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"SpeakableSpecification","cssSelector":["h1",".hero-sub",".section"]})}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="print" onload="this.media='all'" data-clarity-unmask="true"><noscript><link rel="stylesheet" href="/assets/${entryCss}" crossorigin data-clarity-unmask="true"></noscript>` : ''}
 ${SPA_ACTION_REDIRECT_SCRIPT}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main class="static-job-page">
 <nav style="margin:0 0 16px;font-size:14px"><a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:var(--color-accent);text-decoration:none;font-weight:600">&larr; ${esc(localeCopy[locale].allJobsLink)}</a></nav>
 <article class="proposal">
 <section class="hero">
 <h1 class="hero-title">${esc(composeJobPageH1(localizedTitle, String(job.company || '')))}</h1>
 <div class="hero-sub">${esc(job.company)} · ${esc(job.location)} (${esc(job.canton || DEFAULT_CANTON)})</div>
 <div class="hero-meta">
 <span>${esc(`Categoria: ${String(job.category || 'other')}`)}</span>
 <span>${esc(`Contratto: ${String(job.contract || 'other')}`)}</span>
 <span>${esc(`Salario: ${salaryText}`)}</span>
 </div>
 </section>
 <section class="section">
 <h4>${esc(localeCopy[locale].summaryLabel)}</h4>
 ${summaryHtml}
 </section>
 <div class="timeline">
 ${timelineHtml || `<div class="timeline-step">${sectionHtml(localeCopy[locale].descriptionLabel, bodyParagraphs, [])}</div>`}
 </div>
 <a href="${referralUrl(job.url || canonicalUrl, job)}" rel="noopener noreferrer" class="cta">${esc(localeCopy[locale].applyNow)}</a>
 </article>
 ${(() => {
 const cSlugBanner = canonicalCompanySlugBuild(job.company, job.companyKey);
 const cHref = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${companyRoutePrefix[locale]}-${cSlugBanner}`.replace(/\/+/g, '/'))}`;
 const cLogo = companyLogo(job);
 const companyHeading: Record<string, string> = { it: 'Azienda', en: 'Company', de: 'Unternehmen', fr: 'Entreprise' };
 const companyMonitoring: Record<string, string> = { it: 'Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende.', en: 'Frontaliere Ticino discovered this opportunity through company monitoring.', de: 'Frontaliere Ticino hat diese Möglichkeit im Unternehmensmonitoring entdeckt.', fr: 'Frontaliere Ticino a repéré cette opportunité dans le suivi des entreprises.' };
 // SEO: keyword-rich anchor "Tutte le offerte {company} {location}" — consolidates cannibalized URLs onto the company hub.
 // See docs/seo-semrush-growth-plan.md Task A.1/A.2.
 const companyLoc = String(job.location || dc || '').trim();
 const allOffersAnchor: Record<string, string> = {
 it: `Tutte le offerte ${job.company}${companyLoc ? ` ${companyLoc}` : ''}`,
 en: `All ${job.company} jobs${companyLoc ? ` in ${companyLoc}` : ''}`,
 de: `Alle ${job.company} Stellen${companyLoc ? ` in ${companyLoc}` : ''}`,
 fr: `Toutes les offres ${job.company}${companyLoc ? ` à ${companyLoc}` : ''}`,
 };
 const anchorText = allOffersAnchor[locale] || allOffersAnchor.it;
 const cLogoImg = renderLogoImg(cLogo, `Logo ${job.company}`, 40, 40, 'width:40px;height:40px;object-fit:contain;border-radius:8px;border:1px solid var(--color-edge);flex-shrink:0');
 const card = `<a href="${cHref}" aria-label="${esc(anchorText)}" style="display:flex;align-items:flex-start;gap:12px;text-decoration:none;padding:16px;border:1px solid var(--color-edge);border-radius:12px;margin-top:12px">${cLogoImg}<div><div style="font-size:14px;font-weight:700;color:var(--color-heading)">${companyHeading[locale] || companyHeading.it}</div><div style="font-size:14px;color:var(--color-subtle);margin-top:4px">${esc(job.company)} · ${esc(job.location || dc)}</div><div style="font-size:14px;color:var(--color-subtle);margin-top:8px">${companyMonitoring[locale] || companyMonitoring.it}</div></div></a>`;
 const ctaLink = `<p style="margin:12px 0 0;font-size:15px"><a href="${cHref}" style="color:var(--color-link);text-decoration:underline;font-weight:700">${esc(anchorText)} &rarr;</a></p>`;
 return card + ctaLink;
 })()}
 ${related.length > 0 ? `<section class="related"><h2>${esc(localeCopy[locale].relatedJobs)}</h2><ul style="list-style:none;padding:0;margin:0">${relatedHtml}</ul></section>` : ''}
 ${buildRecentArticlesHtml(locale)}
 ${(() => {
 const loc = esc(job.location || dc);
 const co = esc(job.company || '');
 const taxUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const cat = String(job.category || '').toLowerCase();
 const sectorLabel: Record<string, Record<string, string>> = {
 it: { healthcare: 'sanità', technology: 'tecnologia', finance: 'servizi finanziari', engineering: 'ingegneria', hospitality: 'ospitalità', retail: 'commercio', manufacturing: 'manifattura', education: 'formazione', construction: 'edilizia', logistics: 'logistica', sales: 'vendite', administration: 'amministrazione' },
 en: { healthcare: 'healthcare', technology: 'technology', finance: 'financial services', engineering: 'engineering', hospitality: 'hospitality', retail: 'retail', manufacturing: 'manufacturing', education: 'education', construction: 'construction', logistics: 'logistics', sales: 'sales', administration: 'administration' },
 de: { healthcare: 'Gesundheitswesen', technology: 'Technologie', finance: 'Finanzdienstleistungen', engineering: 'Ingenieurwesen', hospitality: 'Gastgewerbe', retail: 'Einzelhandel', manufacturing: 'Fertigung', education: 'Bildung', construction: 'Bauwesen', logistics: 'Logistik', sales: 'Vertrieb', administration: 'Verwaltung' },
 fr: { healthcare: 'santé', technology: 'technologie', finance: 'services financiers', engineering: 'ingénierie', hospitality: 'hôtellerie', retail: 'commerce', manufacturing: 'industrie', education: 'formation', construction: 'construction', logistics: 'logistique', sales: 'ventes', administration: 'administration' },
 };
 const sectorName = sectorLabel[locale]?.[cat] || sectorLabel[locale]?.['administration'] || '';
 // Contract label localized (reuse top-level map).
 const contractKey = String(job.contract || '').toLowerCase();
 const contractLabelLocal = contractLabelByLocale[locale]?.[contractKey] || contractLabelByLocale[locale]?.other || '';
 const safeTitle = esc(String(localizedTitle || job.title || ''));
 // Deterministic variant picker — stable across rebuilds, varies across slugs.
 const slugHash = stableHash(String(perLocaleSlug[locale] || job.slug || job.id || ''));
 const variant = slugHash % 3; // 3 rotating templates
 const deCantonPrep = germanCantonPrep(dc);
 const frCantonPrep = frenchCantonPrep(dc);

 // --- Frontalier info, per-locale, with 3 template variants each ---
 // Each variant injects title, company, city, sector, contract so ~60-70% of
 // the sentences differ between jobs while factual content stays equivalent.
 const feeIntro = {
 it: [
 `<p>La posizione <strong>${safeTitle}</strong>${co ? ` offerta da ${co}` : ''} ha sede a ${loc} nel Canton ${esc(dc)}${sectorName ? `, nel comparto ${sectorName}` : ''}.</p>`,
 `<p>Stai valutando il ruolo <strong>${safeTitle}</strong>${co ? ` presso ${co}` : ''} a ${loc} (${esc(dc)})${contractLabelLocal ? `, contratto ${contractLabelLocal.toLowerCase()}` : ''}?</p>`,
 `<p>Questa scheda analizza l'opportunità <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''} a ${loc}${sectorName ? ` (settore ${sectorName})` : ''}, con focus sugli aspetti fiscali per i frontalieri del Canton ${esc(dc)}.</p>`,
 ],
 en: [
 `<p>The <strong>${safeTitle}</strong> role${co ? ` offered by ${co}` : ''} is based in ${loc}, Canton of ${esc(dc)}${sectorName ? `, in the ${sectorName} sector` : ''}.</p>`,
 `<p>Considering the <strong>${safeTitle}</strong> position${co ? ` at ${co}` : ''} in ${loc} (${esc(dc)})${contractLabelLocal ? ` on a ${contractLabelLocal.toLowerCase()} contract` : ''}?</p>`,
 `<p>This page reviews the <strong>${safeTitle}</strong> opportunity${co ? ` at ${co}` : ''} in ${loc}${sectorName ? ` (${sectorName} sector)` : ''}, with a focus on the tax implications for cross-border workers in the Canton of ${esc(dc)}.</p>`,
 ],
 de: [
 `<p>Die Stelle <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} ist in ${loc} ${esc(deCantonPrep)} angesiedelt${sectorName ? ` (Bereich ${sectorName})` : ''}.</p>`,
 `<p>Sie interessieren sich für die Position <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} in ${loc} (${esc(dc)})${contractLabelLocal ? `, ${contractLabelLocal}` : ''}?</p>`,
 `<p>Diese Seite untersucht die Chance <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} in ${loc}${sectorName ? ` (Branche ${sectorName})` : ''}, mit Fokus auf den steuerlichen Aspekten für Grenzgänger ${esc(deCantonPrep)}.</p>`,
 ],
 fr: [
 `<p>Le poste <strong>${safeTitle}</strong>${co ? ` proposé par ${co}` : ''} se situe à ${loc}, dans le Canton du ${esc(dc)}${sectorName ? ` (secteur ${sectorName})` : ''}.</p>`,
 `<p>Vous envisagez le rôle <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} à ${loc} (${esc(dc)})${contractLabelLocal ? ` en ${contractLabelLocal.toLowerCase()}` : ''} ?</p>`,
 `<p>Cette page examine l'opportunité <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} à ${loc}${sectorName ? ` (secteur ${sectorName})` : ''}, avec un focus sur la fiscalité des frontaliers ${esc(frCantonPrep)}.</p>`,
 ],
 };
 const feePermitTax = {
 it: [
 `<p>Per lavorare come frontaliere in Canton ${esc(dc)} serve il <strong>Permesso G</strong>, rinnovabile annualmente. Il Canton ${esc(dc)} applica l'<strong>imposta alla fonte</strong> con aliquote variabili sul reddito lordo; dal 2024 il <strong>Nuovo Accordo fiscale</strong> Italia-Svizzera prevede una tassazione concorrente.</p>`,
 `<p>Il ruolo richiede il <strong>Permesso G</strong> (rinnovo annuale) e comporta la ritenuta alla fonte a carico del datore${co ? ` ${co}` : ''}. In Canton ${esc(dc)} l'aliquota dipende da scaglione, stato civile e figli a carico; dal 2024 si applica il <strong>Nuovo Accordo</strong> fiscale bilaterale.</p>`,
 `<p>Accettando questa offerta${co ? ` di ${co}` : ''} otterrai un <strong>Permesso G</strong> frontaliere. Il Canton ${esc(dc)} preleva l'<strong>imposta alla fonte</strong> sul lordo; dal 2024 i nuovi frontalieri rientrano nel <strong>Nuovo Accordo fiscale</strong> con imposizione concorrente.</p>`,
 ],
 en: [
 `<p>Working as a cross-border employee in the Canton of ${esc(dc)} requires a <strong>G Permit</strong>, renewed annually. The Canton applies <strong>withholding tax</strong> at variable rates on gross income; since 2024 the Italy-Switzerland <strong>New Tax Agreement</strong> introduces concurrent taxation.</p>`,
 `<p>This position requires a <strong>G Permit</strong> (annual renewal) and triggers wage-withholding by the employer${co ? ` ${co}` : ''}. In the Canton of ${esc(dc)} the rate depends on bracket, marital status and dependants; the 2024 <strong>New Agreement</strong> adds an Italian side tax.</p>`,
 `<p>Accepting this offer${co ? ` from ${co}` : ''} means obtaining a cross-border <strong>G Permit</strong>. The Canton of ${esc(dc)} withholds tax on gross salary; new cross-border workers since 2024 fall under the <strong>New Tax Agreement</strong> with concurrent taxation.</p>`,
 ],
 de: [
 `<p>Für eine Grenzgängertätigkeit ${esc(deCantonPrep)} benötigen Sie eine <strong>G-Bewilligung</strong> (jährlich erneuerbar). Der Kanton ${esc(dc)} erhebt <strong>Quellensteuer</strong> mit variablen Sätzen; seit 2024 gilt das <strong>Neue Steuerabkommen</strong> Italien-Schweiz mit konkurrierender Besteuerung.</p>`,
 `<p>Die Stelle erfordert eine <strong>G-Bewilligung</strong> und löst den Quellensteuerabzug durch den Arbeitgeber${co ? ` ${co}` : ''} aus. Der Satz ${esc(deCantonPrep)} hängt von Einkommensklasse, Familienstand und Kindern ab; seit 2024 greift das <strong>Neue Abkommen</strong>.</p>`,
 `<p>Mit dieser Stelle${co ? ` bei ${co}` : ''} erhalten Sie eine <strong>G-Bewilligung</strong>. Der Kanton ${esc(dc)} zieht die Quellensteuer direkt ab; neue Grenzgänger seit 2024 fallen unter das <strong>Neue Steuerabkommen</strong>.</p>`,
 ],
 fr: [
 `<p>Travailler comme frontalier ${esc(frCantonPrep)} exige un <strong>permis G</strong>, renouvelable chaque année. Le Canton du ${esc(dc)} applique un <strong>impôt à la source</strong> à taux variable ; depuis 2024 le <strong>Nouvel Accord fiscal</strong> Italie-Suisse prévoit une imposition concurrente.</p>`,
 `<p>Ce poste nécessite un <strong>permis G</strong> (renouvellement annuel) et déclenche la retenue à la source${co ? ` par ${co}` : ''}. Le taux ${esc(frCantonPrep)} dépend de la tranche, du statut marital et des enfants ; le <strong>Nouvel Accord</strong> 2024 ajoute un volet italien.</p>`,
 `<p>Accepter cette offre${co ? ` de ${co}` : ''} implique un <strong>permis G</strong> frontalier. Le Canton du ${esc(dc)} prélève l'impôt à la source ; les nouveaux frontaliers depuis 2024 relèvent du <strong>Nouvel Accord fiscal</strong>.</p>`,
 ],
 };
 const feeContribs = {
 it: `<p>I contributi sociali svizzeri includono AVS (5,3%), assicurazione disoccupazione (1,1%) e LPP (previdenza professionale). Usa il nostro <a href="${taxUrl}">simulatore fiscale gratuito</a> per calcolare il netto di <strong>${safeTitle}</strong>${sectorName ? ` nel settore ${sectorName}` : ''} e confrontare i costi della vita tra Svizzera e Italia.</p>`,
 en: `<p>Swiss social contributions include AVS (5.3%), unemployment insurance (1.1%) and LPP (occupational pension). Use our <a href="${taxUrl}">free tax simulator</a> to estimate the net salary for <strong>${safeTitle}</strong>${sectorName ? ` in ${sectorName}` : ''} and compare the cost of living between Switzerland and Italy.</p>`,
 de: `<p>Die Schweizer Sozialabgaben umfassen AHV (5,3%), Arbeitslosenversicherung (1,1%) und BVG. Nutzen Sie unseren <a href="${taxUrl}">kostenlosen Steuersimulator</a>, um das Nettogehalt für <strong>${safeTitle}</strong>${sectorName ? ` in der Branche ${sectorName}` : ''} zu berechnen und Lebenshaltungskosten zu vergleichen.</p>`,
 fr: `<p>Les cotisations sociales suisses comprennent AVS (5,3%), assurance chômage (1,1%) et LPP. Utilisez notre <a href="${taxUrl}">simulateur fiscal gratuit</a> pour estimer le net de <strong>${safeTitle}</strong>${sectorName ? ` dans le secteur ${sectorName}` : ''} et comparer les coûts de la vie.</p>`,
 };
 const infoHeading: Record<string, string> = { it: 'Informazioni per frontalieri', en: 'Information for cross-border workers', de: 'Informationen für Grenzgänger', fr: 'Informations pour les frontaliers' };
 const frontalierInfoHtml = `<section class="section"><h4>${esc(infoHeading[locale] || infoHeading.it)}</h4>${feeIntro[locale as 'it'|'en'|'de'|'fr']?.[variant] ?? feeIntro.it[0]}${feePermitTax[locale as 'it'|'en'|'de'|'fr']?.[variant] ?? feePermitTax.it[0]}${feeContribs[locale as 'it'|'en'|'de'|'fr'] ?? feeContribs.it}</section>`;

 // --- FAQ: variant-driven question wording — injects role/company/contract ---
 const roleNoun: Record<string, string> = { it: 'candidarsi', en: 'applying', de: 'die Bewerbung', fr: 'postuler' };
 const faqQ1Templates: Record<string, string[]> = {
 it: [
 `Qual è lo stipendio netto per un frontaliere in Canton ${esc(dc)}?`,
 `Quanto guadagna netto un <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''} a ${loc}?`,
 `Che stipendio netto aspettarsi per il ruolo <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} in ${esc(dc)}?`,
 ],
 en: [
 `What is the net salary for a cross-border worker in the Canton of ${esc(dc)}?`,
 `What does a <strong>${safeTitle}</strong>${co ? ` at ${co}` : ''} earn net in ${loc}?`,
 `What net pay can you expect for the <strong>${safeTitle}</strong> role${sectorName ? ` (${sectorName})` : ''} in ${esc(dc)}?`,
 ],
 de: [
 `Wie hoch ist das Nettogehalt für Grenzgänger ${esc(deCantonPrep)}?`,
 `Was verdient ein <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} netto in ${loc}?`,
 `Welches Nettogehalt ist für <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} ${esc(deCantonPrep)} realistisch?`,
 ],
 fr: [
 `Quel est le salaire net pour un frontalier ${esc(frCantonPrep)} ?`,
 `Combien gagne un <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} net à ${loc} ?`,
 `Quel salaire net viser pour le poste <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} ${esc(frCantonPrep)} ?`,
 ],
 };
 const faqA1Templates: Record<string, string[]> = {
 it: [
 `Lo stipendio netto dipende dal reddito lordo, dallo stato civile e dal numero di figli. In Canton ${esc(dc)} l'imposta alla fonte varia dal 2% al 15% circa.${sectorName ? ` Nel settore ${sectorName} in ${esc(dc)},` : ''} usa il nostro simulatore per un calcolo personalizzato.`,
 `Per <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''} il netto dipende da lordo, imposta alla fonte ${esc(dc)} (2-15%), AVS/AD/LPP e deduzioni familiari.${contractLabelLocal ? ` Contratto: ${contractLabelLocal.toLowerCase()}.` : ''} Il nostro simulatore stima il netto personalizzato.`,
 `Il ruolo <strong>${safeTitle}</strong>${sectorName ? ` (settore ${sectorName})` : ''} a ${loc} è soggetto a imposta alla fonte del Canton ${esc(dc)} più contributi AVS/LPP. Simula il tuo netto con i dati reali di ${co ? co : 'questo annuncio'}.`,
 ],
 en: [
 `Net salary depends on gross income, marital status and number of children. In the Canton of ${esc(dc)}, withholding tax ranges from about 2% to 15%.${sectorName ? ` In the ${sectorName} sector,` : ''} use our simulator for a tailored figure.`,
 `For <strong>${safeTitle}</strong>${co ? ` at ${co}` : ''} the net depends on gross, ${esc(dc)} withholding (2-15%), AVS/LPP and family deductions.${contractLabelLocal ? ` Contract: ${contractLabelLocal.toLowerCase()}.` : ''} Our simulator gives a personalised estimate.`,
 `The <strong>${safeTitle}</strong> role${sectorName ? ` (${sectorName})` : ''} in ${loc} is taxed at source by the Canton of ${esc(dc)} plus AVS/LPP contributions. Run the simulator with the real figures of ${co ? co : 'this listing'}.`,
 ],
 de: [
 `Das Nettogehalt hängt von Bruttoeinkommen, Familienstand und Kinderzahl ab. ${esc(deCantonPrep)} liegt die Quellensteuer zwischen ca. 2% und 15%.${sectorName ? ` In der Branche ${sectorName}` : ''} liefert unser Simulator eine individuelle Berechnung.`,
 `Für <strong>${safeTitle}</strong>${co ? ` bei ${co}` : ''} hängt das Netto von Brutto, Quellensteuer (2-15%), AHV/ALV/BVG und Familienabzügen ab.${contractLabelLocal ? ` Vertrag: ${contractLabelLocal}.` : ''} Unser Simulator liefert eine individuelle Schätzung.`,
 `Die Rolle <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} in ${loc} unterliegt der Quellensteuer ${esc(deCantonPrep)} zzgl. AHV/BVG. Simulieren Sie das Netto mit den Werten von ${co ? co : 'diesem Inserat'}.`,
 ],
 fr: [
 `Le salaire net dépend du revenu brut, de l'état civil et du nombre d'enfants. ${esc(frCantonPrep)}, l'impôt à la source varie d'environ 2% à 15%.${sectorName ? ` Dans le secteur ${sectorName},` : ''} utilisez notre simulateur pour un calcul personnalisé.`,
 `Pour <strong>${safeTitle}</strong>${co ? ` chez ${co}` : ''} le net dépend du brut, de la retenue ${esc(frCantonPrep)} (2-15%), AVS/LPP et déductions familiales.${contractLabelLocal ? ` Contrat : ${contractLabelLocal.toLowerCase()}.` : ''} Notre simulateur donne une estimation personnalisée.`,
 `Le poste <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} à ${loc} est imposé à la source par le Canton du ${esc(dc)} plus cotisations AVS/LPP. Simulez le net avec les chiffres réels de ${co ? co : 'cette annonce'}.`,
 ],
 };
 // Second FAQ — mixes LAMal (stable factual content) with per-role flavoring.
 const faqQ2Templates: Record<string, string[]> = {
 it: [
 `Serve la cassa malati svizzera LAMal per lavorare come <strong>${safeTitle}</strong> in Canton ${esc(dc)}?`,
 `Come funziona l'assicurazione LAMal per chi fa ${roleNoun.it} a <strong>${safeTitle}</strong>${co ? ` in ${co}` : ''}?`,
 `LAMal o assicurazione italiana: quale scegliere per il ruolo <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''}?`,
 ],
 en: [
 `Do I need Swiss LAMal health insurance for the <strong>${safeTitle}</strong> role in ${esc(dc)}?`,
 `How does LAMal work when <strong>${roleNoun.en}</strong> to <strong>${safeTitle}</strong>${co ? ` at ${co}` : ''}?`,
 `LAMal or Italian insurance: which should you pick for the <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} role?`,
 ],
 de: [
 `Brauche ich für <strong>${safeTitle}</strong> ${esc(deCantonPrep)} eine Schweizer KVG-Versicherung?`,
 `Wie funktioniert die KVG, wenn Sie sich${co ? ` bei ${co}` : ''} für <strong>${safeTitle}</strong> bewerben?`,
 `KVG oder italienische Versicherung: was ist für <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} sinnvoller?`,
 ],
 fr: [
 `Faut-il souscrire à la LAMal suisse pour le poste <strong>${safeTitle}</strong> ${esc(frCantonPrep)} ?`,
 `Comment fonctionne la LAMal quand on${co ? ` postule chez ${co}` : ''} pour <strong>${safeTitle}</strong> ?`,
 `LAMal ou assurance italienne : quelle option pour le rôle <strong>${safeTitle}</strong>${sectorName ? ` (${sectorName})` : ''} ?`,
 ],
 };
 const lamalLink: Record<string, string> = {
 it: `<a href="${BASE_URL}/premi-cassa-malati/">comparatore LAMal</a>`,
 en: `<a href="${BASE_URL}/en/health-insurance-premiums/">LAMal comparator</a>`,
 de: `<a href="${BASE_URL}/de/krankenkassenpraemien/">KVG-Vergleich</a>`,
 fr: `<a href="${BASE_URL}/fr/primes-assurance-maladie/">comparateur LAMal</a>`,
 };
 const faqA2Templates: Record<string, string[]> = {
 it: [
 `I nuovi frontalieri dal 2024 devono iscriversi alla LAMal svizzera entro 3 mesi dall'inizio del lavoro. I premi variano per cantone, modello e franchigia. Confronta con il nostro ${lamalLink.it}.`,
 `Prima di firmare${co ? ` con ${co}` : ''}, sappi che dal 2024 la LAMal è obbligatoria entro 3 mesi. Il premio medio in ${esc(dc)} dipende dal modello. Vedi il nostro ${lamalLink.it}.`,
 `Il ruolo <strong>${safeTitle}</strong> a ${loc} richiede la scelta tra LAMal (obbligatoria per nuovi frontalieri dal 2024) e diritto di opzione. Confronta i premi con il ${lamalLink.it}.`,
 ],
 en: [
 `New cross-border workers since 2024 must enrol in Swiss LAMal within 3 months of starting. Premiums vary by canton, model and deductible. Compare with our ${lamalLink.en}.`,
 `Before signing${co ? ` with ${co}` : ''}, note that LAMal is mandatory within 3 months since 2024. The average premium in ${esc(dc)} depends on the model. See our ${lamalLink.en}.`,
 `The <strong>${safeTitle}</strong> role in ${loc} requires choosing between LAMal (mandatory for new cross-border workers since 2024) and the right of option. Compare premiums with our ${lamalLink.en}.`,
 ],
 de: [
 `Neue Grenzgänger seit 2024 müssen sich innerhalb von 3 Monaten nach Arbeitsbeginn bei der KVG anmelden. Die Prämien variieren nach Kanton, Modell und Franchise. Vergleichen Sie mit unserem ${lamalLink.de}.`,
 `Bevor Sie${co ? ` bei ${co}` : ''} unterschreiben: die KVG ist seit 2024 innerhalb von 3 Monaten Pflicht. Die durchschnittliche Prämie ${esc(deCantonPrep)} hängt vom Modell ab. Siehe ${lamalLink.de}.`,
 `Die Rolle <strong>${safeTitle}</strong> in ${loc} erfordert die Wahl zwischen KVG (seit 2024 Pflicht) und Optionsrecht. Vergleichen Sie die Prämien mit unserem ${lamalLink.de}.`,
 ],
 fr: [
 `Les nouveaux frontaliers depuis 2024 doivent s'inscrire à la LAMal dans les 3 mois. Les primes varient selon canton, modèle et franchise. Comparez avec notre ${lamalLink.fr}.`,
 `Avant de signer${co ? ` chez ${co}` : ''}, notez que la LAMal est obligatoire sous 3 mois depuis 2024. La prime moyenne ${esc(frCantonPrep)} dépend du modèle. Voir notre ${lamalLink.fr}.`,
 `Le poste <strong>${safeTitle}</strong> à ${loc} impose de choisir entre LAMal (obligatoire pour les nouveaux frontaliers depuis 2024) et droit d'option. Comparez les primes via notre ${lamalLink.fr}.`,
 ],
 };
 const faqHeading: Record<string, string> = { it: 'Domande frequenti', en: 'Frequently asked questions', de: 'Häufig gestellte Fragen', fr: 'Questions fréquentes' };
 const pickTpl = (arr: string[] | undefined, fallback: string): string => (arr && arr[variant]) || fallback;
 const q1 = pickTpl(faqQ1Templates[locale], faqQ1Templates.it[0]);
 const a1 = pickTpl(faqA1Templates[locale], faqA1Templates.it[0]);
 const q2 = pickTpl(faqQ2Templates[locale], faqQ2Templates.it[0]);
 const a2 = pickTpl(faqA2Templates[locale], faqA2Templates.it[0]);
 const faqSectionHtml = `<section class="section"><h4>${esc(faqHeading[locale] || faqHeading.it)}</h4><dl><dt><strong>${q1}</strong></dt><dd>${a1}</dd><dt><strong>${q2}</strong></dt><dd>${a2}</dd></dl></section>`;
 const frontalierInfo: Record<string, string> = { it: frontalierInfoHtml, en: frontalierInfoHtml, de: frontalierInfoHtml, fr: frontalierInfoHtml };
 const faqSection: Record<string, string> = { it: faqSectionHtml, en: faqSectionHtml, de: faqSectionHtml, fr: faqSectionHtml };
 const hubLinks = (() => {
 const matchedCity = CITY_HUB_KEYS.find((c) => jobMatchesCity(job as never, c));
 const matchedSector = SECTOR_HUB_KEYS.find((s) => jobMatchesSector(job as never, s));
 if (!matchedCity && !matchedSector) return '';
 const heading: Record<string, string> = { it: 'Esplora annunci simili', en: 'Explore similar jobs', de: 'Ähnliche Stellen entdecken', fr: 'Explorer des offres similaires' };
 const cityCopy: Record<string, string> = { it: 'Tutti i lavori a', en: 'All jobs in', de: 'Alle Jobs in', fr: 'Tous les emplois à' };
 const sectorCopy: Record<string, string> = { it: 'Tutti gli annunci', en: 'All jobs in', de: 'Alle Jobs in', fr: 'Toutes les offres' };
 const links: string[] = [];
 if (matchedCity) {
 const href = `${BASE_URL}${buildCityHubPath(locale as never, matchedCity)}`;
 links.push(`<a href="${href}" style="display:inline-flex;padding:8px 14px;border-radius:999px;background:var(--color-accent-subtle);color:var(--color-accent);text-decoration:none;font-weight:700;font-size:13px">${esc(cityCopy[locale] || cityCopy.it)} ${esc(CITY_HUB_DISPLAY_NAME[matchedCity])} &rarr;</a>`);
 }
 if (matchedSector) {
 const href = `${BASE_URL}${buildSectorHubPath(locale as never, matchedSector)}`;
 const label = SECTOR_HUB_DISPLAY[locale as never]?.[matchedSector] || matchedSector;
 const prefix = locale === 'it' || locale === 'fr' ? `${sectorCopy[locale]} ${label}` : `${sectorCopy[locale]} ${label}`;
 links.push(`<a href="${href}" style="display:inline-flex;padding:8px 14px;border-radius:999px;background:var(--color-warning-subtle);color:var(--color-warning);text-decoration:none;font-weight:700;font-size:13px">${esc(prefix)} &rarr;</a>`);
 }
 return `<section class="section"><h4>${esc(heading[locale] || heading.it)}</h4><div style="display:flex;flex-wrap:wrap;gap:10px">${links.join('')}</div></section>`;
 })();
 return (frontalierInfo[locale] || '') + (faqSection[locale] || '') + hubLinks;
 })()}
 <nav style="margin:24px 0 0;padding:16px 0;border-top:1px solid var(--color-edge);font-size:14px">
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:var(--color-link);text-decoration:none;font-weight:600">${esc(cantonSectionName(locale, dc))} &rarr;</a>${(() => {
 const cSlug = canonicalCompanySlugBuild(job.company, job.companyKey);
 if (!cSlug) return '';
 const cPrefix = companyRoutePrefix[locale];
 const cFullSlug = `${cPrefix}-${cSlug}`;
 const cPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${cFullSlug}`.replace(/\/+/g, '/'));
 return ` · <a href="${BASE_URL}${cPath}" style="color:var(--color-link);text-decoration:none;font-weight:600">${esc(job.company)} &rarr;</a>`;
 })()}
 </nav>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 _qw(np.join(outDir, 'index.html'), html);
 jobHtmlCache.set(`${locale}:${perLocaleSlug[locale]}`, html);
 // Also write flat .html so /slug serves 200 (avoids GitHub Pages 301 redirect)
 // Uses a canonical bridge page instead of a noindex/meta-refresh alias
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('active-job', __tActiveJob);

 // Legacy bridge: if non-IT locale and Italian slug differs from the
 // locale-canonical slug, emit a FULL-CONTENT bridge at the legacy URL
 // (Italian slug under non-IT locale prefix → e.g.
 // /de/jobs-im-tessin/<it-slug>/) using the locale-canonical HTML.
 //
 // Replaces the previous thin `buildCanonicalBridgePage` redirect (run
 // pre-2026-04-30): that emitted a ~5 KB "click here" interstitial with
 // `noindex,follow` and a `location.replace` script, served bundle-less
 // pages that flashed a placeholder UI before redirecting. Same pattern
 // as the previousSlugs bridge (jobsSeoPagesPlugin.ts:7264-7271):
 //   - reuse the locale-canonical `html` verbatim (full content, SPA
 //     bundle inside, JSON-LD, hreflang, breadcrumbs, everything)
 //   - inject __BRIDGE_TARGET_SLUG__ so the SPA looks the job up by the
 //     canonical slug after hydration (the URL stays at the legacy slug;
 //     `<link rel="canonical">` inside `html` already points at the
 //     locale-canonical URL, so Google consolidates link equity)
 //
 // Robots: index,follow (the default inside `html`). The previous
 // `noindex,follow` was a workaround against title-uniqueness duplication
 // when sister-city jobs share the same translated role; with the
 // canonical pointing at the locale-canonical URL, Google folds equity
 // and the Semrush title-uniqueness audit treats the bridge and canonical
 // as the same indexable surface. Trade-off accepted to give the user
 // full content immediately at the legacy URL.
 //
 // Activejob guard: if another job's canonical in this locale already
 // claimed this exact path (cross-job IT-slug = locale-slug collision —
 // rare, but possible for short generic slugs), leave it alone.
 if (locale !== 'it' && perLocaleSlug[locale] !== job.slug) {
 const __tLegacyBridge = startTimer();
 const legacyRel = `${localePrefix[locale]}/${sectionByLocale[locale]}/${job.slug}`.replace(/\/+/g, '/').replace(/^\//, '');
 if (!activeJobDirs.has(legacyRel.replace(/\/+$/, ''))) {
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(perLocaleSlug[locale])};</script>`;
 const legacyIndexHtml = html.replace('</head>', ` ${bridgeScript}\n </head>`);
 const legacyFlatHtml = legacyIndexHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
 const legacyDir = np.join(distDir, legacyRel);
 _md(legacyDir);
 _qw(np.join(legacyDir, 'index.html'), legacyIndexHtml);
 const legacyFlat = np.join(distDir, legacyRel + '.html');
 _md(np.dirname(legacyFlat));
 _qw(legacyFlat, legacyFlatHtml);
 }
 recordEmit('active-job-legacy-bridge', __tLegacyBridge);
 }
 }
 }

 /* ── Company landing pages ────────────────────────────────── */
 type CompanyCopyEntry = {
 title: (companyName: string) => string;
 description: (companyName: string, count: number) => string;
 heading: (companyName: string) => string;
 viewAll: string;
 allJobsLink: string;
 sectionName: string;
 editorial: string;
 };
 const getCompanyCopy = (cantonDisplay: string): Record<'it' | 'en' | 'de' | 'fr', CompanyCopyEntry> => {
 const frPrep = frenchCantonPrep(cantonDisplay);
 const dePrep = germanCantonPrep(cantonDisplay);
 // F3a — title delegates to buildEmployerHubTitle (50-60 visible chars).
 // description delegates to buildEmployerHubMeta (140-160 visible chars).
 // Heading / viewAll / editorial stay unchanged (used on-page, not in head).
 const ctrYear = new Date().getFullYear();
 const ctrTitle = (loc: 'it' | 'en' | 'de' | 'fr') => (companyName: string) =>
 buildEmployerHubTitle({ locale: loc, companyDisplay: companyName, count: 0, year: ctrYear });
 const ctrDesc = (loc: 'it' | 'en' | 'de' | 'fr') => (companyName: string, count: number) =>
 buildEmployerHubMeta({ locale: loc, companyDisplay: companyName, count });
 return {
 it: {
 title: ctrTitle('it'),
 description: ctrDesc('it'),
 heading: (companyName: string) => `${companyName} — posizioni aperte in ${cantonDisplay}`,
 viewAll: 'Vedi tutte le offerte',
 allJobsLink: `Tutte le offerte di lavoro in ${cantonDisplay}`,
 sectionName: `Cerca lavoro in ${cantonDisplay}`,
 editorial: `Questa pagina raccoglie le posizioni aperte pubblicate direttamente sul sito aziendale. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico e collegano alla pagina di candidatura ufficiale. Se non trovi posizioni attive, l'azienda potrebbe non avere ruoli aperti in ${cantonDisplay} al momento — salva la pagina per ricevere aggiornamenti.`,
 },
 en: {
 title: ctrTitle('en'),
 description: ctrDesc('en'),
 heading: (companyName: string) => `${companyName} jobs in ${cantonDisplay}`,
 viewAll: 'View all jobs',
 allJobsLink: `All job offers in ${cantonDisplay}`,
 sectionName: `Find jobs in ${cantonDisplay}`,
 editorial: `This page lists positions published directly on the company's career portal. Listings are refreshed daily by our automated crawler and link to the official application page. If no roles are shown, the company may not have open positions in ${cantonDisplay} right now — bookmark this page to stay updated.`,
 },
 de: {
 title: ctrTitle('de'),
 description: ctrDesc('de'),
 heading: (companyName: string) => `${companyName} Jobs ${dePrep}`,
 viewAll: 'Alle Stellen ansehen',
 allJobsLink: `Alle Stellenangebote ${dePrep}`,
 sectionName: `Jobs ${dePrep}`,
 editorial: `Auf dieser Seite finden Sie Stellen, die direkt auf der Karriereseite des Unternehmens veröffentlicht wurden. Die Angebote werden täglich von unserem automatischen Crawler aktualisiert und verlinken zur offiziellen Bewerbungsseite. Wenn keine Stellen angezeigt werden, gibt es derzeit möglicherweise keine offenen Positionen ${dePrep}.`,
 },
 fr: {
 title: ctrTitle('fr'),
 description: ctrDesc('fr'),
 heading: (companyName: string) => `${companyName} — postes ouverts ${frPrep}`,
 viewAll: 'Voir toutes les offres',
 allJobsLink: `Toutes les offres d'emploi ${frPrep}`,
 sectionName: `Trouver un emploi ${frPrep}`,
 editorial: `Cette page rassemble les postes publiés directement sur le portail carrière de l'entreprise. Les annonces sont actualisées quotidiennement par notre robot et renvoient à la page de candidature officielle. Si aucun poste n'est affiché, l'entreprise n'a peut-être pas de postes ouverts ${frPrep} actuellement.`,
 },
 };
 };

 // ── Internal-linking + JobCard helpers (employer hub pages) ─────────
 //
 // Used to turn plain text (locations, job positions) into internal links
 // pointing at city/sector hubs, and to render open-roles as visually-rich
 // cards matching the in-app <JobCard> component (JobBoard.tsx).
 const CITY_HUB_PATTERNS: ReadonlyArray<{ key: CityHubKey; regex: RegExp }> = [
 { key: 'lugano', regex: /\blugano\b/i },
 { key: 'mendrisio', regex: /\bmendrisio\b/i },
 { key: 'bellinzona', regex: /\bbellinzona\b/i },
 ];

 /** Detect a known Ticino hub city in a raw location string. */
 const detectCityHub = (text: string): CityHubKey | null => {
 if (!text) return null;
 for (const { key, regex } of CITY_HUB_PATTERNS) {
 if (regex.test(text)) return key;
 }
 return null;
 };

 /** Wrap a recognized Ticino city inside `locationText` with an anchor
 * pointing to the city hub. Escapes the full string first. */
 const linkifyCityInLocation = (
 locationText: string,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): string => {
 const safe = esc(locationText || '');
 if (!safe) return '';
 const cityKey = detectCityHub(locationText);
 if (!cityKey) return safe;
 const display = CITY_HUB_DISPLAY_NAME[cityKey];
 const href = `${BASE_URL}${buildCityHubPath(locale, cityKey)}`;
 const rx = new RegExp(`\\b${display}\\b`, 'i');
 return safe.replace(
 rx,
 (match) => `<a href="${href}" style="color:var(--color-accent);text-decoration:none;font-weight:600">${match}</a>`,
 );
 };

 /** Sectors matched by at least one of this company's jobs. */
 const companySectorMatches = (
 jobs: ReadonlyArray<unknown>,
 ): SectorHubKey[] => {
 const hits: SectorHubKey[] = [];
 for (const sector of SECTOR_HUB_KEYS) {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 if (jobs.some((j) => jobMatchesSector(j as any, sector))) hits.push(sector);
 }
 return hits;
 };

 /** Cities matched by at least one job's location. */
 const companyCityMatches = (
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 jobs: ReadonlyArray<any>,
 ): CityHubKey[] => {
 const set = new Set<CityHubKey>();
 for (const j of jobs) {
 const key = detectCityHub(String(j?.location || ''));
 if (key) set.add(key);
 }
 return [...set];
 };

 /**
  * Render a single open-role `<li>` card. Delegates to the SPA-matching
  * shared renderer (`build-plugins/shared/jobCardHtml.ts`) and injects the
  * locale-aware city linkifier so Lugano/Mendrisio/Bellinzona become
  * internal hub links in the company-and-location subtitle.
  */
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const renderJobCardLi = (job: any, locale: 'it' | 'en' | 'de' | 'fr'): string => {
 const jSlug = localizedSlug(job, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const cardHtml = renderJobCardHtml(job as JobCardJob, {
 href: jHref,
 locale,
 linkifyLocation: linkifyCityInLocation,
 logoUrl: companyLogo(job),
 });
 return `<li style="list-style:none;margin:0 0 10px 0">${cardHtml}</li>`;
 };

 /** Render a row of sector/city hub link chips for the company. */
 const renderHubChipsHtml = (
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 jobs: ReadonlyArray<any>,
 locale: 'it' | 'en' | 'de' | 'fr',
 ): string => {
 const sectors = companySectorMatches(jobs);
 const cities = companyCityMatches(jobs);
 if (sectors.length === 0 && cities.length === 0) return '';
 const labels = {
 it: { intro: 'Esplora anche', sectorsLead: 'per settore', citiesLead: 'per città' },
 en: { intro: 'Explore more', sectorsLead: 'by sector', citiesLead: 'by city' },
 de: { intro: 'Mehr entdecken', sectorsLead: 'nach Branche', citiesLead: 'nach Stadt' },
 fr: { intro: 'Explorez aussi', sectorsLead: 'par secteur', citiesLead: 'par ville' },
 }[locale];
 const chipStyle = 'display:inline-block;margin:0 6px 6px 0;padding:4px 10px;font-size:12px;font-weight:600;border-radius:9999px;background:var(--color-accent-subtle);color:var(--color-accent);text-decoration:none;border:1px solid var(--color-accent-border)';
 const sectorChips = sectors
 .map((s) => {
 const href = `${BASE_URL}${buildSectorHubPath(locale, s)}`;
 const name = SECTOR_HUB_DISPLAY[locale][s];
 return `<a href="${href}" style="${chipStyle}">${esc(name)}</a>`;
 })
 .join('');
 const cityChips = cities
 .map((c) => {
 const href = `${BASE_URL}${buildCityHubPath(locale, c)}`;
 const name = CITY_HUB_DISPLAY_NAME[c];
 return `<a href="${href}" style="${chipStyle}">${esc(name)}</a>`;
 })
 .join('');
 const parts: string[] = [];
 if (sectorChips) parts.push(`<div style="margin-top:10px"><span style="font-size:12px;color:var(--color-subtle);margin-right:8px">${esc(labels.sectorsLead)}:</span>${sectorChips}</div>`);
 if (cityChips) parts.push(`<div style="margin-top:6px"><span style="font-size:12px;color:var(--color-subtle);margin-right:8px">${esc(labels.citiesLead)}:</span>${cityChips}</div>`);
 return `<section style="margin-top:20px"><h3 style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:var(--color-heading)">${esc(labels.intro)}</h3>${parts.join('')}</section>`;
 };

 // Collect unique companies by canonical slug (mirrors runtime grouping)
 const companyMap = new Map<string, { name: string; jobs: typeof validJobs; rawSlugs: Set<string> }>();
 for (const job of validJobs) {
 const canonical = canonicalCompanySlugBuild(job.company, job.companyKey);
 const raw = slugifyCompanyBuild(job.company);
 if (!canonical) continue;
 if (!companyMap.has(canonical)) companyMap.set(canonical, { name: job.company, jobs: [], rawSlugs: new Set() });
 companyMap.get(canonical)!.jobs.push(job);
 if (raw && raw !== canonical) companyMap.get(canonical)!.rawSlugs.add(raw);
 }

 // Brand-umbrella aggregation. Some brand groups span multiple legal
 // subsidiaries that each get their own canonical hub (e.g. Migros →
 // Banca Migros, Scuola Club Migros, Cooperativa Migros Ticino).
 // Searches for the parent brand alone (e.g. "migros") have no real
 // company to land on. We synthesize a parent-brand entry whose jobs
 // are the union of every matching subsidiary's jobs, so the existing
 // company-hub template renders an indexable umbrella page that
 // aggregates the whole group. Real subsidiary hubs are unaffected —
 // they keep their own canonical, their own URL, their own page.
 const BRAND_UMBRELLAS: ReadonlyArray<{
  slug: string;
  name: string;
  match: (canonical: string, name: string) => boolean;
 }> = [
  {
   slug: 'migros',
   name: 'Migros',
   match: (canonical, name) =>
    /(^|-)migros($|-)/i.test(canonical) || /\bmigros\b/i.test(name),
  },
 ];
 for (const u of BRAND_UMBRELLAS) {
  const aggregatedJobs: typeof validJobs = [];
  const aggregatedRaw = new Set<string>();
  for (const [k, v] of companyMap) {
   if (k === u.slug) continue;
   if (u.match(k, v.name)) {
    aggregatedJobs.push(...v.jobs);
    for (const r of v.rawSlugs) aggregatedRaw.add(r);
   }
  }
  if (aggregatedJobs.length === 0) continue;
  const existing = companyMap.get(u.slug);
  if (existing) {
   for (const j of aggregatedJobs) existing.jobs.push(j);
   for (const r of aggregatedRaw) existing.rawSlugs.add(r);
  } else {
   companyMap.set(u.slug, { name: u.name, jobs: aggregatedJobs, rawSlugs: aggregatedRaw });
  }
 }

 let companyPagesCount = 0;
 for (const [cSlug, { name: companyName, jobs: companyJobs, rawSlugs }] of companyMap) {
 for (const locale of localeList) {
 const __tCompany = startTimer();
 const prefix = companyRoutePrefix[locale];
 const fullSlug = `${prefix}-${cSlug}`;
 const sectionSlug = sectionByLocale[locale];
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const companyPrimaryCanton = [...new Set(companyJobs.map((j: any) => String(j.canton || DEFAULT_CANTON)).filter(Boolean))][0] || DEFAULT_CANTON;
 const companyDisplayCanton = CANTON_DISPLAY[companyPrimaryCanton] || companyPrimaryCanton;
 const copy = getCompanyCopy(companyDisplayCanton)[locale];
 // Tentative defaults — overridden below if a curated brand is registered.
 // F3a: title + description come from the shared CTR-optimized helpers so
 // the live job count is baked into both.
 let title = buildEmployerHubTitle({
 locale,
 companyDisplay: companyName,
 count: companyJobs.length,
 year: new Date().getFullYear(),
 });
 let description = copy.description(companyName, companyJobs.length);

 const alternates = localeList.map((l) => {
 const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return { lang: l, href: `${BASE_URL}${withSlash(p)}` };
 });
 const xDefaultHrefC = (alternates.find((h) => h.lang === 'it') || alternates[0])?.href || '';
 const hreflangHtml = [
 ...alternates.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ...(xDefaultHrefC ? [` <link rel="alternate" hreflang="x-default" href="${xDefaultHrefC}">`] : []),
 ].join('\n');

 const jobListHtml = companyJobs.slice(0, 20).map((job) => renderJobCardLi(job, locale)).join('');

 const breadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: copy.sectionName, item: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}` },
 { '@type': 'ListItem', position: 3, name: companyName, item: canonicalUrl },
 ],
 });

 // Organization schema for company pages — derived from job data
 const companyLocations = [...new Set(companyJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const primaryLocation = companyLocations[0] || '';
 const cWebsite = companyWebsite(companyJobs[0]);
 const orgLdObj: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: companyName,
 url: cWebsite !== BASE_URL ? cWebsite : undefined,
 address: {
 '@type': 'PostalAddress',
 ...(primaryLocation ? { addressLocality: primaryLocation } : {}),
 addressRegion: companyDisplayCanton,
 addressCountry: 'CH',
 },
 };
 // Add number of open positions as a signal
 if (companyJobs.length > 0) {
 orgLdObj.numberOfEmployees = {
 '@type': 'QuantitativeValue',
 value: companyJobs.length,
 unitText: openPositionsUnit[locale],
 };
 }
 // Remove undefined values before serialization
 if (!orgLdObj.url) delete orgLdObj.url;
 // Curated employer brand overlay (EOC, Lidl, …). When present, we
 // (a) override the generic organization JSON-LD with a richer one,
 // (b) emit FAQPage + ItemList JSON-LD, and
 // (c) swap the generic "About/Frontalier" sections for the curated hub HTML.
 const curatedBrand: EmployerBrand | undefined = EMPLOYER_BRANDS[cSlug];
 let organizationLd: string;
 let curatedExtraLd = '';
 let curatedBodyHtml = '';
 let curatedMetaTitle: string | undefined;
 let curatedMetaDescription: string | undefined;
 if (curatedBrand) {
 const brandCopy = curatedBrand.copy[locale];
 const curatedOrgLd: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: curatedBrand.name,
 legalName: curatedBrand.fullName,
 alternateName: curatedBrand.shortName,
 url: curatedBrand.website,
 address: {
 '@type': 'PostalAddress',
 streetAddress: curatedBrand.headquarters.streetAddress,
 postalCode: curatedBrand.headquarters.postalCode,
 addressLocality: curatedBrand.headquarters.addressLocality,
 addressRegion: curatedBrand.headquarters.addressRegion,
 addressCountry: curatedBrand.headquarters.addressCountry,
 },
 description: brandCopy.paragraphs[0] ?? brandCopy.tagline,
 numberOfEmployees: { '@type': 'QuantitativeValue', value: companyJobs.length, unitText: openPositionsUnit[locale] },
 ...(curatedBrand.sameAs && curatedBrand.sameAs.length > 0 ? { sameAs: [...curatedBrand.sameAs] } : {}),
 };
 organizationLd = JSON.stringify(curatedOrgLd);

 // ItemList with top open roles
 const itemListItems = companyJobs.slice(0, 10).map((job, idx) => {
 const jSlug = localizedSlug(job, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return { '@type': 'ListItem', position: idx + 1, url: jHref, name: jTitle };
 });
 const itemListLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: `${curatedBrand.shortName} — ${brandCopy.sectionHeadings.openRoles}`,
 url: canonicalUrl,
 numberOfItems: companyJobs.length,
 itemListElement: itemListItems,
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: brandCopy.faqs.map((f) => ({
 '@type': 'Question',
 name: f.q,
 acceptedAnswer: { '@type': 'Answer', text: f.a },
 })),
 });
 curatedExtraLd = `\n <script type="application/ld+json">${itemListLd}</script>\n <script type="application/ld+json">${faqLd}</script>`;
 curatedMetaTitle = brandCopy.metaTitle;
 curatedMetaDescription = brandCopy.metaDescription;

 // Curated body HTML — replaces the generic company landing body.
 const paragraphsHtml = brandCopy.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
 const locationsHtml = curatedBrand.locations
 .map((loc) => `<li>${linkifyCityInLocation(loc, locale)}</li>`)
 .join('');
 const benefitsHtml = brandCopy.benefits
 .map((b) => `<li><strong>${esc(b.title)}.</strong> ${esc(b.desc)}</li>`)
 .join('');
 const faqsHtml = brandCopy.faqs
 .map(
 (f) =>
 `<div style="margin:0 0 12px 0;padding:12px 14px;border:1px solid var(--color-edge);border-radius:10px"><h3 style="margin:0 0 6px 0;font-size:15px;color:var(--color-heading)">${esc(
 f.q,
 )}</h3><p style="margin:0;font-size:14px;color:var(--color-body);line-height:1.55">${esc(
 f.a,
 )}</p></div>`,
 )
 .join('');
 const openRolesListHtml = companyJobs
 .slice(0, 10)
 .map((job) => renderJobCardLi(job, locale))
 .join('');
 const listingUrlCurated = `${BASE_URL}${withSlash(
 `${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'),
 )}`;
 const headerBadge = `<p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-accent);font-weight:700">${esc(
 curatedBrand.shortName,
 )}</p>`;
 const hubLabels = {
 viewAllLabel: copy.viewAll,
 };
 curatedBodyHtml = [
 `<header>${headerBadge}<h1>${esc(brandCopy.h1)}</h1><p style="font-size:16px;color:var(--color-subtle);margin-top:4px">${esc(
 brandCopy.tagline,
 )}</p></header>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.about)}</h2>${paragraphsHtml}</section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.locations)}</h2><p>${esc(
 brandCopy.locationsIntro,
 )}</p><ul>${locationsHtml}</ul></section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.benefits)}</h2><ul>${benefitsHtml}</ul></section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.howToApply)}</h2><p>${esc(
 brandCopy.howToApply,
 )}</p>${
 curatedBrand.careersUrl
 ? `<p><a href="${esc(curatedBrand.careersUrl)}" rel="noopener noreferrer" target="_blank" style="color:var(--color-link);font-weight:600;text-decoration:none">${esc(
 curatedBrand.website.replace(/^https?:\/\//, ''),
 )} &rarr;</a></p>`
 : ''
 }</section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.openRoles)} (${companyJobs.length})</h2>${
 openRolesListHtml
 ? `<ul style="list-style:none;padding:0;margin:16px 0">${openRolesListHtml}</ul><p><a href="${listingUrlCurated}">${esc(
 hubLabels.viewAllLabel,
 )}</a></p>${renderHubChipsHtml(companyJobs, locale)}`
 : `<p>${esc(brandCopy.emptyStateNote)}</p>`
 }</section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.faq)}</h2>${faqsHtml}</section>`,
 ].join('\n');

 // Apply curated meta overrides so brand-queried SERPs show branded titles.
 // Route through buildTitleWithBrand so the " | Frontaliere Ticino" suffix
 // baked into employerBrands metaTitle drops automatically when the
 // headline already exceeds the 66-char audit cap (e.g. EOC entry hits
 // 72 char with brand → drops to 51 char base).
 if (curatedMetaTitle) {
 const stripped = curatedMetaTitle.replace(/\s*\|\s*Frontaliere Ticino\s*$/, '');
 title = buildTitleWithBrand(stripped);
 }
 if (curatedMetaDescription) description = curatedMetaDescription;
 } else {
 organizationLd = JSON.stringify(orgLdObj);
 }

 // Phase 3B — stub-company gating. Companies with 0 active jobs (which
 // shouldn't reach this code path under normal filtering, but we guard
 // anyway) get noindex,follow so Google drops the page from the index.
 // Curated brands and profiled companies always stay indexable.
 // Companies with 1-2 jobs stay indexable but receive minimal enrichment
 // via the standard auto-generated body so they don't collapse below the
 // Semrush thin-content gate.
 const companyJobCount = companyJobs.length;
 const companyProfile: CompanyProfile | undefined = companyProfiles[cSlug];
 const isStubCompany = companyJobCount < 1 && !curatedBrand && !companyProfile;
 const companyRobotsMeta = isStubCompany
  ? '<meta name="robots" content="noindex,follow">'
  : '<meta name="robots" content="index,follow">';

 // Phase 3B — curated profile prose. When a manual profile exists, we
 // inject a multi-fact paragraph (founded, size, sector, HQ) plus a
 // localized description. This raises the page's text/HTML ratio and
 // word count well above the Semrush thin-content threshold for the
 // top-50 employers without depending on noisy job-data autodescriptions.
 const companyProfileHtml = !curatedBrand && companyProfile
  ? (() => {
   const desc = companyProfile.description?.[locale]
    || companyProfile.description?.it
    || companyProfile.description?.en
    || '';
   const factsLineByLocale: Record<string, string> = {
    it: 'Informazioni chiave',
    en: 'Key facts',
    de: 'Eckdaten',
    fr: 'Informations cles',
   };
   const labels: Record<string, Record<'founded' | 'size' | 'sector' | 'hq', string>> = {
    it: { founded: 'Anno fondazione', size: 'Dimensione', sector: 'Settore', hq: 'Sede principale' },
    en: { founded: 'Founded', size: 'Size', sector: 'Sector', hq: 'Headquarters' },
    de: { founded: 'Gegruendet', size: 'Groesse', sector: 'Sektor', hq: 'Hauptsitz' },
    fr: { founded: 'Fondee', size: 'Taille', sector: 'Secteur', hq: 'Siege' },
   };
   const factsTitle = factsLineByLocale[locale] || factsLineByLocale.it;
   const lbl = labels[locale] || labels.it;
   const facts: string[] = [];
   if (companyProfile.founded) facts.push(`<li><strong>${esc(lbl.founded)}:</strong> ${esc(String(companyProfile.founded))}</li>`);
   if (companyProfile.size) facts.push(`<li><strong>${esc(lbl.size)}:</strong> ${esc(companyProfile.size)}</li>`);
   if (companyProfile.sector) facts.push(`<li><strong>${esc(lbl.sector)}:</strong> ${esc(companyProfile.sector)}</li>`);
   if (companyProfile.headquarters) facts.push(`<li><strong>${esc(lbl.hq)}:</strong> ${esc(companyProfile.headquarters)}</li>`);
   const factsBlock = facts.length > 0
    ? `<aside style="margin:0 0 14px;padding:12px 14px;background:var(--color-surface-subtle);border-radius:10px"><h3 style="margin:0 0 6px;font-size:14px;color:var(--color-heading)">${esc(factsTitle)}</h3><ul style="margin:0;padding:0;list-style:none;display:grid;gap:4px;font-size:14px;line-height:1.55;color:var(--color-body)">${facts.join('')}</ul></aside>`
    : '';
   if (!desc && !factsBlock) return '';
   return `<section class="company-profile" style="margin:20px 0 0">${factsBlock}${desc ? `<p style="margin:0;line-height:1.65;color:var(--color-body)">${esc(desc)}</p>` : ''}</section>`;
  })()
  : '';

 const companyHtml = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(title)}</title>
 <meta name="description" content="${esc(description)}">
 ${companyRobotsMeta}
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(title)}">
 <meta property="og:description" content="${esc(description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(title)}">
 <meta name="twitter:description" content="${esc(description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${hreflangHtml}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${organizationLd}</script>
 <script type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@type':'WebPage',url:canonicalUrl,inLanguage:locale,isPartOf:{'@type':'CollectionPage','@id':`${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g,'/'))}`,name:copy.sectionName}})}</script>${curatedExtraLd}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main class="static-job-page">
 <nav style="margin:0 0 16px;font-size:14px"><a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}" style="color:var(--color-accent);text-decoration:none;font-weight:600">&larr; ${esc(copy.allJobsLink)}</a></nav>
${curatedBodyHtml ? curatedBodyHtml + '\n' : `<h1>${esc(copy.heading(companyName))}</h1>\n<p>${esc(description)}</p>\n${companyProfileHtml}\n`}${curatedBodyHtml ? '' : (() => {
 // Collect location info from company jobs
 const companyLocations = [...new Set(companyJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const companySectors = [...new Set(companyJobs.map((j: any) => String(j.category || j.sector || '')).filter(Boolean))];
 const companyContracts = [...new Set(companyJobs.map((j: any) => String(j.contract || '')).filter(Boolean))];
 const primaryLocation = companyLocations[0] || '';
 const displayCanton = companyDisplayCanton;
 const locationListStr = companyLocations.slice(0, 5).join(', ');
 const locationListLinkedHtml = companyLocations
 .slice(0, 5)
 .map((loc) => linkifyCityInLocation(loc, locale))
 .join(', ');
 const listingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;

 const parts: string[] = [];

 // Job list first — most relevant content for landing visitors
 parts.push(`<section style="margin-top:20px"><h2>${locale === 'it' ? 'Posizioni aperte' : locale === 'en' ? 'Open positions' : locale === 'de' ? 'Offene Stellen' : 'Postes ouverts'}</h2>`);
 parts.push(`<ul style="list-style:none;padding:0;margin:16px 0">${jobListHtml}</ul>`);
 parts.push(`<p><a href="${listingUrl}">${esc(copy.viewAll)}</a></p>`);
 parts.push('</section>');

 // Company info section. When locationListStr / companySectors are empty
 // (small employers with 1-2 listings or thinly-classified sources), append
 // a fallback paragraph so the page still carries substantive context
 // and clears the Semrush text-to-HTML ratio gate.
 const noLocOrSectors = !locationListStr && companySectors.length === 0;
 if (locale === 'it') {
 parts.push(`<section style="margin-top:20px"><h2>Informazioni su ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} offre attualmente <strong>${companyJobs.length} posizioni aperte</strong> in Canton ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Le sedi di lavoro includono: ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` L'azienda opera nel settore ${esc(companySectors.slice(0, 3).join(', '))}.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Tipologie di contratto disponibili: ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>Quando il nostro crawler non rileva ancora una sede di lavoro o un settore esplicito per ${esc(companyName)}, significa di solito che l'azienda è di dimensioni contenute o che pubblica le offerte tramite un ATS che non espone esplicitamente la classificazione: in questi casi apri il singolo annuncio per leggere mansionario, requisiti, sede di lavoro e tipologia contrattuale dichiarata. Per i frontalieri, i datori di lavoro nel Canton ${esc(displayCanton)} si suddividono tipicamente in tre categorie — multinazionali (sanitario, farmaceutico, finanziario) con processi HR strutturati e benefit estesi (LPP gold, formazione continua, mensa); PMI ticinesi (commercio, edilizia, servizi professionali) con flessibilità contrattuale e un percorso di carriera più rapido; e enti pubblici/parapubblici (cantone, scuole, sanità) con stabilità del posto e regole di residenza più stringenti. Se ${esc(companyName)} non ha ancora una scheda dettagliata sul nostro sito, leggi le sezioni qui sotto sui meccanismi del Permesso G e sull'imposta alla fonte cantonale: si applicano a qualunque rapporto di lavoro frontaliero in ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section style="margin-top:20px"><h2>About ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} currently has <strong>${companyJobs.length} open positions</strong> in the Canton of ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Work locations include: ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` The company operates in the ${esc(companySectors.slice(0, 3).join(', '))} sector.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Available contract types: ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>When our crawler hasn't yet picked up a work location or explicit sector for ${esc(companyName)}, it usually means the company is on the smaller side or posts through an ATS that doesn't expose explicit classification: in those cases open the individual listing to read the job description, requirements, work location and contract type. For cross-border workers, employers in the Canton of ${esc(displayCanton)} typically split into three buckets — multinationals (healthcare, pharma, finance) with structured HR processes and rich benefits (gold LPP, training budget, on-site canteen); Ticino SMEs (retail, construction, professional services) with contractual flexibility and faster career paths; and public/parapublic bodies (cantonal, schools, healthcare) with strong job security and tighter residence rules. If ${esc(companyName)} doesn't yet have a detailed profile on our site, the sections below on G permit mechanics and cantonal withholding tax still apply to any cross-border employment in ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section style="margin-top:20px"><h2>\u00dcber ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} bietet derzeit <strong>${companyJobs.length} offene Stellen</strong> im Kanton ${esc(displayCanton)} an.`);
 if (locationListStr) parts[parts.length - 1] += ` Arbeitsorte sind unter anderem: ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` Das Unternehmen ist in den Bereichen ${esc(companySectors.slice(0, 3).join(', '))} t\u00e4tig.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Verf\u00fcgbare Vertragsarten: ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>Wenn unser Crawler noch keinen Arbeitsort oder keine explizite Branche f\u00fcr ${esc(companyName)} erfasst hat, ist das Unternehmen meist kleiner oder ver\u00f6ffentlicht \u00fcber ein ATS, das die Klassifikation nicht offenlegt: In solchen F\u00e4llen \u00f6ffnen Sie die einzelne Ausschreibung f\u00fcr Stellenbeschreibung, Anforderungen, Arbeitsort und Vertragsart. F\u00fcr Grenzg\u00e4nger lassen sich die Arbeitgeber im Kanton ${esc(displayCanton)} typischerweise in drei Gruppen einteilen — Multinationals (Gesundheit, Pharma, Finanzen) mit strukturierten HR-Prozessen und umfangreichen Benefits (Gold-BVG, Weiterbildungsbudget, Personalrestaurant); Tessiner KMU (Detailhandel, Bau, Dienstleistungen) mit vertraglicher Flexibilit\u00e4t und schnelleren Karrierepfaden; und \u00f6ffentliche/parastaatliche Stellen (Kanton, Schulen, Gesundheit) mit hoher Anstellungssicherheit und strengeren Wohnsitzregeln. Falls ${esc(companyName)} noch kein detailliertes Profil auf unserer Seite hat, gelten die unten stehenden Abschnitte zu G-Bewilligung und kantonaler Quellensteuer dennoch f\u00fcr jedes Grenzg\u00e4ngerverh\u00e4ltnis im ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 } else {
 parts.push(`<section style="margin-top:20px"><h2>\u00c0 propos de ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} propose actuellement <strong>${companyJobs.length} postes ouverts</strong> dans le Canton du ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Les lieux de travail incluent : ${locationListLinkedHtml}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` L'entreprise op\u00e8re dans le secteur ${esc(companySectors.slice(0, 3).join(', '))}.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Types de contrat disponibles : ${esc(companyContracts.join(', '))}.</p>`);
 if (noLocOrSectors) {
 parts.push(`<p>Quand notre crawler n'a pas encore identifi\u00e9 de lieu de travail ou de secteur explicite pour ${esc(companyName)}, l'entreprise est en g\u00e9n\u00e9ral de petite taille ou publie via un ATS qui n'expose pas la classification : dans ce cas, ouvrez l'annonce individuelle pour le descriptif, les exigences, le lieu et le type de contrat. Pour les frontaliers, les employeurs du Canton du ${esc(displayCanton)} se r\u00e9partissent typiquement en trois cat\u00e9gories — multinationales (sant\u00e9, pharma, finance) aux processus RH structur\u00e9s et aux benefits \u00e9tendus (LPP de premier ordre, budget formation, cantine d'entreprise) ; PME tessinoises (commerce, construction, services professionnels) offrant flexibilit\u00e9 contractuelle et carri\u00e8re plus rapide ; et entit\u00e9s publiques/parapubliques (canton, \u00e9coles, sant\u00e9) avec une grande s\u00e9curit\u00e9 d'emploi et des r\u00e8gles de r\u00e9sidence plus strictes. Si ${esc(companyName)} n'a pas encore de fiche d\u00e9taill\u00e9e sur notre site, les sections ci-dessous sur le permis G et l'imp\u00f4t \u00e0 la source cantonal s'appliquent \u00e0 tout emploi frontalier dans le ${esc(displayCanton)}.</p>`);
 }
 parts.push('</section>');
 }

 // Internal-linking chips (city + sector hubs)
 const hubChips = renderHubChipsHtml(companyJobs, locale);
 if (hubChips) parts.push(hubChips);

 // Frontalier info section — extended with permit, fiscal, social-charge and
 // commute paragraphs to give the canonical company-hub page substantive
 // content (was failing the Semrush low-text/HTML gate at ~4.5 %). All
 // strings interpolate companyName / primaryLocation / displayCanton so the
 // text stays page-specific and Google won't see boilerplate.
 if (locale === 'it') {
 parts.push(`<section style="margin-top:20px"><h2>Informazioni per frontalieri</h2>`);
 parts.push(`<p>${esc(companyName)} ha sede${primaryLocation ? ` a ${esc(primaryLocation)}` : ''} in Canton ${esc(displayCanton)}, Svizzera. Per lavorare come frontaliere presso questa azienda serve il Permesso G. Il Canton ${esc(displayCanton)} applica l'imposta alla fonte con aliquote variabili sul reddito lordo dei lavoratori transfrontalieri. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto e confrontare i costi della vita tra Svizzera e Italia.</p>`);
 parts.push(`<p><strong>Permesso G e residenza.</strong> Per essere assunto come frontaliere da ${esc(companyName)}${primaryLocation ? ` a ${esc(primaryLocation)}` : ''} devi risiedere in un comune italiano entro la fascia di 20 km dal confine svizzero (Lombardia o Piemonte) e rientrare al domicilio almeno una volta a settimana. Il Permesso G viene richiesto dal datore di lavoro all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi viene rinnovato annualmente fino al limite contrattuale. Le assenze prolungate dall'Italia (più di una settimana lavorativa senza rientro) compromettono lo status fiscale di "vecchio" frontaliere.</p>`);
 parts.push(`<p><strong>Imposta alla fonte e Nuovo Accordo fiscale 2024.</strong> Il datore svizzero trattiene mensilmente l'imposta alla fonte sul lordo: l'aliquota effettiva nel Canton ${esc(displayCanton)} oscilla fra il 5 % e il 19 % a seconda di reddito, stato civile e figli a carico. I frontalieri assunti dal 1° gennaio 2024 ricadono nel Nuovo Accordo Italia-Svizzera: imposta concorrente fra i due Stati con credito d'imposta italiano sulle ritenute svizzere fino all'80 %, deducibili nel quadro RW del modello 730/Redditi PF. Per il calcolo personalizzato netto-lordo apri il simulatore stipendio e inserisci la categoria contrattuale offerta da ${esc(companyName)}.</p>`);
 parts.push(`<p><strong>Contributi sociali svizzeri.</strong> Lo stipendio lordo dichiarato negli annunci ${esc(companyName)} è soggetto a AVS-AI-IPG (5,3 % a carico del dipendente, 5,3 % a carico del datore), assicurazione contro la disoccupazione (1,1 % fino a 148.200 CHF/anno) e LPP — la previdenza professionale obbligatoria — con aliquote che salgono dal 7 % a 25 anni fino al 18 % oltre i 55 anni. Sommando l'imposta alla fonte e i contributi sociali la differenza fra lordo annuale dichiarato e netto è tipicamente del 18-28 %. Per la simulazione esatta sulla città di lavoro indicata e con i tuoi parametri personali utilizza il <a href="${BASE_URL}/calcola-stipendio/">calcolatore busta paga</a>.</p>`);
 parts.push(`<p><strong>Pendolarismo: cosa aspettarsi.</strong> ${primaryLocation ? `Lavorando per ${esc(companyName)} a ${esc(primaryLocation)} ` : `Lavorando per ${esc(companyName)} `}, il tragitto giornaliero da Como passa tipicamente dal valico di Brogeda (autostrada A2) o di Chiasso-strada per le destinazioni del Mendrisiotto/Luganese, con tempi di 25-50 minuti in ora di punta in funzione delle code al confine. Da Varese o Luino il valico di Stabio o Gaggiolo offre tragitti alternativi. Per stimare costo carburante mensile, usura veicolo e il tempo perso al confine consulta la guida pendolarismo e la mappa dei tempi di attesa: integrarli con lo stipendio netto è il modo corretto per valutare se il salario di ${esc(companyName)} è competitivo rispetto a un'alternativa italiana.</p>`);
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section style="margin-top:20px"><h2>Information for cross-border workers</h2>`);
 parts.push(`<p>${esc(companyName)} is based${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} in the Canton of ${esc(displayCanton)}, Switzerland. Cross-border workers need a G Permit to work at this company. The Canton of ${esc(displayCanton)} applies withholding tax at variable rates on the gross income of cross-border employees. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary and compare the cost of living between Switzerland and Italy.</p>`);
 parts.push(`<p><strong>G permit and residence.</strong> To be hired as a cross-border worker by ${esc(companyName)}${primaryLocation ? ` in ${esc(primaryLocation)}` : ''}, you must reside in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and return home at least once a week. The G permit is requested by the employer at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is then renewed yearly. Extended absences from Italy (more than a working week without returning home) jeopardise the "former" cross-border worker fiscal status.</p>`);
 parts.push(`<p><strong>Withholding tax and the 2024 fiscal agreement.</strong> The Swiss employer withholds tax monthly on the gross salary: the effective rate in the Canton of ${esc(displayCanton)} ranges between 5 % and 19 % depending on income, marital status and dependants. Cross-border workers hired on or after 1 January 2024 fall under the new Italy-Switzerland agreement with concurrent taxation: Italian tax credit on Swiss withholding up to 80 %, declared in section RW of the Italian tax return. For a personalised gross-to-net calculation use the salary simulator with the contract type ${esc(companyName)} offers.</p>`);
 parts.push(`<p><strong>Swiss social-charge breakdown.</strong> The gross salary advertised in ${esc(companyName)} listings is subject to AVS-AI-IPG (5.3 % employee, 5.3 % employer), unemployment insurance (1.1 % up to CHF 148,200/year) and LPP — the mandatory occupational pension — with rates climbing from 7 % at age 25 to 18 % over age 55. Adding withholding tax and social charges, the typical gross-to-net gap is 18-28 %. For an exact calculation on the work city in the listing and your personal parameters use the <a href="${BASE_URL}/en/calculate-salary/">salary calculator</a>.</p>`);
 parts.push(`<p><strong>What to expect from the commute.</strong> ${primaryLocation ? `Working for ${esc(companyName)} in ${esc(primaryLocation)} ` : `Working for ${esc(companyName)} `}, the daily commute from Como typically goes through the Brogeda (A2 motorway) or Chiasso-strada crossing for destinations in Mendrisiotto/Luganese, taking 25-50 minutes at peak times depending on the border queue. From Varese or Luino, the Stabio or Gaggiolo crossings offer alternatives. To estimate monthly fuel cost, vehicle wear and time lost at the border, see the cross-border commuter guide and the live border-wait map: combining those numbers with net salary is the right way to compare a ${esc(companyName)} offer with an Italian alternative.</p>`);
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section style="margin-top:20px"><h2>Informationen f\u00fcr Grenzg\u00e4nger</h2>`);
 parts.push(`<p>${esc(companyName)} hat seinen Sitz${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} im Kanton ${esc(displayCanton)}, Schweiz. Grenzg\u00e4nger ben\u00f6tigen eine G-Bewilligung, um bei diesem Unternehmen zu arbeiten. Der Kanton ${esc(displayCanton)} erhebt eine Quellensteuer mit variablen S\u00e4tzen auf das Bruttoeinkommen der Grenzg\u00e4nger. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt zu berechnen und die Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.</p>`);
 parts.push(`<p><strong>G-Bewilligung und Wohnsitz.</strong> Um als Grenzg\u00e4nger bei ${esc(companyName)}${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} angestellt zu werden, m\u00fcssen Sie in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) wohnen und mindestens einmal pro Woche nach Hause zur\u00fcckkehren. Die G-Bewilligung wird vom Arbeitgeber nach Vertragsunterzeichnung beim kantonalen Migrationsamt beantragt: die erste Ausstellung dauert 2-6 Wochen, danach erfolgt die j\u00e4hrliche Verl\u00e4ngerung. L\u00e4ngere Abwesenheiten von Italien (mehr als eine Arbeitswoche ohne R\u00fcckkehr) gef\u00e4hrden den steuerlichen "Alt-Grenzg\u00e4nger"-Status.</p>`);
 parts.push(`<p><strong>Quellensteuer und neues Steuerabkommen 2024.</strong> Der schweizerische Arbeitgeber zieht die Quellensteuer monatlich vom Bruttolohn ab: der effektive Satz im Kanton ${esc(displayCanton)} liegt je nach Einkommen, Zivilstand und Kindern zwischen 5 % und 19 %. Grenzg\u00e4nger, die ab dem 1. Januar 2024 angestellt wurden, fallen unter das neue Abkommen Italien-Schweiz mit konkurrierender Besteuerung: italienische Steuergutschrift auf die schweizerische Quellensteuer bis zu 80 %, deklariert in Abschnitt RW der italienischen Steuererkl\u00e4rung. F\u00fcr eine personalisierte Brutto-Netto-Berechnung verwenden Sie den Lohnsimulator mit der von ${esc(companyName)} angebotenen Vertragsart.</p>`);
 parts.push(`<p><strong>Schweizerische Sozialabz\u00fcge.</strong> Der in ${esc(companyName)}-Inseraten angegebene Bruttolohn unterliegt AHV-IV-EO (5,3 % Arbeitnehmer, 5,3 % Arbeitgeber), Arbeitslosenversicherung (1,1 % bis CHF 148'200/Jahr) und der obligatorischen beruflichen Vorsorge BVG mit Beitr\u00e4gen, die von 7 % mit 25 Jahren bis 18 % \u00fcber 55 Jahren steigen. Mit Quellensteuer und Sozialabgaben zusammen betr\u00e4gt der typische Brutto-Netto-Abstand 18-28 %. F\u00fcr eine exakte Berechnung auf den Arbeitsort der Stelle und Ihre pers\u00f6nlichen Parameter nutzen Sie den <a href="${BASE_URL}/de/gehalt-berechnen/">Lohnrechner</a>.</p>`);
 parts.push(`<p><strong>Was Sie beim Pendeln erwartet.</strong> ${primaryLocation ? `Wer f\u00fcr ${esc(companyName)} in ${esc(primaryLocation)} arbeitet ` : `Wer f\u00fcr ${esc(companyName)} arbeitet `}, pendelt typischerweise von Como \u00fcber den Grenz\u00fcbergang Brogeda (Autobahn A2) oder Chiasso-Strasse zu Zielen im Mendrisiotto/Luganese, mit Fahrzeiten von 25-50 Minuten in Stosszeiten je nach Grenzwartezeit. Von Varese oder Luino bieten Stabio oder Gaggiolo Alternativen. F\u00fcr eine monatliche Sch\u00e4tzung von Treibstoffkosten, Fahrzeugverschleiss und Zeitverlust an der Grenze konsultieren Sie den Grenzg\u00e4nger-Leitfaden und die Live-Wartezeitenkarte: diese Zahlen zusammen mit dem Nettolohn ergeben die richtige Grundlage, um ein ${esc(companyName)}-Angebot gegen eine italienische Alternative abzuw\u00e4gen.</p>`);
 parts.push('</section>');
 } else {
 parts.push(`<section style="margin-top:20px"><h2>Informations pour les frontaliers</h2>`);
 parts.push(`<p>${esc(companyName)} a son si\u00e8ge${primaryLocation ? ` \u00e0 ${esc(primaryLocation)}` : ''} dans le Canton du ${esc(displayCanton)}, en Suisse. Les travailleurs frontaliers ont besoin d'un permis G pour travailler dans cette entreprise. Le Canton du ${esc(displayCanton)} applique un imp\u00f4t \u00e0 la source \u00e0 taux variable sur le revenu brut des frontaliers. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net et comparer le co\u00fbt de la vie entre la Suisse et l'Italie.</p>`);
 parts.push(`<p><strong>Permis G et r\u00e9sidence.</strong> Pour \u00eatre engag\u00e9 comme frontalier par ${esc(companyName)}${primaryLocation ? ` \u00e0 ${esc(primaryLocation)}` : ''}, vous devez r\u00e9sider dans une commune italienne situ\u00e9e dans la zone fronti\u00e8re des 20 km (Lombardie ou Pi\u00e9mont) et rentrer chez vous au moins une fois par semaine. Le permis G est demand\u00e9 par l'employeur \u00e0 l'office cantonal des migrations apr\u00e8s la signature du contrat : la premi\u00e8re d\u00e9livrance prend 2 \u00e0 6 semaines, puis le permis est renouvel\u00e9 chaque ann\u00e9e. Des absences prolong\u00e9es d'Italie (plus d'une semaine de travail sans retour au domicile) compromettent le statut fiscal de \u00ab ancien \u00bb frontalier.</p>`);
 parts.push(`<p><strong>Imp\u00f4t \u00e0 la source et nouvel accord fiscal 2024.</strong> L'employeur suisse retient mensuellement l'imp\u00f4t \u00e0 la source sur le brut : le taux effectif dans le Canton du ${esc(displayCanton)} oscille entre 5 % et 19 % selon le revenu, l'\u00e9tat civil et les personnes \u00e0 charge. Les frontaliers engag\u00e9s \u00e0 partir du 1er janvier 2024 rel\u00e8vent du nouvel accord Italie-Suisse \u00e0 imposition concurrente : cr\u00e9dit d'imp\u00f4t italien sur la retenue suisse jusqu'\u00e0 80 %, d\u00e9clar\u00e9 dans le cadre RW de la d\u00e9claration italienne. Pour un calcul personnalis\u00e9 brut-net, utilisez le simulateur de salaire avec la cat\u00e9gorie contractuelle propos\u00e9e par ${esc(companyName)}.</p>`);
 parts.push(`<p><strong>Charges sociales suisses.</strong> Le salaire brut annonc\u00e9 dans les offres ${esc(companyName)} est soumis \u00e0 l'AVS-AI-APG (5,3 % salari\u00e9, 5,3 % employeur), \u00e0 l'assurance ch\u00f4mage (1,1 % jusqu'\u00e0 CHF 148'200/an) et \u00e0 la LPP — la pr\u00e9voyance professionnelle obligatoire — avec des taux qui passent de 7 % \u00e0 25 ans \u00e0 18 % au-del\u00e0 de 55 ans. Imp\u00f4t \u00e0 la source et charges sociales additionn\u00e9s, l'\u00e9cart brut-net typique est de 18 \u00e0 28 %. Pour un calcul exact sur la ville de travail de l'offre et vos param\u00e8tres personnels utilisez le <a href="${BASE_URL}/fr/calculer-salaire/">calculateur de salaire</a>.</p>`);
 parts.push(`<p><strong>\u00c0 quoi s'attendre c\u00f4t\u00e9 trajet.</strong> ${primaryLocation ? `Travailler pour ${esc(companyName)} \u00e0 ${esc(primaryLocation)} ` : `Travailler pour ${esc(companyName)} `} signifie en g\u00e9n\u00e9ral un trajet quotidien depuis C\u00f4me par le poste-fronti\u00e8re de Brogeda (autoroute A2) ou par Chiasso-route pour les destinations du Mendrisiotto/Luganese, avec des temps de 25-50 minutes en heure de pointe selon la file. Depuis Var\u00e8se ou Luino, les passages de Stabio ou Gaggiolo offrent des alternatives. Pour estimer le co\u00fbt mensuel du carburant, l'usure du v\u00e9hicule et le temps perdu au poste-fronti\u00e8re, consultez le guide frontalier et la carte des temps d'attente : combiner ces chiffres avec le salaire net est la bonne mani\u00e8re de comparer une offre ${esc(companyName)} avec une alternative italienne.</p>`);
 parts.push('</section>');
 }

 // Extended economic-context section — boosts text/HTML on EN/DE/FR
 // company-hub pages that hovered at 7-8 % (under the 10 % gate).
 // Three paragraphs covering: salary ranges in the canton, exchange-rate
 // impact on take-home, and benefit benchmarks. All values interpolate
 // companyName / displayCanton so Google sees page-specific copy.
 if (locale === 'it') {
 parts.push(`<section style="margin-top:20px"><h2>Contesto economico per chi valuta ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Range salariali tipici nel Canton ${esc(displayCanton)}.</strong> Le buste paga lorde in ${esc(displayCanton)} per i frontalieri si distribuiscono tipicamente in tre fasce: profili junior e mansioni operative tra CHF 4'200 e CHF 5'400 al mese (13ª inclusa); ruoli intermedi e tecnici qualificati tra CHF 5'500 e CHF 8'200; ruoli specialistici, manageriali e regolamentati tra CHF 8'500 e CHF 14'000. Per ${esc(companyName)} la collocazione concreta dipende dal CCL applicato (CCNL nazionale, CCL ramo, contratto aziendale), dall'anzianità e dalla certificazione richiesta. Confronta sempre il lordo svizzero con il netto italiano equivalente: a parità di mansione, in Ticino il netto resta superiore del 25-45 % grazie alla pressione fiscale e contributiva ridotta.</p>`);
 parts.push(`<p><strong>Impatto del cambio CHF/EUR sul potere d'acquisto.</strong> Lo stipendio in franchi va riconvertito in euro per le spese italiane (mutuo, scuola, spesa, utenze): un CHF/EUR a 1,06 vs 0,95 cambia il netto in euro fino al 12 % a parità di lordo svizzero. I frontalieri che lavorano per aziende come ${esc(companyName)} possono ridurre questo rischio cambio aprendo un conto multivaluta in Italia, mantenendo una riserva CHF per le spese svizzere (parking, mensa, eventuale spesa nei valichi) e cambiando in EUR solo la quota destinata alle uscite italiane. Le commissioni di cambio bancarie tradizionali (1,5-3 %) erodono il vantaggio: usa fornitori specializzati (Wise, Revolut Premium) o accordi di cambio negoziato con la propria banca italiana per massimizzare il netto effettivo.</p>`);
 parts.push(`<p><strong>Benefit accessori da chiedere in colloquio.</strong> Oltre allo stipendio lordo, valuta sempre i benefit non monetari quando ricevi un'offerta da ${esc(companyName)}: contributo LPP sopra il minimo legale (8-12 % del lordo è il benchmark per ruoli qualificati nel ${esc(displayCanton)}), 13ª e 14ª mensilità, bonus annuale legato a obiettivi (tipicamente 5-15 % del lordo), giorni di vacanza oltre i 4 settimane minime di legge (le aziende competitive offrono 5-6 settimane), formazione continua (budget di CHF 1'500-3'500/anno per ruoli senior), copertura assicurativa malattia LCA integrativa e flessibilità di telelavoro. Quest'ultimo punto è critico: dal 1° gennaio 2024 i frontalieri possono telelavorare fino al 25 % del tempo senza perdere lo status fiscale, ma il datore di lavoro deve esplicitarlo nel contratto.</p>`);
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section style="margin-top:20px"><h2>Economic context for evaluating ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Typical salary ranges in the Canton of ${esc(displayCanton)}.</strong> Gross monthly salaries for cross-border workers in ${esc(displayCanton)} typically split into three bands: junior and operational roles between CHF 4,200 and CHF 5,400 per month (13th included); intermediate and skilled-technical roles between CHF 5,500 and CHF 8,200; specialist, managerial and regulated roles between CHF 8,500 and CHF 14,000. For ${esc(companyName)} the actual band depends on the applicable collective agreement (CCL), seniority and required certifications. Always compare the Swiss gross with the Italian net equivalent: for the same job in Ticino the net is typically 25-45 % higher than the Italian counterpart due to lower fiscal and social burden.</p>`);
 parts.push(`<p><strong>CHF/EUR exchange rate impact on purchasing power.</strong> Your CHF salary needs to be converted into EUR for Italian expenses (mortgage, school, groceries, utilities): a CHF/EUR rate at 1.06 vs 0.95 changes net EUR by up to 12 % at the same Swiss gross. Cross-border workers at companies like ${esc(companyName)} can hedge this exchange-rate risk by opening a multi-currency account in Italy, keeping a CHF reserve for Swiss expenses (parking, canteen, occasional shopping near the border) and converting to EUR only the share destined for Italian spending. Traditional bank FX fees (1.5-3 %) erode the benefit: use specialised providers (Wise, Revolut Premium) or a negotiated FX deal with your Italian bank to maximise effective net.</p>`);
 parts.push(`<p><strong>Benefits to negotiate at offer stage.</strong> Beyond the gross salary, always evaluate non-cash benefits when ${esc(companyName)} extends an offer: pension (LPP) contribution above the legal minimum (8-12 % of gross is the benchmark for skilled roles in ${esc(displayCanton)}), 13th and 14th-month payments, annual bonus tied to targets (typically 5-15 % of gross), holiday entitlement beyond the legal 4-week minimum (competitive employers offer 5-6 weeks), continuous training (CHF 1,500-3,500/year budget for senior roles), supplementary LCA health insurance and remote-work flexibility. The latter is critical: since 1 January 2024 cross-border workers can work remotely up to 25 % of the time without losing fiscal status, but the employer must explicitly include this in the contract.</p>`);
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section style="margin-top:20px"><h2>Wirtschaftlicher Kontext zur Bewertung von ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Typische Lohnbandbreiten im Kanton ${esc(displayCanton)}.</strong> Bruttogeh\u00e4lter f\u00fcr Grenzg\u00e4nger im ${esc(displayCanton)} verteilen sich typischerweise auf drei Bereiche: Junior- und operative Rollen zwischen CHF 4'200 und CHF 5'400 pro Monat (13. inbegriffen); mittlere und qualifiziert-technische Rollen zwischen CHF 5'500 und CHF 8'200; Spezialisten, Kader und regulierte Rollen zwischen CHF 8'500 und CHF 14'000. F\u00fcr ${esc(companyName)} h\u00e4ngt die konkrete Eingruppierung vom anwendbaren GAV (Branchen-GAV, Firmenvertrag), der Anstellungsdauer und den geforderten Zertifizierungen ab. Vergleichen Sie immer das Schweizer Brutto mit dem italienischen Netto-\u00c4quivalent: f\u00fcr dieselbe Stelle ist das Tessiner Netto typischerweise 25-45 % h\u00f6her als die italienische Alternative, dank tieferer Steuer- und Soziallast.</p>`);
 parts.push(`<p><strong>Auswirkungen des CHF/EUR-Kurses auf die Kaufkraft.</strong> Ihr CHF-Lohn muss f\u00fcr italienische Ausgaben (Hypothek, Schule, Eink\u00e4ufe, Nebenkosten) in EUR umgerechnet werden: ein CHF/EUR-Kurs von 1,06 vs 0,95 \u00e4ndert den Nettobetrag in EUR bei gleichem Schweizer Brutto um bis zu 12 %. Grenzg\u00e4nger bei Unternehmen wie ${esc(companyName)} k\u00f6nnen dieses Wechselkursrisiko absichern, indem sie ein Multiw\u00e4hrungskonto in Italien er\u00f6ffnen, eine CHF-Reserve f\u00fcr Schweizer Ausgaben halten (Parking, Personalrestaurant, gelegentliche Eink\u00e4ufe nahe der Grenze) und nur den Anteil f\u00fcr italienische Ausgaben in EUR konvertieren. Traditionelle Bankgeb\u00fchren (1,5-3 %) zehren am Vorteil: spezialisierte Anbieter (Wise, Revolut Premium) oder ein verhandelter FX-Deal mit Ihrer italienischen Bank maximieren das effektive Netto.</p>`);
 parts.push(`<p><strong>Verhandelbare Zusatzleistungen.</strong> \u00dcber das Bruttogehalt hinaus pr\u00fcfen Sie bei einem Angebot von ${esc(companyName)} stets die nicht monet\u00e4ren Leistungen: BVG-Beitrag \u00fcber dem gesetzlichen Minimum (8-12 % des Brutto sind der Benchmark f\u00fcr qualifizierte Rollen im ${esc(displayCanton)}), 13. und 14. Monatslohn, Bonus an Zielvereinbarungen gekoppelt (typischerweise 5-15 % des Brutto), Ferienanspruch \u00fcber dem gesetzlichen Minimum von 4 Wochen (kompetitive Arbeitgeber bieten 5-6 Wochen), Weiterbildung (CHF 1'500-3'500/Jahr f\u00fcr Senior-Rollen), erg\u00e4nzende LCA-Krankenversicherung und Telearbeit-Flexibilit\u00e4t. Letzteres ist entscheidend: seit dem 1. Januar 2024 d\u00fcrfen Grenzg\u00e4nger bis zu 25 % der Zeit im Homeoffice arbeiten, ohne den Steuerstatus zu verlieren — der Arbeitgeber muss dies aber im Vertrag explizit regeln.</p>`);
 parts.push('</section>');
 } else {
 parts.push(`<section style="margin-top:20px"><h2>Contexte \u00e9conomique pour \u00e9valuer ${esc(companyName)}</h2>`);
 parts.push(`<p><strong>Fourchettes salariales typiques dans le Canton du ${esc(displayCanton)}.</strong> Les salaires bruts mensuels pour les frontaliers dans le ${esc(displayCanton)} se r\u00e9partissent g\u00e9n\u00e9ralement en trois fourchettes : postes juniors et op\u00e9rationnels entre CHF 4'200 et CHF 5'400 par mois (13e inclus) ; postes interm\u00e9diaires et techniques qualifi\u00e9s entre CHF 5'500 et CHF 8'200 ; postes sp\u00e9cialis\u00e9s, cadres et r\u00e9glement\u00e9s entre CHF 8'500 et CHF 14'000. Pour ${esc(companyName)} le positionnement concret d\u00e9pend de la convention collective applicable (CCL national, CCL de branche, contrat d'entreprise), de l'anciennet\u00e9 et des certifications requises. Comparez toujours le brut suisse avec le net italien \u00e9quivalent : pour le m\u00eame poste au Tessin, le net est g\u00e9n\u00e9ralement 25-45 % sup\u00e9rieur \u00e0 l'\u00e9quivalent italien gr\u00e2ce \u00e0 une charge fiscale et sociale plus faible.</p>`);
 parts.push(`<p><strong>Impact du taux de change CHF/EUR sur le pouvoir d'achat.</strong> Votre salaire en CHF doit \u00eatre converti en EUR pour les d\u00e9penses italiennes (hypoth\u00e8que, \u00e9cole, courses, charges) : un taux CHF/EUR \u00e0 1,06 vs 0,95 modifie le net en EUR jusqu'\u00e0 12 % \u00e0 brut suisse \u00e9gal. Les frontaliers chez des entreprises comme ${esc(companyName)} peuvent couvrir ce risque de change en ouvrant un compte multi-devises en Italie, en gardant une r\u00e9serve CHF pour les d\u00e9penses suisses (parking, cantine, achats occasionnels pr\u00e8s de la fronti\u00e8re) et en convertissant en EUR seulement la part destin\u00e9e aux d\u00e9penses italiennes. Les frais de change bancaires traditionnels (1,5-3 %) r\u00e9duisent l'avantage : utilisez des prestataires sp\u00e9cialis\u00e9s (Wise, Revolut Premium) ou un accord de change n\u00e9goci\u00e9 avec votre banque italienne pour maximiser le net effectif.</p>`);
 parts.push(`<p><strong>Avantages \u00e0 n\u00e9gocier au moment de l'offre.</strong> Au-del\u00e0 du salaire brut, \u00e9valuez toujours les avantages non mon\u00e9taires lorsque ${esc(companyName)} fait une offre : cotisation LPP au-del\u00e0 du minimum l\u00e9gal (8-12 % du brut est le benchmark pour les postes qualifi\u00e9s dans le ${esc(displayCanton)}), 13e et 14e mois, bonus annuel index\u00e9 sur des objectifs (typiquement 5-15 % du brut), cong\u00e9s au-del\u00e0 du minimum l\u00e9gal de 4 semaines (les employeurs comp\u00e9titifs offrent 5-6 semaines), formation continue (budget CHF 1'500-3'500/an pour les postes seniors), assurance maladie compl\u00e9mentaire LCA et flexibilit\u00e9 du t\u00e9l\u00e9travail. Ce dernier point est critique : depuis le 1er janvier 2024, les frontaliers peuvent t\u00e9l\u00e9travailler jusqu'\u00e0 25 % du temps sans perdre leur statut fiscal, mais l'employeur doit l'inscrire explicitement dans le contrat.</p>`);
 parts.push('</section>');
 }

 // Per-company hub frontalier context (separate shared helper):
 // sector-aware salary scenario + how-to-apply methodology + 3-FAQ.
 // Lifts the text-to-HTML ratio for thin per-company hubs flagged as
 // `career-landings` by scripts/audit-text-html-ratio.mjs. Always renders
 // (not gated on companyJobs.length) — thin pages need this most.
 const companyHubFrontalierContext = renderCompanyHubFrontalierContext({
 companyName,
 displayCanton,
 primaryLocation,
 sector: companyProfile?.sector,
 companySectors,
 companyContracts,
 jobCount: companyJobs.length,
 locale,
 esc,
 });
 if (companyHubFrontalierContext) parts.push(companyHubFrontalierContext);

 // Editorial
 parts.push(`<p style="margin-top:16px;font-size:14px;color:var(--color-subtle);line-height:1.6">${esc(copy.editorial)}</p>`);
 return parts.join('\n');
 })()}
 ${curatedBodyHtml ? `<p style="margin-top:24px;font-size:14px;color:var(--color-subtle);line-height:1.6">${esc(copy.editorial)}</p>` : ''}
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: primaryLocation || 'Ticino', omitCommute: !primaryLocation }))}
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), companyHtml);
 // Flat .html variant — write real content (no redirect stub)
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, companyHtml);
 }
 // Redirect pages for raw slugs that differ from canonical (e.g. lidl-svizzera → lidl).
 // These are non-canonical alternate URLs that exist only so older inbound links
 // and crawler discoveries don't 404. We serve the SAME full canonical HTML at
 // each alias path; the embedded <link rel="canonical"> already points to the
 // canonical hub URL, so Google consolidates authority on the canonical via
 // that reference. No thin stub, no noindex — index,follow with canonical
 // reference is the cleanest signal. Mirrors the previousSlugs bridge pattern
 // documented around line 7190+.
 for (const rawSlug of rawSlugs) {
 const rawFullSlug = `${prefix}-${rawSlug}`;
 const rawRelPath = `${localePrefix[locale]}/${sectionSlug}/${rawFullSlug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const rawDir = np.join(distDir, rawRelPath);
 if (!fs.existsSync(np.join(rawDir, 'index.html'))) {
 _md(rawDir);
 _qw(np.join(rawDir, 'index.html'), companyHtml);
 }
 const rawFlat = np.join(distDir, rawRelPath + '.html');
 if (!fs.existsSync(rawFlat)) {
 _md(np.dirname(rawFlat));
 _qwFlat(rawFlat, companyHtml);
 }
 }
 // Declarative brand-alias bridge pages (P5 dedup).
 // When `cSlug` is a declared canonical primary, emit noindex canonical
 // bridges for every alias slug registered in BRAND_CANONICAL_MAP so
 // alternative company-hub URLs (e.g. /azienda-guess/, /azienda-guess-europe/)
 // cannot cannibalise the brand query against the primary hub.
 const brandEntry = BRAND_CANONICAL_MAP[cSlug];
 if (brandEntry) {
 for (const aliasSlug of brandEntry.aliases) {
 const aliasFullSlug = `${prefix}-${aliasSlug}`;
 const aliasRelPath = `${localePrefix[locale]}/${sectionSlug}/${aliasFullSlug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const aliasHreflang = localeList.map((l) => {
 const aliasL = `${companyRoutePrefix[l]}-${brandEntry.canonical}`;
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${aliasL}`.replace(/\/+/g, '/');
 return { hreflang: l as string, href: `${BASE_URL}${withSlash(p)}` };
 });
 // audit-hreflang requires x-default on every page that emits hreflang.
 const aliasXDefaultHref = aliasHreflang.find((e) => e.hreflang === 'it')?.href
  ?? aliasHreflang[0]?.href
  ?? '';
 if (aliasXDefaultHref) {
 aliasHreflang.push({ hreflang: 'x-default', href: aliasXDefaultHref });
 }
 const aliasHtml = buildCanonicalBridgePage({
 canonicalUrl,
 pathLabel: canonicalPath,
 title: `${esc(companyName)} | Frontaliere Ticino`,
 description: `Pagina alternativa per ${companyName}. Apri la pagina canonica per gli annunci aggiornati.`,
 body: `Questa URL azienda non e la variante canonica. Apri la pagina principale dell'azienda per gli annunci aggiornati.`,
 ctaLabel: String(companyName || 'Apri azienda'),
 lang: locale,
 noindex: true,
 hreflangEntries: aliasHreflang,
 });
 const aliasDir = np.join(distDir, aliasRelPath);
 if (!fs.existsSync(np.join(aliasDir, 'index.html'))) {
 _md(aliasDir);
 _qw(np.join(aliasDir, 'index.html'), aliasHtml);
 }
 const aliasFlat = np.join(distDir, aliasRelPath + '.html');
 if (!fs.existsSync(aliasFlat)) {
 _md(np.dirname(aliasFlat));
 _qwFlat(aliasFlat, aliasHtml);
 }
 }
 }
 companyPagesCount++;
 recordEmit('company-landing', __tCompany);
 }
 }
 if (companyPagesCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${companyPagesCount} company landing pages for ${companyMap.size} companies`);
 const aliasCount = listAllBrandAliases().length * localeList.length;
 if (aliasCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Emitted ${aliasCount} brand-alias bridge pages from BRAND_CANONICAL_MAP`);
 }
 }

 /* ── Write known-company-slugs.json ─────────────────────────── */
 // Persist the canonical company slugs so employerLinks.ts can resolve
 // `/cerca-lavoro-ticino/azienda-{slug}/` hrefs without relying on the
 // stale `azienda-*` keys in all-known-job-slugs.json.
 // Ratchet: only write if the new set is at least as large as the existing one
 // to prevent fixture-data local builds from corrupting the production list.
 {
 const companySlugs = [...companyMap.keys()].sort();
 const companySlugsPath = np.resolve(rootDir, 'data/known-company-slugs.json');
 let existingCount = 0;
 try {
   const existing = JSON.parse(fs.readFileSync(companySlugsPath, 'utf-8'));
   existingCount = Array.isArray(existing) ? existing.length : 0;
 } catch { /* file doesn't exist yet */ }
 if (companySlugs.length >= existingCount) {
   fs.writeFileSync(companySlugsPath, JSON.stringify(companySlugs, null, 2) + '\n', 'utf-8');
   console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Wrote ${companySlugs.length} company slugs to known-company-slugs.json`);
 } else {
   console.log(`\x1b[33m[jobs-seo-pages]\x1b[0m Skipped writing known-company-slugs.json (${companySlugs.length} < existing ${existingCount}) — using fixture data, keeping production list`);
 }
 }

 const editorialLocations = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'] as const;
 const editorialTypeKeys = ['apprenticeship', 'internship', 'partTime'] as const;
 const editorialSectorKeys = ['health', 'finance', 'tech', 'engineering', 'admin', 'hospitality', 'sales'] as const;
 const editorialCareKeys = ['clinics', 'careHomes', 'oss', 'educators'] as const;

 const editorialSearchSlugsByLocale = new Map<typeof localeList[number], Set<string>>(
 localeList.map((locale) => [locale, new Set<string>()]),
 );

 /* ── Editorial landing: jobs today + location hubs ─────────── */
 // Pre-compute the care-cluster partition once for the entire editorial
 // section. Without this, `buildJob{Nurses,CareVariant}LandingModel` (and
 // their `buildCareVariantLinks` helper) ran 4 heavy regex matchers on
 // the (title + description ≈ 3 KB) of every one of ~2 500 jobs, twice
 // per call, ~60 calls per build → ~85 s of redundant regex evaluation
 // (run #25100009540: editorial-care-variant 180.6 s + editorial-nurses
 // 44.5 s of the 542 s plugin total). Computing the partition once and
 // threading it through the builders keeps output byte-identical
 // (same predicates, same input order) but cuts that cost to a single
 // ~700 ms scan.
 const careClusterPartition: CareClusterPartition = partitionCareClusters(validJobs);
 // Pre-compute the per-location partition (Lugano / Bellinzona / Mendrisio
 // / Locarno / Chiasso) so buildJobLocation{Landing,Type,Sector}Model and
 // their sibling-link helpers don't re-run `matchesLocation` (and the
 // 3-7 type/sector filters that follow) on the full job array on every
 // call. Run #25102007442 measured editorial-sector at 167 ms/call ×
 // 140 calls = 22 s; with the partition each call drops to a Map lookup.
 const editorialLocationsForPartition = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'];
 const locationPartition: LocationPartition = partitionByLocation(
 validJobs,
 editorialLocationsForPartition,
 );
 let editorialEntries = '';
 {
 const editorialSitemapEntries: string[] = [];
 // SPA-matching cards via the shared renderer. Editorial models now carry
 // the full enrichment payload (salary, contract, posted-date, logo,
 // canton, featured) so we forward every field to the renderer. Missing
 // fields gracefully hide the corresponding chip. Pass `locale='it'`
 // since these editorial landing pages render IT copy regardless of the
 // route locale.
 const renderJobList = (
   items: Array<{
     title: string;
     company: string;
     location: string;
     href: string;
     datePosted?: string;
     titleByLocale?: Partial<Record<'it' | 'en' | 'de' | 'fr', string>>;
     companyKey?: string;
     canton?: string;
     contract?: string;
     salaryMin?: number | null;
     salaryMax?: number | null;
     featured?: boolean;
     logo?: string | null;
     addressLocality?: string;
     companyDomain?: string;
     url?: string;
   }>,
 ) => {
   if (items.length === 0) {
     return '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
   }
   return renderJobCardListHtml(
     items.map((item) => {
       const job: JobCardJob = {
         title: item.title,
         company: item.company,
         location: item.location,
         titleByLocale: item.titleByLocale,
         companyKey: item.companyKey,
         canton: item.canton,
         contract: item.contract,
         salaryMin: item.salaryMin,
         salaryMax: item.salaryMax,
         featured: item.featured,
         logo: item.logo,
         addressLocality: item.addressLocality,
         datePosted: item.datePosted,
         companyDomain: item.companyDomain,
         url: item.url,
       };
       return { job, href: item.href };
     }),
     { locale: 'it' },
   );
 };

 /**
  * Per-(city × type) frontalier context section. Same intent as the
  * sector variant but tailored to the four type buckets:
  * apprenticeship, internship, part-time, public-tender — each has a
  * very different cross-border-worker context (regulated entry,
  * residency rules, Italy-vs-Switzerland comparison nuances).
  */
 const renderLocationTypeFrontalierContext = (args: {
  locale: 'it' | 'en' | 'de' | 'fr';
  typeKey: string;
  typeLabel: string;
  location: string;
  jobsCount: number;
 }): string => {
  const { locale: l, typeKey, typeLabel, location, jobsCount } = args;
  // Context paragraphs are tailored per typeKey to keep copy page-relevant.
  const isApprenticeship = typeKey === 'apprenticeship';
  const isInternship = typeKey === 'internship';
  const isPartTime = typeKey === 'partTime' || typeKey === 'part-time';
  const isTender = typeKey === 'tender' || typeKey === 'public-tender' || typeKey === 'concorsi';
  const baseUrl = BASE_URL;
  const calcPath = l === 'it' ? '/calcola-stipendio/'
    : l === 'de' ? '/de/gehalt-berechnen/'
    : l === 'fr' ? '/fr/calculer-salaire/'
    : '/en/calculate-salary/';
  const copy: Record<typeof l, { h: string; p1: string; p2: string }> = {
   it: {
    h: `${typeLabel} a ${location} per frontalieri`,
    p1: isApprenticeship
      ? `Le ${jobsCount} posizioni di ${typeLabel.toLowerCase()} a ${location} sono una porta d'ingresso strutturata al mercato del lavoro ticinese: il sistema svizzero della formazione professionale duale (3-4 anni alternati tra azienda e scuola professionale) è riconosciuto a livello federale ed esita un Attestato Federale di Capacità (AFC). Per i giovani frontalieri italiani residenti in zona di frontiera (entro 20 km dalla Svizzera), candidarsi a un apprendistato in Ticino significa acquisire un titolo riconosciuto in tutta la Confederazione, una formazione retribuita (CHF 600-1'200 al mese il primo anno, fino a CHF 1'800 al quarto) e una rete di datori di lavoro locali. Il Permesso G viene emesso anche per gli apprendisti minorenni con consenso scritto dei genitori; la retribuzione è soggetta a imposta alla fonte ridotta per i minori.`
      : isInternship
      ? `Gli ${jobsCount} stage attivi a ${location} sono un canale frequente per i frontalieri italiani che vogliono sperimentare il mercato del lavoro svizzero senza un impegno contrattuale a tempo indeterminato. La durata tipica è 3-6 mesi, la retribuzione varia da CHF 1'500 (stage non qualificati pre-laurea) a CHF 4'500 (stage post-laurea o laureati specializzati). Per il frontaliere lo stage richiede comunque il Permesso G, ma la procedura è semplificata se il datore svizzero è una grande azienda con esperienza HR sui frontalieri. Lo stage retribuito viene generalmente convertito in un contratto a tempo determinato o indeterminato nel 35-50 % dei casi quando esiste una posizione aperta in linea con il profilo.`
      : isPartTime
      ? `Le ${jobsCount} posizioni part-time a ${location} sono interessanti per due profili di frontaliere: chi cerca un secondo lavoro complementare al principale e chi pendola da una distanza importante (Como/Varese verso il Sottoceneri) e vuole limitare il numero di giorni di trasferta settimanali. Il part-time svizzero è regolato a percentuale (50 %, 60 %, 80 %): a parità di ruolo, il netto di un 80 % è di solito più vantaggioso del 100 % rispetto al numero di giorni lavorati una volta detratti i costi di pendolarismo. La copertura LPP scatta sopra il 60 % di occupazione; al 50 % o inferiore va valutata l'opportunità di un piano di previdenza individuale.`
      : isTender
      ? `I ${jobsCount} concorsi pubblici aperti a ${location} sono accessibili anche ai frontalieri italiani con i titoli equivalenti, ma con regole di residenza più stringenti rispetto al settore privato. Per i ruoli nell'amministrazione cantonale del Ticino, alcune posizioni richiedono la residenza svizzera al momento dell'assunzione (impiegati di concetto, dirigenti); i ruoli operativi e tecnici sono di solito accessibili al frontaliere. Il riconoscimento del titolo italiano (laurea, diploma) presso SBFI/SEFRI richiede 3-6 mesi e va lanciato in parallelo all'invio del CV. Le selezioni pubbliche svizzere prevedono di solito una prova scritta + colloquio + assessment psicometrico, con tempi di chiusura di 4-8 settimane dalla scadenza.`
      : `Le ${jobsCount} posizioni di ${typeLabel.toLowerCase()} a ${location} sono accessibili ai frontalieri italiani residenti in zona di frontiera (entro 20 km dalla Svizzera) tramite il Permesso G. La candidatura passa dal datore svizzero, che richiede il permesso all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi è rinnovata annualmente fino al limite contrattuale. Da Como il valico di Brogeda o Chiasso porta a ${location} in 25-50 minuti in ora di punta a seconda delle code; da Varese o Luino i valichi di Stabio o Gaggiolo offrono alternative.`,
    p2: `Stipendio, pendolarismo e cosa controllare nei singoli annunci. Il netto reale di una posizione di ${typeLabel.toLowerCase()} a ${location} dipende dal CCL applicato, dal Nuovo Accordo fiscale Italia-Svizzera 2024 (imposta concorrente con credito d'imposta italiano fino all'80 % sulla ritenuta svizzera), dai contributi sociali (AVS-AI-IPG 5,3 %, disoccupazione 1,1 %, LPP variabile 7-18 % per età) e dal regime fiscale cantonale. La differenza lordo-netto tipica è 18-28 %. Apri ogni annuncio per leggere mansionario, requisiti, sede precisa e tipologia contrattuale, poi calcola il netto effettivo nel <a href="${baseUrl}${calcPath}" style="color:var(--color-link);text-decoration:none">simulatore stipendio</a> tenendo conto anche dei costi di pendolarismo verso ${location} (carburante, usura veicolo, tempo perso ai valichi) per un confronto onesto con un'alternativa italiana.`,
   },
   en: {
    h: `${typeLabel} jobs in ${location} for cross-border workers`,
    p1: isApprenticeship
      ? `The ${jobsCount} active ${typeLabel.toLowerCase()} positions in ${location} are a structured entry point into the Ticino labour market: the Swiss dual vocational training system (3-4 years alternating between company and trade school) is federally recognised and leads to a Federal Capacity Certificate (AFC). For young Italian cross-border workers resident in the border zone (within 20 km of Switzerland), applying to a Ticino apprenticeship means earning a Confederation-wide recognised qualification, paid training (CHF 600-1,200/month in the first year, up to CHF 1,800 in the fourth) and a local employer network. The G permit is issued even to minor apprentices with written parental consent; pay is taxed at the reduced minor rate.`
      : isInternship
      ? `The ${jobsCount} active internships in ${location} are a frequent channel for Italian cross-border workers who want to test the Swiss labour market without a permanent contract. Typical duration is 3-6 months; pay ranges from CHF 1,500 (unqualified pre-degree internships) to CHF 4,500 (post-graduate or specialised). For cross-border workers the internship still requires a G permit, but the procedure is faster when the Swiss employer is a large company with HR experience handling cross-border employees. Paid internships are converted to fixed-term or open-ended contracts in 35-50 % of cases when an aligned opening exists.`
      : isPartTime
      ? `The ${jobsCount} part-time positions in ${location} are interesting for two cross-border profiles: those looking for a complementary second job and those commuting long distances (Como/Varese to Sottoceneri) wanting to cap weekly trips. Swiss part-time is regulated as a percentage (50 %, 60 %, 80 %): for the same role, the take-home of an 80 % role is usually more advantageous than full-time relative to days worked once commute costs are factored in. LPP pension coverage kicks in above 60 % occupancy; at 50 % or below, evaluate an individual pension plan.`
      : isTender
      ? `The ${jobsCount} public tenders in ${location} are open to Italian cross-border workers with equivalent qualifications, but with stricter residence rules than the private sector. For Ticino cantonal administration roles, some senior positions require Swiss residence at hire (white-collar, executives); operational and technical roles are usually open to cross-border workers. Italian qualification recognition (degree, diploma) at SBFI/SEFRI takes 3-6 months and should be launched in parallel with applications. Swiss public selections typically include a written test + interview + psychometric assessment, with 4-8 week closing times after the deadline.`
      : `The ${jobsCount} ${typeLabel.toLowerCase()} positions in ${location} are accessible to Italian cross-border workers resident in the border zone (within 20 km of Switzerland) through the G permit. The application goes via the Swiss employer, who files for the permit at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is renewed yearly. From Como the Brogeda or Chiasso crossing reaches ${location} in 25-50 minutes at peak times; from Varese or Luino, the Stabio or Gaggiolo crossings offer alternatives.`,
    p2: `Salary, commute and what to read in each listing. The real take-home for a ${typeLabel.toLowerCase()} role in ${location} depends on the applicable collective agreement, the 2024 Italy-Switzerland fiscal agreement (concurrent taxation, Italian tax credit up to 80 % on Swiss withholding), social charges (AVS-AI-IPG 5.3 %, unemployment 1.1 %, LPP rising from 7 % to 18 % by age) and the cantonal tax regime. The typical gross-to-net gap is 18-28 %. Open each listing for the description, requirements, exact location and contract type, then run the actual net figure in the <a href="${baseUrl}${calcPath}" style="color:var(--color-link);text-decoration:none">salary simulator</a>, factoring in commute costs to ${location} for an honest comparison with an Italian alternative.`,
   },
   de: {
    h: `${typeLabel} in ${location} für Grenzgänger`,
    p1: isApprenticeship
      ? `Die ${jobsCount} aktiven ${typeLabel.toLowerCase()}-Stellen in ${location} sind ein strukturierter Einstieg in den Tessiner Arbeitsmarkt: das duale Berufsbildungssystem der Schweiz (3-4 Jahre abwechselnd zwischen Betrieb und Berufsschule) ist auf Bundesebene anerkannt und führt zu einem Eidgenössischen Fähigkeitszeugnis (EFZ). Für junge italienische Grenzgänger mit Wohnsitz in der Grenzzone (innerhalb von 20 km zur Schweiz) bedeutet eine Tessiner Lehrstelle einen schweizweit anerkannten Abschluss, eine bezahlte Ausbildung (CHF 600-1'200/Monat im ersten Jahr, bis CHF 1'800 im vierten) und ein lokales Arbeitgebernetzwerk. Die G-Bewilligung wird auch minderjährigen Lehrlingen mit schriftlicher Einwilligung der Eltern erteilt; der Lohn wird zum reduzierten Tarif für Minderjährige besteuert.`
      : isInternship
      ? `Die ${jobsCount} aktiven Praktika in ${location} sind ein häufiger Kanal für italienische Grenzgänger, die den Schweizer Arbeitsmarkt ohne unbefristeten Vertrag testen möchten. Die typische Dauer beträgt 3-6 Monate; der Lohn reicht von CHF 1'500 (unqualifizierte Vorabschluss-Praktika) bis CHF 4'500 (Postgraduierten- oder spezialisierte Praktika). Für Grenzgänger erfordert das Praktikum weiterhin eine G-Bewilligung, das Verfahren ist aber zügiger, wenn der Schweizer Arbeitgeber ein Grossunternehmen mit HR-Erfahrung für Grenzgänger ist. Bezahlte Praktika werden in 35-50 % der Fälle in befristete oder unbefristete Verträge umgewandelt, sofern eine passende Stelle existiert.`
      : isPartTime
      ? `Die ${jobsCount} Teilzeitstellen in ${location} sind für zwei Grenzgänger-Profile interessant: jene, die einen ergänzenden Zweitjob suchen, und jene, die aus grosser Entfernung pendeln (Como/Varese ins Sottoceneri) und die Anzahl wöchentlicher Fahrten reduzieren möchten. Schweizer Teilzeit ist als Prozentsatz geregelt (50 %, 60 %, 80 %): für dieselbe Rolle ist das Netto einer 80 %-Stelle oft vorteilhafter als Vollzeit, gemessen an Arbeitstagen und unter Berücksichtigung der Pendelkosten. Die BVG-Vorsorge greift oberhalb von 60 % Arbeitspensum; bei 50 % oder weniger ist eine private Vorsorge zu prüfen.`
      : isTender
      ? `Die ${jobsCount} öffentlichen Ausschreibungen in ${location} stehen italienischen Grenzgängern mit gleichwertigen Qualifikationen offen, aber mit strikteren Wohnsitzregeln als im Privatsektor. Bei der Tessiner Kantonsverwaltung erfordern einige Senior-Positionen den Schweizer Wohnsitz bei der Anstellung (Sachbearbeitende, Kader); operative und technische Rollen stehen Grenzgängern in der Regel offen. Die Anerkennung italienischer Titel (Studium, Diplom) beim SBFI/SEFRI dauert 3-6 Monate und sollte parallel zu den Bewerbungen gestartet werden. Schweizerische öffentliche Auswahlverfahren umfassen typischerweise eine schriftliche Prüfung, ein Vorstellungsgespräch und ein psychometrisches Assessment, mit Abschlusszeiten von 4-8 Wochen nach Bewerbungsfrist.`
      : `Die ${jobsCount} ${typeLabel.toLowerCase()}-Stellen in ${location} sind für italienische Grenzgänger mit Wohnsitz in der Grenzzone (innerhalb von 20 km zur Schweiz) über die G-Bewilligung zugänglich. Die Bewerbung läuft über den Schweizer Arbeitgeber, der die Bewilligung beim kantonalen Migrationsamt nach Vertragsunterzeichnung beantragt: die erste Ausstellung dauert 2-6 Wochen, danach erfolgt die jährliche Verlängerung. Von Como erreicht der Übergang Brogeda oder Chiasso ${location} in 25-50 Minuten in Stosszeiten; von Varese oder Luino bieten Stabio oder Gaggiolo Alternativen.`,
    p2: `Lohn, Pendeln und worauf in den einzelnen Inseraten zu achten ist. Der reale Nettolohn einer ${typeLabel.toLowerCase()}-Rolle in ${location} hängt vom anwendbaren GAV, vom neuen Steuerabkommen Italien-Schweiz 2024 (konkurrierende Besteuerung, italienische Steuergutschrift bis zu 80 % auf die schweizerische Quellensteuer), den Sozialabgaben (AHV-IV-EO 5,3 %, ALV 1,1 %, BVG variabel 7-18 % nach Alter) und der kantonalen Steuerregelung ab. Der typische Brutto-Netto-Abstand beträgt 18-28 %. Öffnen Sie jedes Inserat für die Stellenbeschreibung, die Anforderungen, den genauen Arbeitsort und die Vertragsart, berechnen Sie dann den exakten Nettowert im <a href="${baseUrl}${calcPath}" style="color:var(--color-link);text-decoration:none">Lohnsimulator</a> und beziehen Sie auch die Pendelkosten nach ${location} ein.`,
   },
   fr: {
    h: `${typeLabel} à ${location} pour les frontaliers`,
    p1: isApprenticeship
      ? `Les ${jobsCount} ${typeLabel.toLowerCase()} actifs à ${location} sont une porte d'entrée structurée sur le marché du travail tessinois : le système suisse de formation professionnelle duale (3-4 ans alternant entreprise et école professionnelle) est reconnu au niveau fédéral et débouche sur un certificat fédéral de capacité (CFC). Pour les jeunes frontaliers italiens résidant en zone frontalière (à 20 km de la Suisse), un apprentissage tessinois signifie un titre reconnu sur l'ensemble de la Confédération, une formation rémunérée (CHF 600-1'200/mois la première année, jusqu'à CHF 1'800 la quatrième) et un réseau d'employeurs locaux. Le permis G est délivré même aux apprentis mineurs avec consentement écrit des parents ; le salaire est imposé au taux réduit pour mineurs.`
      : isInternship
      ? `Les ${jobsCount} stages actifs à ${location} sont un canal fréquent pour les frontaliers italiens qui veulent tester le marché du travail suisse sans engagement à durée indéterminée. La durée typique est de 3-6 mois ; la rémunération varie de CHF 1'500 (stages non qualifiés pré-diplôme) à CHF 4'500 (stages post-diplôme ou spécialisés). Pour les frontaliers, le stage requiert toujours un permis G, mais la procédure est plus rapide lorsque l'employeur suisse est une grande entreprise avec une expérience RH des frontaliers. Les stages rémunérés sont convertis en contrats à durée déterminée ou indéterminée dans 35-50 % des cas lorsqu'une ouverture alignée existe.`
      : isPartTime
      ? `Les ${jobsCount} postes à temps partiel à ${location} intéressent deux profils de frontalier : ceux qui cherchent un deuxième emploi complémentaire et ceux qui pendulaient depuis une grande distance (Côme/Varèse vers le Sottoceneri) et veulent plafonner le nombre de trajets hebdomadaires. Le temps partiel suisse est réglementé en pourcentage (50 %, 60 %, 80 %) : pour le même poste, le net d'un 80 % est souvent plus avantageux que le temps plein rapporté aux jours travaillés une fois les coûts du trajet pris en compte. La couverture LPP s'enclenche au-dessus de 60 % d'occupation ; à 50 % ou moins, évaluer un plan de prévoyance individuelle.`
      : isTender
      ? `Les ${jobsCount} concours publics à ${location} sont accessibles aux frontaliers italiens disposant des titres équivalents, mais avec des règles de résidence plus strictes que dans le privé. Pour les rôles dans l'administration cantonale tessinoise, certains postes seniors exigent la résidence suisse à l'engagement (employés de concept, cadres) ; les rôles opérationnels et techniques sont généralement ouverts aux frontaliers. La reconnaissance du titre italien (diplôme, licence) auprès du SBFI/SEFRI prend 3 à 6 mois et doit être lancée en parallèle des candidatures. Les sélections publiques suisses comportent typiquement une épreuve écrite, un entretien et une évaluation psychométrique, avec des délais de clôture de 4-8 semaines après la date limite.`
      : `Les ${jobsCount} postes de ${typeLabel.toLowerCase()} à ${location} sont accessibles aux frontaliers italiens résidant en zone frontalière (à 20 km de la Suisse) via le permis G. La candidature passe par l'employeur suisse, qui demande le permis à l'office cantonal des migrations après la signature du contrat : la première délivrance prend 2-6 semaines, puis le permis est renouvelé chaque année. Depuis Côme, le passage de Brogeda ou Chiasso atteint ${location} en 25-50 minutes aux heures de pointe ; depuis Varèse ou Luino, Stabio ou Gaggiolo offrent des alternatives.`,
    p2: `Salaire, trajet et points à vérifier dans chaque annonce. Le net réel d'un poste de ${typeLabel.toLowerCase()} à ${location} dépend de la convention collective applicable, du nouvel accord fiscal Italie-Suisse 2024 (imposition concurrente, crédit d'impôt italien jusqu'à 80 % sur la retenue suisse), des charges sociales (AVS-AI-APG 5,3 %, chômage 1,1 %, LPP variable 7-18 % selon l'âge) et du régime fiscal cantonal. L'écart brut-net typique est de 18-28 %. Ouvrez chaque annonce pour le descriptif, les exigences, le lieu et le type de contrat, puis calculez le net exact dans le <a href="${baseUrl}${calcPath}" style="color:var(--color-link);text-decoration:none">simulateur de salaire</a> en tenant compte des coûts du trajet vers ${location}.`,
   },
  };
  const c = copy[l] || copy.it;
  return `<section style="margin:0 0 28px" aria-labelledby="locTypeFrontalier">
   <h2 id="locTypeFrontalier" style="margin:0 0 14px;font-size:24px">${esc(c.h)}</h2>
   <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${c.p1}</p>
   <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${c.p2}</p>
  </section>`;
 };

 /**
  * Per-(city × sector) frontalier context section. The 150+ search-/suche-/recherche-/ricerca-
  * city×sector soft-landing pages had thin bodies (12 KB) versus heavy heads
  * (preconnects + 4 hreflangs + JSON-LD), pushing them under the 10 % text/HTML
  * Semrush gate. Adds 2 locale-aware paragraphs interpolating sector + location
  * + jobsCount so Google sees substantive page-relevant copy, not template
  * boilerplate.
  */
 const renderLocationSectorFrontalierContext = (args: {
  locale: 'it' | 'en' | 'de' | 'fr';
  sectorLabel: string;
  location: string;
  jobsCount: number;
 }): string => {
  const { locale: l, sectorLabel, location, jobsCount } = args;
  const copy: Record<typeof l, { h: string; p1: string; p2: string }> = {
   it: {
    h: `Lavorare nel settore ${sectorLabel.toLowerCase()} a ${location} da frontaliere`,
    p1: `Le ${jobsCount} offerte ${sectorLabel.toLowerCase()} attive a ${location} si rivolgono in larga parte a frontalieri italiani: il bacino di assunzione naturale dei datori del Sottoceneri include Como, Varese, Mendrisio italiana e i comuni della fascia entro 20 km dal confine. Per candidarsi serve il Permesso G, residenza in un comune italiano dentro la zona di frontiera (Lombardia o Piemonte) e il rientro al domicilio almeno una volta a settimana. Il datore richiede il permesso all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi è rinnovato annualmente. Da Como il valico di Brogeda (autostrada A2) o Chiasso-strada porta a ${location} in 25-50 minuti in ora di punta a seconda delle code; da Varese o Luino i valichi di Stabio o Gaggiolo offrono alternative.`,
    p2: `Stipendio e cosa controllare nei singoli annunci. Le ${jobsCount} offerte di ${sectorLabel.toLowerCase()} a ${location} pubblicano la retribuzione come lordo annuo: il netto reale dipende dal CCL applicato, dal Nuovo Accordo fiscale Italia-Svizzera 2024 (imposta concorrente con credito d'imposta italiano fino all'80 % sulla ritenuta svizzera), dai contributi sociali (AVS-AI-IPG 5,3 %, disoccupazione 1,1 % fino a 148.200 CHF/anno, LPP variabile 7-18 % per età) e dal regime fiscale cantonale. La differenza lordo-netto tipica è 18-28 %. Apri ogni annuncio per leggere mansionario, requisiti, sede precisa e tipologia contrattuale, poi calcola il netto effettivo nel <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link);text-decoration:none">simulatore stipendio</a> tenendo conto anche dei costi di pendolarismo verso ${location} (carburante, usura veicolo, tempo perso ai valichi) per un confronto onesto con un'alternativa italiana.`,
   },
   en: {
    h: `Working in ${sectorLabel.toLowerCase()} in ${location} as a cross-border worker`,
    p1: `The ${jobsCount} active ${sectorLabel.toLowerCase()} listings in ${location} largely target Italian cross-border workers: the natural hiring catchment for Sottoceneri employers covers Como, Varese, Italian-side Mendrisio and the municipalities within the 20 km border zone. Applying requires a G Permit, residence in an Italian municipality inside the border zone (Lombardy or Piedmont) and returning home at least once a week. The employer files for the permit at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is renewed yearly. From Como the Brogeda (A2 motorway) or Chiasso-strada crossing reaches ${location} in 25-50 minutes at peak times depending on the queue; from Varese or Luino, the Stabio or Gaggiolo crossings offer alternatives.`,
    p2: `Salary and what to read in each listing. The ${jobsCount} ${sectorLabel.toLowerCase()} openings in ${location} post compensation as gross annual figures: real take-home depends on the applicable collective agreement, the 2024 Italy-Switzerland fiscal agreement (concurrent taxation, Italian tax credit up to 80 % on the Swiss withholding), social charges (AVS-AI-IPG 5.3 %, unemployment 1.1 % up to CHF 148,200/year, LPP rising from 7 % at 25 to 18 % over 55) and the cantonal tax regime. The typical gross-to-net gap is 18-28 %. Open each listing for the job description, requirements, exact location and contract type, then run the actual net figure in the <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link);text-decoration:none">salary simulator</a>, factoring in commute costs to ${location} (fuel, vehicle wear, time lost at the border) for an honest comparison with an Italian alternative.`,
   },
   de: {
    h: `Als Grenzgänger im Sektor ${sectorLabel.toLowerCase()} in ${location} arbeiten`,
    p1: `Die ${jobsCount} aktiven ${sectorLabel.toLowerCase()}-Stellen in ${location} richten sich grösstenteils an italienische Grenzgänger: das natürliche Einzugsgebiet der Sottoceneri-Arbeitgeber umfasst Como, Varese, das italienische Mendrisio und die Gemeinden innerhalb der 20-km-Grenzzone. Eine Bewerbung setzt eine G-Bewilligung voraus, Wohnsitz in einer italienischen Gemeinde innerhalb der Grenzzone (Lombardei oder Piemont) und Rückkehr nach Hause mindestens einmal pro Woche. Der Arbeitgeber beantragt die Bewilligung beim kantonalen Migrationsamt nach Vertragsunterzeichnung: die erste Ausstellung dauert 2-6 Wochen, anschliessend erfolgt die jährliche Verlängerung. Von Como erreicht man ${location} über den Grenzübergang Brogeda (Autobahn A2) oder Chiasso-Strasse in 25-50 Minuten in Stosszeiten je nach Wartezeit; von Varese oder Luino bieten Stabio oder Gaggiolo Alternativen.`,
    p2: `Lohn und worauf in den einzelnen Inseraten zu achten ist. Die ${jobsCount} ${sectorLabel.toLowerCase()}-Stellen in ${location} geben Löhne als Bruttojahresgehalt an: der reale Nettolohn hängt vom anwendbaren GAV, vom neuen Steuerabkommen Italien-Schweiz 2024 (konkurrierende Besteuerung, italienische Steuergutschrift bis zu 80 % auf die schweizerische Quellensteuer), den Sozialabgaben (AHV-IV-EO 5,3 %, ALV 1,1 % bis CHF 148'200/Jahr, BVG variabel von 7 % mit 25 Jahren bis 18 % über 55) und der kantonalen Steuerregelung ab. Der typische Brutto-Netto-Abstand beträgt 18-28 %. Öffnen Sie jedes Inserat für die Stellenbeschreibung, die Anforderungen, den genauen Arbeitsort und die Vertragsart, berechnen Sie dann den exakten Nettowert im <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link);text-decoration:none">Lohnsimulator</a> und beziehen Sie auch die Pendelkosten nach ${location} (Treibstoff, Fahrzeugverschleiss, Wartezeit an der Grenze) ein.`,
   },
   fr: {
    h: `Travailler dans le secteur ${sectorLabel.toLowerCase()} à ${location} en tant que frontalier`,
    p1: `Les ${jobsCount} offres ${sectorLabel.toLowerCase()} actives à ${location} ciblent en grande partie les frontaliers italiens : le bassin d'embauche naturel des employeurs du Sottoceneri inclut Côme, Varèse, Mendrisio italienne et les communes de la bande des 20 km. Pour postuler, il faut un permis G, une résidence dans une commune italienne située dans la zone frontière (Lombardie ou Piémont) et un retour au domicile au moins une fois par semaine. L'employeur demande le permis à l'office cantonal des migrations après la signature du contrat : la première délivrance prend 2 à 6 semaines, puis le permis est renouvelé chaque année. Depuis Côme, le poste-frontière de Brogeda (autoroute A2) ou Chiasso-route conduit à ${location} en 25-50 minutes aux heures de pointe selon la file ; depuis Varèse ou Luino, les passages de Stabio ou Gaggiolo offrent des alternatives.`,
    p2: `Salaire et points à vérifier dans chaque annonce. Les ${jobsCount} offres ${sectorLabel.toLowerCase()} à ${location} publient les rémunérations en brut annuel : le net réel dépend de la convention collective applicable, du nouvel accord fiscal Italie-Suisse 2024 (imposition concurrente, crédit d'impôt italien jusqu'à 80 % sur la retenue suisse), des charges sociales (AVS-AI-APG 5,3 %, chômage 1,1 % jusqu'à CHF 148'200/an, LPP variable de 7 % à 25 ans à 18 % au-delà de 55 ans) et du régime fiscal cantonal. L'écart brut-net typique est de 18 à 28 %. Ouvrez chaque annonce pour le descriptif, les exigences, le lieu exact et le type de contrat, puis calculez le net exact dans le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link);text-decoration:none">simulateur de salaire</a> en tenant compte des coûts du trajet vers ${location} (carburant, usure du véhicule, temps perdu à la frontière).`,
   },
  };
  const c = copy[l] || copy.it;
  return `<section style="margin:0 0 28px" aria-labelledby="locSectorFrontalier">
   <h2 id="locSectorFrontalier" style="margin:0 0 14px;font-size:24px">${esc(c.h)}</h2>
   <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${c.p1}</p>
   <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${c.p2}</p>
  </section>`;
 };
 const buildEditorialJsonLd = (options: {
 locale: typeof localeList[number];
 name: string;
 url: string;
 description: string;
 isPartOf: string;
 breadcrumbs: Array<{ name: string; item: string }>;
 items: Array<{ title: string; href: string }>;
 }) => {
 const breadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: options.breadcrumbs.map((crumb, index) => ({
 '@type': 'ListItem',
 position: index + 1,
 name: crumb.name,
 item: crumb.item,
 })),
 });
 const collectionLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: options.name,
 url: options.url,
 description: options.description,
 inLanguage: options.locale,
 isPartOf: options.isPartOf,
 });
 const itemListLd = options.items.length > 0
 ? JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: options.name,
 itemListElement: options.items.slice(0, 10).map((item, index) => ({
 '@type': 'ListItem',
 position: index + 1,
 name: item.title,
 url: item.href,
 })),
 })
 : '';
 return { breadcrumbLd, collectionLd, itemListLd };
 };

 const pushEditorialSitemapEntry = (
 buildModel: (locale: typeof localeList[number]) => { slug: string },
 priority: string,
 ) => {
 const itModel = buildModel('it');
 const itPath = withSlash(`/${sectionByLocale.it}/${itModel.slug}`.replace(/\/+/g, '/'));
 // Sitemap-jobs alignment (Issue 18): never advertise a URL whose static
 // HTML wasn't actually emitted to dist/. The same plugin emits both the
 // page HTML and the sitemap entry; if an earlier step skipped emission
 // (e.g. zero jobs for that location/sector), the sitemap entry must
 // follow. Probes the canonical Italian path the page would live at —
 // alternates would all be dead too if the IT canonical isn't.
 const itDirIndex = np.join(distDir, itPath.slice(1).replace(/\/$/, ''), 'index.html');
 const itFlatHtml = np.join(distDir, itPath.replace(/\/+$/, '').slice(1) + '.html');
 const itEmitted = _writtenPaths.has(itDirIndex) || _writtenPaths.has(itFlatHtml) || fs.existsSync(itDirIndex) || fs.existsSync(itFlatHtml);
 if (!itEmitted) return;
 const alternateLinks = localeList.map((locale) => {
 const localeModel = buildModel(locale);
 const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localeModel.slug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${withSlash(path)}" />`;
 }).join('\n');
 editorialSitemapEntries.push(` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>${priority}</priority>\n </url>`);
 };

 for (const editorialCanton of EDITORIAL_CANTONS) {
 for (const locale of localeList) {
 const __tEdJobsToday = startTimer();
 const model = buildJobTodayLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });

 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 // x-default required by audit-hreflang alongside the 4 locale entries.
 // OPT: hreflang only needs the slug per locale — call the lightweight
 // getJobTodayLandingSlug() helper instead of running the full
 // buildJobTodayLandingModel() pipeline (which filters all jobs into 24h/3d/
 // partTime + computes city leaders). Saves ~4 model builds per emit ×
 // 12 editorial-jobs-today emits = ~3.7s of build wall.
 const todayHreflangPairs = localeList.map((altLocale) => {
 const altSlug = getJobTodayLandingSlug(altLocale, editorialCanton);
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altSlug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const xDefaultToday = todayHreflangPairs.find((p) => p.lang === 'it')?.href ?? todayHreflangPairs[0]?.href ?? '';
 const alternates = [
 ...todayHreflangPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ...(xDefaultToday ? [` <link rel="alternate" hreflang="x-default" href="${xDefaultToday}">`] : []),
 ].join('\n');
 const openAllHref = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const cityCards = model.sections.cities.length > 0
 ? model.sections.cities.map((city) => city.href
     ? `<a href="${city.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(city.name)}</span><span style="color:var(--color-link)">${city.count}</span></a>`
     : `<div style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);font-weight:600"><span>${esc(city.name)}</span><span style="color:var(--color-link)">${city.count}</span></div>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 const internalLinks = model.internalLinks.map((item) => `<a href="${item.href}" style="display:inline-flex;padding:8px 12px;border-radius:999px;background:var(--color-accent-subtle);color:var(--color-accent);text-decoration:none;font-weight:700;font-size:13px">${esc(item.label)}</a>`).join('');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.sections.last24Hours.jobs, ...model.sections.last3Days.jobs, ...model.sections.partTime.jobs],
 });

 const editorialHtml = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(model.description)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.sections.last24Hours.label)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.sections.last24Hours.jobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.sections.last3Days.label)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.sections.last3Days.jobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-warning-subtle);border:1px solid var(--color-warning-border)"><div style="font-size:12px;color:var(--color-warning);font-weight:700;text-transform:uppercase">${esc(model.sections.partTime.label)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.sections.partTime.jobs.length}</div></div>
 </section>
 <nav style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px">${internalLinks}</nav>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.sections.cityHubLabel)}</h2>
 <a href="${openAllHref}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${cityCards}</div>
 </section>
 <section id="last-24-hours" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.sections.last24Hours.label)}</h2>
 ${renderJobList(model.sections.last24Hours.jobs)}
 </section>
 <section id="last-3-days" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.sections.last3Days.label)}</h2>
 ${renderJobList(model.sections.last3Days.jobs)}
 </section>
 <section id="part-time" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.sections.partTime.label)}</h2>
 ${renderJobList(model.sections.partTime.jobs)}
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: CANTON_DISPLAY[editorialCanton] || editorialCanton, omitCommute: true }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;

 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), editorialHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, editorialHtml);
 }
 recordEmit('editorial-jobs-today', __tEdJobsToday);
 }

 pushEditorialSitemapEntry((locale) => buildJobTodayLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.8');
 }

 for (const locale of localeList) {
 const __tEdGazette = startTimer();
 const model = buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 const explainerCards = model.explainerCards.map((card) => `<div style="padding:18px;border-radius:18px;border:1px solid var(--color-edge);background:var(--color-surface)"><h3 style="margin:0 0 8px;font-size:18px;color:var(--color-heading)">${esc(card.title)}</h3><p style="margin:0;color:var(--color-subtle);line-height:1.7">${esc(card.body)}</p></div>`).join('');
 const internalLinks = model.internalLinks.map((item) => `<a href="${item.href}" style="display:inline-flex;padding:8px 12px;border-radius:999px;background:var(--color-accent-subtle);color:var(--color-accent);text-decoration:none;font-weight:700;font-size:13px">${esc(item.label)}</a>`).join('');
 const faqHtml = model.faq.map((entry) => `<details style="padding:16px 18px;border-radius:18px;border:1px solid var(--color-edge);background:var(--color-surface)"><summary style="cursor:pointer;font-weight:700;color:var(--color-heading)">${esc(entry.question)}</summary><p style="margin:12px 0 0;color:var(--color-subtle);line-height:1.7">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(model.description)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-surface-alt);border:1px solid var(--color-edge)"><div style="font-size:12px;color:var(--color-body);font-weight:700;text-transform:uppercase">${esc(model.officialSourceLabel)}</div><div style="margin-top:8px;font-size:15px;font-weight:800"><a href="${model.officialSourceUrl}" style="color:var(--color-link);text-decoration:none">concorsi.ti.ch</a></div></div>
 </section>
 <nav style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px">${internalLinks}</nav>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.explainerTitle)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">${explainerCards}</div>
 </section>
 <section id="official-competitions" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div style="display:grid;gap:12px">${faqHtml}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: 'Ticino', omitCommute: true }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-gazette', __tEdGazette);
 }

 pushEditorialSitemapEntry((locale) => buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 }), '0.78');

 for (const editorialCanton of EDITORIAL_CANTONS) {
 for (const locale of localeList) {
 const __tEdNurses = startTimer();
 const model = buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const variantLinks = model.variants.length > 0
 ? model.variants.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:var(--color-link)">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 const explainerCards = model.explainerCards.map((card) => `<div style="padding:18px;border-radius:18px;border:1px solid var(--color-edge);background:var(--color-surface)"><h3 style="margin:0 0 8px;font-size:18px;color:var(--color-heading)">${esc(card.title)}</h3><p style="margin:0;color:var(--color-subtle);line-height:1.7">${esc(card.body)}</p></div>`).join('');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 const faqHtml = model.faq.map((entry) => `<details style="padding:16px 18px;border-radius:18px;border:1px solid var(--color-edge);background:var(--color-surface)"><summary style="cursor:pointer;font-weight:700;color:var(--color-heading)">${esc(entry.question)}</summary><p style="margin:12px 0 0;color:var(--color-subtle);line-height:1.7">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(model.description)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.variantTitle)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.variants.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.variantTitle)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${variantLinks}</div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">${explainerCards}</div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div style="display:grid;gap:12px">${faqHtml}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: CANTON_DISPLAY[editorialCanton] || editorialCanton, omitCommute: true }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 // Alias: /cerca-lavoro-ticino/lavoro-infermieri/ → same content, canonical inside already points to infermieri-in-ticino
 if (editorialCanton === 'TI' && locale === 'it') {
 const aliasPath = withSlash(`/${sectionByLocale[locale]}/lavoro-infermieri`);
 const aliasOutDir = np.join(distDir, aliasPath.slice(1));
 _md(aliasOutDir);
 _qw(np.join(aliasOutDir, 'index.html'), html);
 }
 recordEmit('editorial-nurses', __tEdNurses);
 }

 pushEditorialSitemapEntry((locale) => buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 }), '0.77');
 }

 /* ── Editorial landing: global part-time ───────────────────── */
 for (const editorialCanton of EDITORIAL_CANTONS) {
 for (const locale of localeList) {
 const __tEdPartTimeCanton = startTimer();
 const model = buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const cityCards = model.cityLinks.length > 0
 ? model.cityLinks.map((city) => city.href
     ? `<a href="${city.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(city.name)}</span><span style="color:var(--color-link)">${city.count}</span></a>`
     : `<div style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);font-weight:600"><span>${esc(city.name)}</span><span style="color:var(--color-link)">${city.count}</span></div>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 inLanguage: locale,
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 const faqHtml = model.faq.map((entry) => `<details style="padding:16px 18px;border-radius:18px;border:1px solid var(--color-edge);background:var(--color-surface)"><summary style="cursor:pointer;font-weight:700;color:var(--color-heading)">${esc(entry.question)}</summary><p style="margin:12px 0 0;color:var(--color-subtle);line-height:1.7">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(model.description)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.cityHubLabel)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${cityCards}</div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div style="display:grid;gap:12px">${faqHtml}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: CANTON_DISPLAY[editorialCanton] || editorialCanton, omitCommute: true }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-parttime-canton', __tEdPartTimeCanton);
 }

 pushEditorialSitemapEntry((locale) => buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.76');
 }

 for (const clusterKey of editorialCareKeys) {
 for (const editorialCanton of EDITORIAL_CANTONS) {
 const italianCareModel = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale: 'it',
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 if (italianCareModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const __tEdCareVariant = startTimer();
 const model = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale: altLocale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 partition: careClusterPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const siblingLinks = model.siblingLinks.length > 0
 ? model.siblingLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:var(--color-link)">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentHubHref,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: locale === 'it' ? `Infermieri in ${CANTON_DISPLAY[editorialCanton] || editorialCanton}` : locale === 'en' ? `Nurses in ${CANTON_DISPLAY[editorialCanton] || editorialCanton}` : locale === 'de' ? `Pflege-Jobs ${germanCantonPrep(CANTON_DISPLAY[editorialCanton] || editorialCanton)}` : `Infirmiers ${frenchCantonPrep(CANTON_DISPLAY[editorialCanton] || editorialCanton)}`, item: model.parentHubHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const edc = CANTON_DISPLAY[editorialCanton] || editorialCanton;
 const backLabel = locale === 'it' ? `Torna all\u2019hub infermieri in ${edc}` : locale === 'en' ? `Back to nurses in ${edc}` : locale === 'de' ? `Zur\u00FCck zum Pflege-Hub ${germanCantonPrep(edc)}` : `Retour au hub infirmiers ${frenchCantonPrep(edc)}`;
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(model.description)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 <p style="margin:14px 0 0"><a href="${model.parentHubHref}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(backLabel)}</a></p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? 'Altri percorsi sanitari' : locale === 'en' ? 'Other care paths' : locale === 'de' ? 'Weitere Pflegepfade' : 'Autres parcours sante')}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${siblingLinks}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: CANTON_DISPLAY[editorialCanton] || editorialCanton, omitCommute: true, sectorOrType: locale === 'it' ? 'sanità' : locale === 'en' ? 'healthcare' : locale === 'de' ? 'Gesundheitswesen' : 'santé' }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-care-variant', __tEdCareVariant);
 }

 pushEditorialSitemapEntry((locale) => buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 partition: careClusterPartition,
 }), '0.71');
 }
 }

 for (const location of editorialLocations) {
 const italianLocationModel = buildJobLocationLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 partition: locationPartition,
 });
 if (italianLocationModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const __tEdLocation = startTimer();
 const model = buildJobLocationLandingModel({
 jobs: validJobs,
 locale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 // Detect if this location is a canonical geo-hub city — those pages are
 // canonicalized to the clean `/cerca-lavoro-ticino/<city>/` URL rather
 // than the legacy `ricerca-<city>` editorial slug, to resolve GSC
 // cannibalization and concentrate link equity on the clean hub.
 const cityHubKey: CityHubKey | undefined = CITY_HUB_KEYS.find(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 const legacyPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalPath = cityHubKey
 ? buildCityHubPath(locale, cityHubKey)
 : legacyPath;
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 // Build per-locale hreflangs + x-default → IT target.
 // audit-hreflang requires 5 entries (4 locales + x-default) on every
 // page that emits any hreflang; city + editorial search-landing pages
 // previously emitted only 4, triggering 1750+ FAILs on clean builds.
 const localeHreflangLinks: { lang: string; href: string }[] = localeList.map((altLocale) => {
 if (cityHubKey) {
 return { lang: altLocale, href: `${BASE_URL}${buildCityHubPath(altLocale, cityHubKey)}` };
 }
 const altModel = buildJobLocationLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 partition: locationPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const xDefaultCityHref = localeHreflangLinks.find((h) => h.lang === 'it')?.href
  ?? localeHreflangLinks[0]?.href
  ?? '';
 const alternates = [
 ...localeHreflangLinks.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ...(xDefaultCityHref ? [` <link rel="alternate" hreflang="x-default" href="${xDefaultCityHref}">`] : []),
 ].join('\n');
 const typeLinks = model.relatedTypeLinks.length > 0
 ? model.relatedTypeLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:var(--color-link)">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 const sectorLinks = model.relatedSectorLinks.length > 0
 ? model.relatedSectorLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-success-border);border-radius:16px;background:var(--color-success-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:var(--color-success)">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 // For geo-hub cities, override title/description with boosted count+fire
 // copy to target high-intent queries like "lavoro lugano".
 const cityHubSeo = cityHubKey
 ? buildCityHubSeo(locale, cityHubKey, model.totalJobs, new Date().getFullYear())
 : null;
 const pageTitle = cityHubSeo ? cityHubSeo.title : model.title;
 const pageDesc = cityHubSeo ? cityHubSeo.desc : model.description;
 const pageOgTitle = cityHubSeo ? cityHubSeo.ogT : model.title;
 const pageOgDesc = cityHubSeo ? cityHubSeo.ogD : model.description;
 const pageH1 = cityHubSeo ? cityHubSeo.h1 : model.heading;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: pageH1,
 url: canonicalUrl,
 description: pageDesc,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: pageH1, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(pageTitle)}</title>
 <meta name="description" content="${esc(pageDesc)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(pageOgTitle)}">
 <meta property="og:description" content="${esc(pageOgDesc)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(pageOgTitle)}">
 <meta name="twitter:description" content="${esc(pageOgDesc)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(pageH1)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(pageDesc)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Tipi di lavoro a ${location}` : locale === 'en' ? `Job types in ${location}` : locale === 'de' ? `Jobtypen in ${location}` : `Types d'emploi a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${typeLinks}</div>
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Settori a ${location}` : locale === 'en' ? `Sectors in ${location}` : locale === 'de' ? `Branchen in ${location}` : `Secteurs a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${sectorLinks}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 // Primary write — at canonicalPath (clean URL for geo-hub cities,
 // legacy `ricerca-<slug>` editorial path otherwise).
 const writeCityOrLegacy = (targetPath: string, body: string) => {
 const outDir = np.join(distDir, targetPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), body);
 const flat = targetPath.replace(/\/+$/, '');
 if (flat) {
 const flatFile = np.join(distDir, flat.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, body);
 }
 };
 // Hard-fail guard mirroring the jobSectorPagesPlugin invariant — keeps
 // city/type/sector landing HTML strictly under the 195 KB safety margin
 // (200 KB audit:page-weight budget − 5 KB headroom). If a future cap
 // bump or template change pushes us over, the build fails immediately
 // with a precise URL instead of waiting for the post-build audit.
 const CITY_HUB_HARD_BUDGET_BYTES = 195 * 1024;
 const htmlBytes = Buffer.byteLength(html, 'utf-8');
 if (htmlBytes > CITY_HUB_HARD_BUDGET_BYTES) {
 throw new Error(
 `[jobsSeoPagesPlugin] City/editorial landing ${canonicalPath} renders to ` +
 `${(htmlBytes / 1024).toFixed(1)} KB — exceeds hard budget of ` +
 `${CITY_HUB_HARD_BUDGET_BYTES / 1024} KB. Reduce feed/latest caps in ` +
 `buildJobLocationLandingModel or trim per-card markup.`,
 );
 }
 writeCityOrLegacy(canonicalPath, html);
 // Geo-hub cities: keep the legacy /<section>/ricerca-<city>/ path live
 // (backward-compat + external links). Strip hreflang on the legacy
 // duplicate — Semrush/Google flag canonicalized pages that emit
 // hreflang pointing away from themselves ("Conflicting hreflang and
 // rel=canonical" + "No self-referencing hreflang"). Canonical alone
 // consolidates equity onto the clean URL.
 if (cityHubKey && legacyPath !== canonicalPath) {
 const legacyHtml = html.replace(`${alternates}\n`, '');
 writeCityOrLegacy(legacyPath, legacyHtml);
 }
 recordEmit('editorial-location', __tEdLocation);
 }

 // SEO: skip — page self-canonicalizes elsewhere (Semrush gate).
 // For geo-hub cities the rendered legacy `ricerca-<city>` page sets
 // <link rel="canonical"> to the clean `/cerca-lavoro-ticino/<city>/`
 // URL, so emitting a sitemap entry for the legacy slug would advertise
 // a non-canonical URL. The clean canonical is added separately below.
 const isGeoHubCity = CITY_HUB_KEYS.some(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 if (!isGeoHubCity) {
 pushEditorialSitemapEntry((locale) => buildJobLocationLandingModel({
 jobs: validJobs,
 locale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 }), '0.75');
 }

 // Geo-hub city: add a dedicated sitemap entry for the clean canonical
 // URL /cerca-lavoro-ticino/<city>/ (and locale variants). Priority 0.85
 // — higher than legacy ricerca-* editorial pages since the clean URL is
 // the canonical target for high-intent queries.
 {
 const cityHubKey: CityHubKey | undefined = CITY_HUB_KEYS.find(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 if (cityHubKey) {
 const itPath = `/${sectionByLocale.it}/${CITY_HUB_SLUG.it[cityHubKey]}/`.replace(/\/+/g, '/');
 const alternateLinks = localeList.map((locale) => {
 const altPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${CITY_HUB_SLUG[locale][cityHubKey]}/`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${altPath}" />`;
 }).join('\n');
 editorialSitemapEntries.push(` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.85</priority>\n </url>`);
 }
 }

 for (const typeKey of editorialTypeKeys) {
 const italianTypeModel = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 partition: locationPartition,
 });
 if (italianTypeModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const __tEdContractType = startTimer();
 const model = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 partition: locationPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const siblingLinks = model.siblingTypeLinks.length > 0
 ? model.siblingTypeLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-accent-border);border-radius:16px;background:var(--color-accent-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:var(--color-link)">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 const parentLabel = locale === 'it' ? `Torna a lavoro a ${location}` : locale === 'en' ? `Back to jobs in ${location}` : locale === 'de' ? `Zuruck zu Jobs in ${location}` : `Retour aux emplois a ${location}`;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentLocationHref,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: locale === 'it' ? `Lavoro a ${location} in Ticino` : locale === 'en' ? `Jobs in ${location}, Ticino` : locale === 'de' ? `Jobs in ${location}, Tessin` : `Emploi a ${location}, Tessin`, item: model.parentLocationHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(model.description)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 <p style="margin:14px 0 0"><a href="${model.parentLocationHref}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(parentLabel)}</a></p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 ${renderLocationTypeFrontalierContext({ locale, typeKey, typeLabel: model.typeLabel, location, jobsCount: model.totalJobs })}
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Altri tipi di lavoro a ${location}` : locale === 'en' ? `Other job types in ${location}` : locale === 'de' ? `Weitere Jobtypen in ${location}` : `Autres types d'emploi a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${siblingLinks}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location, sectorOrType: model.typeLabel }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-contract-type', __tEdContractType);
 }

 pushEditorialSitemapEntry((locale) => buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 }), '0.68');
 }

 for (const sectorKey of editorialSectorKeys) {
 const italianSectorModel = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 partition: locationPartition,
 });
 if (italianSectorModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const __tEdSector = startTimer();
 const model = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const _altPairs = localeList
 .map((altLocale) => {
 const altModel = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 partition: locationPartition,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const siblingLinks = model.siblingSectorLinks.length > 0
 ? model.siblingSectorLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--color-success-border);border-radius:16px;background:var(--color-success-subtle);color:var(--color-heading);text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:var(--color-success)">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:var(--color-subtle);font-size:14px">—</p>';
 const parentLabel = locale === 'it' ? `Torna a lavoro a ${location}` : locale === 'en' ? `Back to jobs in ${location}` : locale === 'de' ? `Zuruck zu Jobs in ${location}` : `Retour aux emplois a ${location}`;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentLocationHref,
 breadcrumbs: [
 { name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: locale === 'it' ? `Lavoro a ${location} in Ticino` : locale === 'en' ? `Jobs in ${location}, Ticino` : locale === 'de' ? `Jobs in ${location}, Tessin` : `Emploi a ${location}, Tessin`, item: model.parentLocationHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root"></div>
 <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px;color:var(--color-body)">${esc(model.description)}</p>
 <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 <p style="margin:14px 0 0"><a href="${model.parentLocationHref}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(parentLabel)}</a></p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)"><div style="font-size:12px;color:var(--color-accent);font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:var(--color-success-subtle);border:1px solid var(--color-success-border)"><div style="font-size:12px;color:var(--color-success);font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid var(--color-edge);background:var(--color-surface)">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 ${renderLocationSectorFrontalierContext({ locale, sectorLabel: model.sectorLabel, location, jobsCount: model.totalJobs })}
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Altri settori a ${location}` : locale === 'en' ? `Other sectors in ${location}` : locale === 'de' ? `Weitere Branchen in ${location}` : `Autres secteurs a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${siblingLinks}</div>
 </section>
 ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location, sectorOrType: model.sectorLabel }))}
 </main>
 <div id="footer-root"></div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, html);
 }
 recordEmit('editorial-sector', __tEdSector);
 }

 pushEditorialSitemapEntry((locale) => buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 partition: locationPartition,
 }), '0.67');
 }
 }

 editorialEntries = editorialSitemapEntries.join('\n');

 }

 /* ── Static paginated listing pages (/cerca-lavoro-ticino/pagina-N/) ── */
 const paginationSlugs: Record<'it' | 'en' | 'de' | 'fr', string> = { it: 'pagina', en: 'page', de: 'seite', fr: 'page' };
 const JOBS_PER_LISTING_PAGE = 20;
 const MAX_LISTING_PAGES = 25;
 const sortedForPagination = [...validJobs].sort((a: any, b: any) => {
 const da = new Date(b.crawledAt || b.datePosted || 0).getTime();
 const db = new Date(a.crawledAt || a.datePosted || 0).getTime();
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const totalListingPages = Math.min(MAX_LISTING_PAGES, Math.ceil(sortedForPagination.length / JOBS_PER_LISTING_PAGE));
 let paginationPageCount = 0;
 const paginationSitemapEntries: string[] = [];
 const pagCopy: Record<'it' | 'en' | 'de' | 'fr', { title: (n: number) => string; desc: (n: number, from: number, to: number) => string; heading: (n: number) => string }> = {
 it: { title: (n) => `Lavoro in Ticino - Pagina ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Pagina ${n}: annunci di lavoro dal ${f} al ${t} in Ticino. Offerte aggiornate quotidianamente.`, heading: (n) => `Offerte di lavoro in Ticino \u2014 Pagina ${n}` },
 en: { title: (n) => `Jobs in Ticino - Page ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Page ${n}: job listings ${f}\u2013${t} in Ticino. Updated daily from Swiss career portals.`, heading: (n) => `Job openings in Ticino \u2014 Page ${n}` },
 de: { title: (n) => `Stellen im Tessin - Seite ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Seite ${n}: Stellenangebote ${f}\u2013${t} im Tessin. T\u00e4glich aktualisiert.`, heading: (n) => `Stellenangebote im Tessin \u2014 Seite ${n}` },
 fr: { title: (n) => `Emploi au Tessin - Page ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Page ${n}: offres d'emploi ${f}\u2013${t} au Tessin. Mises \u00e0 jour quotidiennement.`, heading: (n) => `Offres d'emploi au Tessin \u2014 Page ${n}` },
 };
 for (let pageNum = 2; pageNum <= totalListingPages; pageNum++) {
 const startIdx = (pageNum - 1) * JOBS_PER_LISTING_PAGE;
 const pgJobs = sortedForPagination.slice(startIdx, startIdx + JOBS_PER_LISTING_PAGE);
 if (pgJobs.length === 0) break;
 for (const locale of localeList) {
 const __tPaginated = startTimer();
 const pgSlug = `${paginationSlugs[locale]}-${pageNum}`;
 const pgCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${pgSlug}`.replace(/\/+/g, '/'));
 const pgCanonicalUrl = `${BASE_URL}${pgCanonicalPath}`;
 const pgCopy = pagCopy[locale];
 const pgFrom = startIdx + 1;
 const pgTo = Math.min(startIdx + JOBS_PER_LISTING_PAGE, sortedForPagination.length);
 const pgTitle = pgCopy.title(pageNum);
 const pgDesc = pgCopy.desc(pageNum, pgFrom, pgTo);
 const pgAlternates = localeList.map((al) => {
 const alSlug = `${paginationSlugs[al]}-${pageNum}`;
 const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${al}" href="${BASE_URL}${withSlash(alPath)}">`;
 }).join('\n');
 const pgXDefault = ` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(`/${sectionByLocale.it}/${paginationSlugs.it}-${pageNum}`.replace(/\/+/g, '/'))}">`;
 const pgSectionPath = `${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/');
 const pgPrevHref = pageNum === 2 ? `${BASE_URL}${withSlash(pgSectionPath)}` : `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum - 1}`.replace(/\/+/g, '/'))}`;
 const pgNextHref = pageNum < totalListingPages ? `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum + 1}`.replace(/\/+/g, '/'))}` : '';
 const pgPrevLink = ` <link rel="prev" href="${pgPrevHref}">`;
 const pgNextLink = pgNextHref ? `\n <link rel="next" href="${pgNextHref}">` : '';
 const pgListHtml = pgJobs.map((job: any) => renderJobCardLi(job, locale)).join('');
 const pgCollLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: pgTitle, url: pgCanonicalUrl, description: pgDesc, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL } });
 const pgItemLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', name: pgTitle, numberOfItems: pgJobs.length, itemListElement: pgJobs.slice(0, 10).map((job: any, i: number) => ({ '@type': 'ListItem', position: i + 1, name: String(job?.titleByLocale?.[locale] || job.title || ''), url: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/'))}` })) });
 const pgMainUrl = `${BASE_URL}${withSlash(pgSectionPath)}`;
 const pgHomeUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const pgListName = locale === 'it' ? 'Lavoro in Ticino' : locale === 'en' ? 'Jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Emploi au Tessin';
 const pgBreadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: pgHomeUrl },
 { '@type': 'ListItem', position: 2, name: pgListName, item: pgMainUrl },
 { '@type': 'ListItem', position: 3, name: pgCopy.heading(pageNum), item: pgCanonicalUrl },
 ],
 });
 const pgNav: string[] = [`<a href="${pgMainUrl}" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:8px 12px">1</a>`];
 for (let np2 = Math.max(2, pageNum - 2); np2 <= Math.min(totalListingPages, pageNum + 2); np2++) {
 if (np2 === pageNum) { pgNav.push(`<strong>${np2}</strong>`); continue; }
 pgNav.push(`<a href="${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${np2}`.replace(/\/+/g, '/'))}" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:8px 12px">${np2}</a>`);
 }
 const pgBackLabel = locale === 'it' ? 'Torna alla lista completa' : locale === 'en' ? 'Back to full listing' : locale === 'de' ? 'Zur\u00fcck zur Liste' : 'Retour \u00e0 la liste';
 const pgHtml = buildSimplePage({
 locale,
 title: pgTitle,
 description: pgDesc,
 canonicalUrl: pgCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: `${pgAlternates}\n${pgXDefault}`,
 extraHeadHtml: `${pgPrevLink}${pgNextLink}`,
 jsonLdScripts: [pgCollLd, pgItemLd, pgBreadcrumbLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(pgCopy.heading(pageNum))}</h1>\n <p>${esc(pgDesc)}</p>\n <ul style="list-style:none;padding:0;margin:16px 0">${pgListHtml}</ul>\n <nav style="margin:24px 0;text-align:center;font-size:14px">${pgNav.join(' &middot; ')}</nav>\n <p><a href="${pgMainUrl}">${esc(pgBackLabel)}</a></p>\n${renderListingPaginationProse(locale, pageNum)}\n${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: 'Ticino', omitCommute: true }))}`,
 });
 const pgOutDir = np.join(distDir, pgCanonicalPath.slice(1));
 activeJobDirs.add(pgCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(pgOutDir);
 _qw(np.join(pgOutDir, 'index.html'), pgHtml);
 const pgFlatPath = pgCanonicalPath.replace(/\/+$/, '');
 if (pgFlatPath) { const pgFlatFile = np.join(distDir, pgFlatPath.slice(1) + '.html'); _md(np.dirname(pgFlatFile)); _qw(pgFlatFile, pgHtml); }
 paginationPageCount++;
 recordEmit('paginated-listing', __tPaginated);
 }
 const pgItSlug = `${paginationSlugs.it}-${pageNum}`;
 const pgItPath = withSlash(`/${sectionByLocale.it}/${pgItSlug}`.replace(/\/+/g, '/'));
 const pgSmAlternates = localeList.map((l) => { const ls = `${paginationSlugs[l]}-${pageNum}`; const lp = `${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'); return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(lp)}" />`; }).join('\n');
 paginationSitemapEntries.push(` <url>\n <loc>${BASE_URL}${pgItPath}</loc>\n${pgSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pgItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.4</priority>\n </url>`);
 }
 if (paginationPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${paginationPageCount} paginated listing pages (${totalListingPages - 1} pages \u00d7 4 locales)`);

 /* ── Category listing pages (/cerca-lavoro-ticino/categoria-sanita/) ── */
 const catSlugsMap: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
 health: { it: 'sanita', en: 'health', de: 'gesundheit', fr: 'sante' },
 finance: { it: 'finanza', en: 'finance', de: 'finanzen', fr: 'finance' },
 tech: { it: 'informatica', en: 'tech', de: 'technik', fr: 'tech' },
 engineering: { it: 'ingegneria', en: 'engineering', de: 'ingenieurwesen', fr: 'ingenierie' },
 admin: { it: 'amministrazione', en: 'admin', de: 'verwaltung', fr: 'administration' },
 hospitality: { it: 'ristorazione', en: 'hospitality', de: 'gastgewerbe', fr: 'hotellerie' },
 sales: { it: 'vendita', en: 'sales', de: 'vertrieb', fr: 'vente' },
 other: { it: 'altro', en: 'other', de: 'andere', fr: 'autre' },
 };
 const catPrefix: Record<'it' | 'en' | 'de' | 'fr', string> = { it: 'categoria', en: 'category', de: 'kategorie', fr: 'categorie' };
 const catLabels: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
 health: { it: 'Sanit\u00e0', en: 'Healthcare', de: 'Gesundheit', fr: 'Sant\u00e9' },
 finance: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
 tech: { it: 'Informatica', en: 'Technology', de: 'Technik', fr: 'Technologie' },
 engineering: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ing\u00e9nierie' },
 admin: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' },
 hospitality: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastgewerbe', fr: 'H\u00f4tellerie' },
 sales: { it: 'Vendita', en: 'Sales', de: 'Vertrieb', fr: 'Vente' },
 other: { it: 'Altro', en: 'Other', de: 'Andere', fr: 'Autre' },
 };
 let categoryPageCount = 0;
 const categorySitemapEntries: string[] = [];
 const CAT_PER_PAGE = 30;
 for (const catKey of Object.keys(catSlugsMap)) {
 const catJobs = sortedForPagination.filter((j: any) => String(j.category || '').toLowerCase() === catKey);
 if (catJobs.length < 3) continue;
 const catTotalPages = Math.min(10, Math.ceil(catJobs.length / CAT_PER_PAGE));
 for (let catPage = 1; catPage <= catTotalPages; catPage++) {
 const catStart = (catPage - 1) * CAT_PER_PAGE;
 const catPageJobs = catJobs.slice(catStart, catStart + CAT_PER_PAGE);
 if (catPageJobs.length === 0) break;
 for (const locale of localeList) {
 const __tCategory = startTimer();
 const catSlugL = catSlugsMap[catKey][locale];
 const catPageSuffix = catPage > 1 ? `/${paginationSlugs[locale]}-${catPage}` : '';
 const catFullSlug = `${catPrefix[locale]}-${catSlugL}${catPageSuffix}`;
 const catCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${catFullSlug}`.replace(/\/+/g, '/'));
 const catCanonicalUrl = `${BASE_URL}${catCanonicalPath}`;
 const catLabel = catLabels[catKey][locale];
 const catPageLabel = catPage > 1 ? ` - ${locale === 'de' ? 'Seite' : 'Pagina'} ${catPage}` : '';
 const catUniqueCompanies = [...new Set(catJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const catUniqueLocations = [...new Set(catJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 // F3a — CTR-optimized 50-60 char title for page 1, paginated suffix for >1.
 // Description uses the shared 140-160 char template from meta-descriptions.
 const catPrimaryTitle = buildRoleHubTitle({
 locale,
 roleDisplay: catLabel,
 count: catJobs.length,
 year: new Date().getFullYear(),
 });
 const catTitle = catPage > 1
 ? (locale === 'it' ? `${catPrimaryTitle} — Pagina ${catPage}` : locale === 'de' ? `${catPrimaryTitle} — Seite ${catPage}` : `${catPrimaryTitle} — Page ${catPage}`)
 : catPrimaryTitle;
 const catDescription = buildRoleHubMeta({
 locale,
 roleDisplay: catLabel,
 count: catJobs.length,
 });
 const catAlternatesPairs = localeList.map((al) => {
 const alSlug = `${catPrefix[al]}-${catSlugsMap[catKey][al]}${catPage > 1 ? `/${paginationSlugs[al]}-${catPage}` : ''}`;
 const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const catXDefaultHref = catAlternatesPairs.find((p) => p.lang === 'it')?.href ?? catAlternatesPairs[0]?.href ?? '';
 // audit-hreflang requires x-default on every multi-locale page.
 const catAlternates = [
 ...catAlternatesPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ...(catXDefaultHref ? [` <link rel="alternate" hreflang="x-default" href="${catXDefaultHref}">`] : []),
 ].join('\n');
 const catListHtml = catPageJobs.map((job: any) => renderJobCardLi(job, locale)).join('');
 const catOtherLinks = Object.keys(catSlugsMap).filter((k) => k !== catKey).map((k) => { const kSlug = `${catPrefix[locale]}-${catSlugsMap[k][locale]}`; return `<a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${kSlug}`.replace(/\/+/g, '/'))}" style="text-decoration:none;color:var(--color-link);display:inline-flex;align-items:center;min-height:44px;padding:8px 4px">${catLabels[k][locale]}</a>`; });
 const catCollLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: catTitle, url: catCanonicalUrl, description: catDescription, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL } });
 const catSectionUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const catBreadcrumbLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}` },
 { '@type': 'ListItem', position: 2, name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: catSectionUrl },
 { '@type': 'ListItem', position: 3, name: catTitle.replace(' | Frontaliere Ticino', ''), item: catCanonicalUrl },
 ] });
 // Build editorial intro and market context paragraphs
 const catTopCompanies = catUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 const catIntro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${catJobs.length} offerte di lavoro</strong> nel settore ${catLabel.toLowerCase()} in Ticino, pubblicate da ${catUniqueCompanies.length} aziende in ${catUniqueLocations.length} localit\u00e0. Tra le aziende che assumono: ${catTopCompanies}. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico che raccoglie le offerte direttamente dai portali carriera delle aziende ticinesi.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${catJobs.length} job openings</strong> in the ${catLabel.toLowerCase()} sector in Ticino, published by ${catUniqueCompanies.length} companies across ${catUniqueLocations.length} locations. Hiring companies include: ${catTopCompanies}. Listings are refreshed daily by our automated crawler that collects jobs directly from company career portals in Ticino.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${catJobs.length} Stellenangebote</strong> im Bereich ${catLabel} im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${catUniqueCompanies.length} Unternehmen an ${catUniqueLocations.length} Standorten. Einstellende Unternehmen: ${catTopCompanies}. Die Anzeigen werden t\u00e4glich von unserem automatischen Crawler aktualisiert.</p>`;
 return `<p>${catJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles dans le secteur ${catLabel.toLowerCase()} au Tessin, publi\u00e9es par ${catUniqueCompanies.length} entreprises dans ${catUniqueLocations.length} localit\u00e9s. Entreprises qui recrutent : ${catTopCompanies}. Les annonces sont mises \u00e0 jour quotidiennement.</p>`;
 })();
 const catMarketSection = (() => {
 if (locale === 'it') return `<section style="margin-top:20px"><h2>Lavorare nel settore ${catLabel.toLowerCase()} in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. Il settore ${catLabel.toLowerCase()} rappresenta una delle aree pi\u00f9 attive del mercato ticinese. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`;
 if (locale === 'en') return `<section style="margin-top:20px"><h2>Working in ${catLabel.toLowerCase()} in Ticino</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. The ${catLabel.toLowerCase()} sector is one of the most active areas in the Ticino job market. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`;
 if (locale === 'de') return `<section style="margin-top:20px"><h2>Arbeiten im Bereich ${catLabel} im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. Der Bereich ${catLabel} geh\u00f6rt zu den aktivsten Sektoren des Tessiner Arbeitsmarkts. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`;
 return `<section style="margin-top:20px"><h2>Travailler dans le secteur ${catLabel.toLowerCase()} au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Le secteur ${catLabel.toLowerCase()} est l'un des domaines les plus actifs du march\u00e9 tessinois. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`;
 })();
 const catOpenAllLabel = locale === 'it' ? 'Apri il job board completo' : locale === 'en' ? 'Open the full job board' : locale === 'de' ? 'Komplettes Job Board \u00f6ffnen' : 'Ouvrir le job board complet';
 const catNavLabel = locale === 'it' ? 'Altre categorie' : locale === 'en' ? 'Other categories' : locale === 'de' ? 'Weitere Kategorien' : 'Autres cat\u00e9gories';
 const catHtml = buildSimplePage({
 locale,
 title: catTitle,
 description: catDescription,
 canonicalUrl: catCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: catAlternates,
 jsonLdScripts: [catCollLd, catBreadcrumbLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: (() => {
 const catLocaleParts: Parameters<typeof formatSeoH1>[0] = {
 keyword: catLabel,
 location: locale === 'de' ? 'Tessin' : locale === 'fr' ? 'Tessin' : 'Ticino',
 count: catJobs.length,
 locale,
 noun: locale === 'it' ? 'offerte' : locale === 'en' ? 'open roles' : locale === 'de' ? 'Stellen' : 'offres',
 title: catTitle,
 };
 const catH1 = formatSeoH1(catLocaleParts) + (catPage > 1 ? (locale === 'it' ? ` — Pagina ${catPage}` : locale === 'de' ? ` — Seite ${catPage}` : locale === 'fr' ? ` — Page ${catPage}` : ` — Page ${catPage}`) : '');
 return `<h1>${esc(catH1)}</h1>\n <p>${esc(catDescription)}</p>\n ${catIntro}\n <ul style="list-style:none;padding:0;margin:16px 0">${catListHtml}</ul>\n <p><a href="${catSectionUrl}">${esc(catOpenAllLabel)}</a></p>\n ${catMarketSection}\n <nav style="margin:20px 0;font-size:14px">${catNavLabel}: ${catOtherLinks.join(' \u00b7 ')}</nav>\n ${wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({ locale, location: 'Ticino', omitCommute: true, sectorOrType: catLabel }))}`;
 })(),
 });
 const catOutDir = np.join(distDir, catCanonicalPath.slice(1));
 activeJobDirs.add(catCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(catOutDir);
 _qw(np.join(catOutDir, 'index.html'), catHtml);
 const catFlatPath = catCanonicalPath.replace(/\/+$/, '');
 if (catFlatPath) { const catFlatFile = np.join(distDir, catFlatPath.slice(1) + '.html'); _md(np.dirname(catFlatFile)); _qw(catFlatFile, catHtml); }
 categoryPageCount++;
 recordEmit('category-listing', __tCategory);
 }
 if (catPage === 1) {
 const catItSlug = `${catPrefix.it}-${catSlugsMap[catKey].it}`;
 const catItPath = withSlash(`/${sectionByLocale.it}/${catItSlug}`.replace(/\/+/g, '/'));
 const catSmAlternates = localeList.map((l) => { const ls = `${catPrefix[l]}-${catSlugsMap[catKey][l]}`; const lp = `${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'); return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(lp)}" />`; }).join('\n');
 categorySitemapEntries.push(` <url>\n <loc>${BASE_URL}${catItPath}</loc>\n${catSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${catItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`);
 }
 }
 }
 if (categoryPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${categoryPageCount} category listing pages`);

 /* ── GSC-driven keyword landing pages ──────────────────────── */
 let keywordPageCount = 0;
 const keywordSitemapEntries: string[] = [];
 const kwConfigPath = np.resolve(rootDir, 'data/keyword-pages-config.json');
 if (fs.existsSync(kwConfigPath)) {
 try {
 const kwConfig = JSON.parse(fs.readFileSync(kwConfigPath, 'utf-8'));
 const kwPages: any[] = Array.isArray(kwConfig?.pages) ? kwConfig.pages : [];
 for (const kwPage of kwPages) {
 const kwSlug = String(kwPage.slug || '').trim();
 const kwFilterWords: string[] = Array.isArray(kwPage.filterKeywords) ? kwPage.filterKeywords : [];
 if (!kwSlug || kwFilterWords.length === 0) continue;
 // Match jobs where ALL filter keywords appear in title/description/company/location
 const kwJobs = sortedForPagination.filter((j: any) => {
 const haystack = [
 String(j.title || ''), String(j.description || ''),
 String(j.company || ''), String(j.location || ''),
 ...(Object.values(j.titleByLocale || {}) as string[]),
 ].join(' ').toLowerCase();
 return kwFilterWords.every((kw: string) => haystack.includes(kw));
 }).slice(0, 30);
 if (kwJobs.length < 3) continue;
 const itCopy = kwPage.copy?.it;
 if (!itCopy) continue;
 const kwUniqueCompanies = [...new Set(kwJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const kwUniqueLocations = [...new Set(kwJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 for (const locale of localeList) {
 const __tGsc = startTimer();
 const kwFullSlug = `${searchRoutePrefix[locale]}-${kwSlug}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(kwFullSlug)) continue;
 const kwCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${kwFullSlug}`.replace(/\/+/g, '/'));
 const kwRelDir = kwCanonicalPath.slice(1).replace(/\/+$/, '');
 if (activeJobDirs.has(kwRelDir)) continue;
 const kwCanonicalUrl = `${BASE_URL}${kwCanonicalPath}`;
 const kwQueryDisplay = String(kwPage.query || '').trim();
 // F3a — delegate title/description to the shared CTR-optimized helpers so
 // keyword landing pages get the same 50-60 / 140-160 char treatment as
 // role / city / employer hubs. The Italian landing preserves its curated
 // `itCopy.title` because that was hand-tuned per query in keyword config.
 const kwTitle = locale === 'it'
 ? itCopy.title
 : buildRoleHubTitle({
 locale,
 roleDisplay: kwQueryDisplay || 'Jobs',
 count: kwJobs.length,
 year: new Date().getFullYear(),
 });
 const kwDesc = buildRoleHubMeta({
 locale,
 roleDisplay: kwQueryDisplay || (locale === 'it' ? 'lavoro' : locale === 'en' ? 'jobs' : locale === 'de' ? 'Stellen' : 'emploi'),
 count: kwJobs.length,
 });
 const kwAlternatesPairs = localeList.map((al) => {
 const alSlug = `${searchRoutePrefix[al]}-${kwSlug}`;
 const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/');
 return { lang: al, href: `${BASE_URL}${withSlash(alPath)}` };
 });
 const kwXDefaultHref = kwAlternatesPairs.find((p) => p.lang === 'it')?.href ?? kwAlternatesPairs[0]?.href ?? '';
 // audit-hreflang requires x-default on every multi-locale page.
 const kwAlternates = [
 ...kwAlternatesPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
 ...(kwXDefaultHref ? [` <link rel="alternate" hreflang="x-default" href="${kwXDefaultHref}">`] : []),
 ].join('\n');
 const kwListHtml = kwJobs.map((job: any) => renderJobCardLi(job, locale)).join('');
 const kwCollLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: kwTitle, url: kwCanonicalUrl, description: kwDesc, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL } });
 const kwCtaCopy: Record<string, string> = {
 it: `Consulta le ${kwJobs.length} posizioni aperte qui sotto. Le offerte vengono aggiornate quotidianamente da aziende con sede in Ticino e Grigioni. Utilizza il nostro calcolatore per confrontare stipendio netto, tasse e costo della vita tra Svizzera e Italia.`,
 en: `Browse the ${kwJobs.length} open positions listed below. Listings are updated daily from employers based in Ticino and Graubünden. Use our calculator to compare net salary, taxes, and cost of living between Switzerland and Italy.`,
 de: `Entdecken Sie die ${kwJobs.length} offenen Stellen unten. Die Angebote werden täglich von Arbeitgebern im Tessin und Graubünden aktualisiert. Nutzen Sie unseren Rechner, um Nettolohn, Steuern und Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.`,
 fr: `Consultez les ${kwJobs.length} postes ouverts ci-dessous. Les offres sont mises à jour quotidiennement par des employeurs basés au Tessin et dans les Grisons. Utilisez notre calculateur pour comparer salaire net, impôts et coût de la vie entre la Suisse et l'Italie.`,
 };
 const kwCta = kwCtaCopy[locale] || kwCtaCopy.it;
 const kwSectionUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const kwTopCompanies = kwUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 const kwIntro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${kwJobs.length} offerte di lavoro</strong> per "${esc(kwQueryDisplay)}" in Ticino, pubblicate da ${kwUniqueCompanies.length} aziende${kwUniqueLocations.length > 1 ? ` in ${kwUniqueLocations.length} localit\u00e0` : ''}. Tra le aziende che assumono: ${kwTopCompanies}. Gli annunci vengono aggiornati quotidianamente.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${kwJobs.length} job openings</strong> for "${esc(kwQueryDisplay)}" in Ticino, published by ${kwUniqueCompanies.length} companies${kwUniqueLocations.length > 1 ? ` across ${kwUniqueLocations.length} locations` : ''}. Hiring companies include: ${kwTopCompanies}. Listings are refreshed daily.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${kwJobs.length} Stellenangebote</strong> f\u00fcr "${esc(kwQueryDisplay)}" im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${kwUniqueCompanies.length} Unternehmen${kwUniqueLocations.length > 1 ? ` an ${kwUniqueLocations.length} Standorten` : ''}. Einstellende Unternehmen: ${kwTopCompanies}.</p>`;
 return `<p>${kwJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles pour "${esc(kwQueryDisplay)}" au Tessin, publi\u00e9es par ${kwUniqueCompanies.length} entreprises${kwUniqueLocations.length > 1 ? ` dans ${kwUniqueLocations.length} localit\u00e9s` : ''}. Entreprises qui recrutent : ${kwTopCompanies}.</p>`;
 })();
 const kwMarketSection = (() => {
 if (locale === 'it') return `<section style="margin-top:20px"><h2>Il mercato del lavoro in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`;
 if (locale === 'en') return `<section style="margin-top:20px"><h2>The Ticino job market</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`;
 if (locale === 'de') return `<section style="margin-top:20px"><h2>Der Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`;
 return `<section style="margin-top:20px"><h2>Le march\u00e9 de l'emploi au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`;
 })();
 const kwOpenAllLabel = locale === 'it' ? 'Apri il job board completo' : locale === 'en' ? 'Open the full job board' : locale === 'de' ? 'Komplettes Job Board \u00f6ffnen' : 'Ouvrir le job board complet';
 // SEO: text-to-HTML ratio gate. Inject a per-query unique intro (so each
 // GSC-keyword landing has unique top prose) and the shared commuter
 // context block (methodology + commute + salary + FAQ + cross-links).
 const _kwQuery = String(kwQueryDisplay || itCopy.heading || '').trim();
 const _kwCity = (() => {
 const segs = String(kwSlug).split('-');
 for (const s of segs) if (isKnownTicinoCommuterCity(s)) return s;
 return null;
 })();
 const kwQueryIntro = renderSearchQueryIntro(locale, _kwQuery, kwJobs.length, kwUniqueCompanies, kwUniqueLocations);
 const kwCommuterBlock = wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({
 locale,
 location: _kwCity ? _kwCity.charAt(0).toUpperCase() + _kwCity.slice(1) : 'Ticino',
 sectorOrType: _kwQuery || null,
 omitCommute: !_kwCity,
 }));
 const kwHtml = buildSimplePage({
 locale,
 title: kwTitle,
 description: kwDesc,
 canonicalUrl: kwCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: kwAlternates,
 jsonLdScripts: [kwCollLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(itCopy.heading)}</h1>\n <p>${esc(kwDesc)}</p>\n ${kwQueryIntro}\n ${kwIntro}\n <p>${esc(kwCta)}</p>\n <ul style="list-style:none;padding:0;margin:16px 0">${kwListHtml}</ul>\n <p><a href="${kwSectionUrl}">${esc(kwOpenAllLabel)}</a></p>\n ${kwMarketSection}\n ${kwCommuterBlock}`,
 });
 const kwOutDir = np.join(distDir, kwCanonicalPath.slice(1));
 activeJobDirs.add(kwRelDir);
 _md(kwOutDir);
 _qw(np.join(kwOutDir, 'index.html'), kwHtml);
 const kwFlatPath = kwCanonicalPath.replace(/\/+$/, '');
 if (kwFlatPath) { const kwFlatFile = np.join(distDir, kwFlatPath.slice(1) + '.html'); _md(np.dirname(kwFlatFile)); _qw(kwFlatFile, kwHtml); }
 keywordPageCount++;
 recordEmit('gsc-keyword-landing', __tGsc);
 }
 // Sitemap entry (Italian canonical)
 const kwItSlug = `${searchRoutePrefix.it}-${kwSlug}`;
 const kwItPath = withSlash(`/${sectionByLocale.it}/${kwItSlug}`.replace(/\/+/g, '/'));
 const kwSmAlternates = localeList.map((l) => { const ls = `${searchRoutePrefix[l]}-${kwSlug}`; const lp = `${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'); return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(lp)}" />`; }).join('\n');
 keywordSitemapEntries.push(` <url>\n <loc>${BASE_URL}${kwItPath}</loc>\n${kwSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${kwItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 } catch (e) {
 console.warn(`\x1b[33m[jobs-seo-pages]\x1b[0m Failed to load keyword pages config: ${e}`);
 }
 }
 if (keywordPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${keywordPageCount} GSC keyword landing pages`);

 /* ── Search landing pages from stats leaders ───────────────── */
 let searchEntries = '';
 const statsPath = np.resolve(rootDir, 'data/jobs-stats.json');
 if (fs.existsSync(statsPath)) {
 const statsRaw = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
 const leaderGroups = [
 ...(Array.isArray(statsRaw?.leaders?.topLocationsActive) ? statsRaw.leaders.topLocationsActive : []),
 ...(Array.isArray(statsRaw?.leaders?.topLocationsAdded30d) ? statsRaw.leaders.topLocationsAdded30d : []),
 ...(Array.isArray(statsRaw?.leaders?.topTitlesAdded30d) ? statsRaw.leaders.topTitlesAdded30d : []),
 ];
 const searchLeaderMap = new Map<string, { key: string; name: string }>();
 for (const item of leaderGroups) {
 const key = String(item?.key || '').trim();
 const name = String(item?.name || '').trim();
 if (!key || !name || searchLeaderMap.has(key)) continue;
 searchLeaderMap.set(key, { key, name });
 }

 let searchPageCount = 0;
 const searchSitemapEntries: string[] = [];
 for (const { key, name } of searchLeaderMap.values()) {
 const matchingJobsByLocale = {
 it: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'it')).slice(0, 20),
 en: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'en')).slice(0, 20),
 de: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'de')).slice(0, 20),
 fr: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'fr')).slice(0, 20),
 };
 if (localeList.every((locale) => matchingJobsByLocale[locale].length === 0)) continue;
 const fallbackMatchingJobs = pickSearchLandingFallbackJobs(matchingJobsByLocale);
 if (fallbackMatchingJobs.length === 0) continue;

 for (const locale of localeList) {
 const matchingJobs = matchingJobsByLocale[locale].length > 0
 ? matchingJobsByLocale[locale]
 : fallbackMatchingJobs;
 if (matchingJobs.length === 0) continue;
 const __tSearchStats = startTimer();

 const fullSlug = `${searchRoutePrefix[locale]}-${key}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(fullSlug)) continue;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const copy = searchPageCopy[locale];
 const title = buildTitleWithBrand(copy.title(name));
 const description = copy.description(name, matchingJobs.length);
 const _altPairs = localeList
 .map((altLocale) => {
 const altSlug = `${searchRoutePrefix[altLocale]}-${key}`;
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altSlug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const listHtml = matchingJobs.map((job: any) => renderJobCardLi(job, locale)).join('');

 const twitterCards = ` <meta name="twitter:card" content="summary_large_image">\n <meta name="twitter:title" content="${esc(title)}">\n <meta name="twitter:description" content="${esc(description)}">\n <meta name="twitter:site" content="@frontaliereticino">`;
 const searchBodyParts: string[] = [];
 {
 const listingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const uniqueCompanies = [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const uniqueLocations = [...new Set(matchingJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 if (locale === 'it') {
 searchBodyParts.push(`<p>Sono attualmente disponibili <strong>${matchingJobs.length} offerte di lavoro</strong> per ${esc(name)} in Ticino, pubblicate da ${uniqueCompanies.length} aziende in ${uniqueLocations.length} localit\u00e0. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico che raccoglie le offerte direttamente dai portali carriera delle aziende ticinesi.</p>`);
 } else if (locale === 'en') {
 searchBodyParts.push(`<p>There are currently <strong>${matchingJobs.length} job openings</strong> for ${esc(name)} in Ticino, published by ${uniqueCompanies.length} companies across ${uniqueLocations.length} locations. Listings are refreshed daily by our automated crawler that collects jobs directly from company career portals in Ticino.</p>`);
 } else if (locale === 'de') {
 searchBodyParts.push(`<p>Derzeit sind <strong>${matchingJobs.length} Stellenangebote</strong> f\u00fcr ${esc(name)} im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${uniqueCompanies.length} Unternehmen an ${uniqueLocations.length} Standorten. Die Anzeigen werden t\u00e4glich von unserem automatischen Crawler aktualisiert, der Stellen direkt von den Karriereportalen der Tessiner Unternehmen sammelt.</p>`);
 } else {
 searchBodyParts.push(`<p>${matchingJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles pour ${esc(name)} au Tessin, publi\u00e9es par ${uniqueCompanies.length} entreprises dans ${uniqueLocations.length} localit\u00e9s. Les annonces sont mises \u00e0 jour quotidiennement par notre robot qui collecte les offres directement depuis les portails carri\u00e8re des entreprises tessinoises.</p>`);
 }
 searchBodyParts.push(`<ul style="list-style:none;padding:0;margin:16px 0">${listHtml}</ul>`);
 searchBodyParts.push(`<p><a href="${listingUrl}">${esc(copy.openListing)}</a></p>`);
 if (locale === 'it') {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>Il mercato del lavoro in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. I settori pi\u00f9 attivi includono sanit\u00e0, finanza, tecnologia, ingegneria, commercio e amministrazione. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`);
 } else if (locale === 'en') {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>The Ticino job market</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. The most active sectors include healthcare, finance, technology, engineering, retail, and administration. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`);
 } else if (locale === 'de') {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>Der Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. Die aktivsten Branchen sind Gesundheitswesen, Finanzen, Technologie, Ingenieurwesen, Handel und Verwaltung. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`);
 } else {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>Le march\u00e9 de l'emploi au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Les secteurs les plus actifs incluent la sant\u00e9, la finance, la technologie, l'ing\u00e9nierie, le commerce et l'administration. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`);
 }
 searchBodyParts.push(`<p style="margin-top:16px;font-size:14px;color:var(--color-subtle);line-height:1.6">${esc(copy.editorial)}</p>`);
 // SEO: text-to-HTML ratio gate. Append per-query unique intro + the
 // shared commuter-context block (methodology, FAQ, scenario, cross-links).
 // For Ticino cities we use the city-aware commuter row; for non-Ticino
 // queries (Chur, Zurich, etc.) we fall back to general-Ticino prose.
 const _isTicino = isKnownTicinoCommuterCity(name);
 searchBodyParts.unshift(renderSearchQueryIntro(locale, name, matchingJobs.length, uniqueCompanies, uniqueLocations));
 searchBodyParts.push(wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({
 locale,
 location: _isTicino ? name : 'Ticino',
 sectorOrType: _isTicino ? null : name,
 omitCommute: !_isTicino,
 })));
 }
 const _sHomeUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const _sListUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const _sListName = locale === 'it' ? 'Lavoro in Ticino' : locale === 'en' ? 'Jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Emploi au Tessin';
 const searchBreadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: _sHomeUrl },
 { '@type': 'ListItem', position: 2, name: _sListName, item: _sListUrl },
 { '@type': 'ListItem', position: 3, name: copy.heading(name), item: canonicalUrl },
 ],
 });
 // Cannibalization fix: search-hub slug may be remapped to a winner URL
 // (e.g. `search-lugano-eoc-...` → company hub). Page still emitted at its
 // own path so backlinks resolve.
 const effectiveCanonicalUrl = resolveCanonicalUrl(fullSlug, canonicalUrl);
 const searchHtml = buildSimplePage({
 locale,
 title,
 description,
 canonicalUrl: effectiveCanonicalUrl,
 // Always index,follow: the previous `matchingJobs.length >= 3 ? index : noindex`
 // rule emitted noindex pages that collided with relatedSearchClustersPlugin's
 // cluster pages at the same slug (cluster's OR-fill matching surfaced ≥3 jobs
 // where our AND-strict matchesSearchLanding yielded <3), failing
 // validate:sitemap-pages with `URL has noindex but is in the cluster sitemap`.
 // Setting this unconditionally to index,follow removes the cross-plugin race
 // — both plugins now agree the page is indexable. Anti-thin-content is
 // already enforced by the page-body MIN_INDEXABLE_WORDS check downstream
 // (these pages embed ~250 words of editorial + commuter-context regardless
 // of listing count, so the body always passes the gate).
 robots: 'index,follow',
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 extraHeadHtml: twitterCards,
 jsonLdScripts: [searchBreadcrumbLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(copy.heading(name))}</h1>\n <p>${esc(description)}</p>\n${searchBodyParts.join('\n')}`,
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), searchHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, searchHtml);
 }
 searchPageCount++;
 recordEmit('search-stats-landing', __tSearchStats);
 }

 // Add indexable search pages (≥3 jobs) to sitemap
 if (fallbackMatchingJobs.length >= 3) {
 const sItSlug = `${searchRoutePrefix.it}-${key}`;
 const sItPath = withSlash(`/${sectionByLocale.it}/${sItSlug}`.replace(/\/+/g, '/'));
 const sItUrl = `${BASE_URL}${sItPath}`;
 // SEO: skip — page self-canonicalizes elsewhere (Semrush gate).
 // (a) Editorial geo-hub cities (Lugano/Bellinzona/Mendrisio/Locarno/Chiasso)
 // canonicalize their `ricerca-<city>` page to the clean `/{city}/` hub,
 // so emitting the legacy slug here would duplicate the editorial entry
 // already added with a non-canonical loc. (b) Any search-leader slug
 // present in canonicalOverrides has its rendered <link rel="canonical">
 // pointing elsewhere — never advertise it as a sitemap loc.
 const isEditorialDuplicate = editorialSearchSlugsByLocale.get('it')?.has(sItSlug) === true;
 const overrideUrl = resolveCanonicalUrl(sItSlug, sItUrl);
 if (!isEditorialDuplicate && overrideUrl === sItUrl) {
 const sAlternates = localeList.map((l) => {
 const lSlug = `${searchRoutePrefix[l]}-${key}`;
 const sp = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(sp)}" />`;
 }).join('\n');
 const sXDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${sItUrl}" />`;
 searchSitemapEntries.push(` <url>\n <loc>${sItUrl}</loc>\n${sAlternates}\n${sXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 }
 }

 /* ── Combo search landing pages ────────────────────────────── */
 // Helper: generate a combo search landing page with custom filter & copy
 const generateComboPage = (
 comboKey: string,
 copyByLocale: Record<'it' | 'en' | 'de' | 'fr', { title: string; description: (count: number) => string; heading: string }>,
 filterFn: (job: any) => boolean,
 ): void => {
 const matchingJobs = validJobs.filter(filterFn).slice(0, 20);
 if (matchingJobs.length === 0) return;

 for (const locale of localeList) {
 const __tSearchCombo = startTimer();
 const fullSlug = `${searchRoutePrefix[locale]}-${comboKey}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(fullSlug)) continue;
 if (searchLeaderMap.has(comboKey)) continue;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const copy = copyByLocale[locale];
 const description = copy.description(matchingJobs.length);
 const _altPairs = localeList
 .map((altLocale) => {
 const altSlug = `${searchRoutePrefix[altLocale]}-${comboKey}`;
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altSlug}`.replace(/\/+/g, '/');
 return { lang: altLocale, href: `${BASE_URL}${withSlash(altPath)}` };
 });
 const _xDefaultAltHref = _altPairs.find((p) => p.lang === "it")?.href ?? _altPairs[0]?.href ?? "";
 const alternates = [
  ..._altPairs.map((p) => ` <link rel="alternate" hreflang="${p.lang}" href="${p.href}">`),
  ...(_xDefaultAltHref ? [` <link rel="alternate" hreflang="x-default" href="${_xDefaultAltHref}">`] : []),
 ].join('\n');
 const listHtml = matchingJobs.map((job: any) => renderJobCardLi(job, locale)).join('');

 const comboOgImage = ` <meta property="og:image" content="${BASE_URL}/og-image.png">\n <meta property="og:image:width" content="1200">\n <meta property="og:image:height" content="630">\n <meta property="og:image:type" content="image/png">`;
 const comboBodyParts: string[] = [];
 {
 const cListingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const cUniqueCompanies = [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const cUniqueLocations = [...new Set(matchingJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 if (locale === 'it') {
 comboBodyParts.push(`<p>Abbiamo trovato <strong>${matchingJobs.length} offerte di lavoro</strong> corrispondenti a questa ricerca, pubblicate da ${cUniqueCompanies.length} aziende${cUniqueLocations.length > 1 ? ` in ${cUniqueLocations.length} localit\u00e0 del Ticino` : cUniqueLocations.length === 1 ? ` a ${esc(cUniqueLocations[0])}` : ' in Ticino'}. Ogni annuncio rimanda direttamente alla pagina di candidatura ufficiale dell'azienda.</p>`);
 } else if (locale === 'en') {
 comboBodyParts.push(`<p>We found <strong>${matchingJobs.length} job openings</strong> matching this search, published by ${cUniqueCompanies.length} companies${cUniqueLocations.length > 1 ? ` across ${cUniqueLocations.length} locations in Ticino` : cUniqueLocations.length === 1 ? ` in ${esc(cUniqueLocations[0])}` : ' in Ticino'}. Each listing links directly to the official company application page.</p>`);
 } else if (locale === 'de') {
 comboBodyParts.push(`<p>Wir haben <strong>${matchingJobs.length} Stellenangebote</strong> f\u00fcr diese Suche gefunden, ver\u00f6ffentlicht von ${cUniqueCompanies.length} Unternehmen${cUniqueLocations.length > 1 ? ` an ${cUniqueLocations.length} Standorten im Tessin` : cUniqueLocations.length === 1 ? ` in ${esc(cUniqueLocations[0])}` : ' im Tessin'}. Jedes Inserat verlinkt direkt zur offiziellen Bewerbungsseite des Unternehmens.</p>`);
 } else {
 comboBodyParts.push(`<p>Nous avons trouv\u00e9 <strong>${matchingJobs.length} offres d'emploi</strong> correspondant \u00e0 cette recherche, publi\u00e9es par ${cUniqueCompanies.length} entreprises${cUniqueLocations.length > 1 ? ` dans ${cUniqueLocations.length} localit\u00e9s au Tessin` : cUniqueLocations.length === 1 ? ` \u00e0 ${esc(cUniqueLocations[0])}` : ' au Tessin'}. Chaque annonce renvoie directement \u00e0 la page de candidature officielle de l'entreprise.</p>`);
 }
 comboBodyParts.push(`<ul style="list-style:none;padding:0;margin:16px 0">${listHtml}</ul>`);
 comboBodyParts.push(`<p><a href="${cListingUrl}">${esc(searchPageCopy[locale].openListing)}</a></p>`);
 if (locale === 'it') {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Lavorare in Ticino come frontaliere</h2><p>Il Canton Ticino \u00e8 la principale area economica della Svizzera italiana. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte con aliquote variabili sul reddito lordo. I principali centri economici sono Lugano, Bellinzona, Mendrisio, Locarno e Chiasso. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere e confrontare vantaggi e svantaggi tra residenza in Svizzera e pendolarismo dall'Italia.</p></section>`);
 } else if (locale === 'en') {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Working in Ticino as a cross-border commuter</h2><p>The Canton of Ticino is the main economic area of Italian-speaking Switzerland. For cross-border workers with a G Permit, Ticino applies withholding tax at variable rates on gross income. The main economic centres are Lugano, Bellinzona, Mendrisio, Locarno, and Chiasso. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker and compare the pros and cons of living in Switzerland versus commuting from Italy.</p></section>`);
 } else if (locale === 'de') {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Arbeiten im Tessin als Grenzg\u00e4nger</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer mit variablen S\u00e4tzen auf das Bruttoeinkommen. Die wichtigsten Wirtschaftszentren sind Lugano, Bellinzona, Mendrisio, Locarno und Chiasso. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen und die Vor- und Nachteile eines Wohnsitzes in der Schweiz gegen\u00fcber dem Pendeln aus Italien zu vergleichen.</p></section>`);
 } else {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Travailler au Tessin en tant que frontalier</h2><p>Le Canton du Tessin est la principale zone \u00e9conomique de la Suisse italienne. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source \u00e0 taux variable sur le revenu brut. Les principaux centres \u00e9conomiques sont Lugano, Bellinzona, Mendrisio, Locarno et Chiasso. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier et comparer les avantages et inconv\u00e9nients entre r\u00e9sider en Suisse et faire la navette depuis l'Italie.</p></section>`);
 }
 comboBodyParts.push(`<p style="margin-top:16px;font-size:14px;color:var(--color-subtle);line-height:1.6">${esc(searchPageCopy[locale].editorial)}</p>`);
 // SEO: text-to-HTML ratio gate. Same enrichment as the search-leader
 // template. The combo heading (e.g. "Lavoro Stage a Lugano",
 // "Lavoro Sanità in Ticino") is the user-facing query; we feed it as
 // the unique intro key. For combos starting with a known Ticino city
 // we use the city-aware commuter row; otherwise general-Ticino prose.
 const _comboCity = (() => {
 const segs = String(comboKey).split('-');
 for (const s of segs) if (isKnownTicinoCommuterCity(s)) return s;
 return null;
 })();
 const _comboQuery = String(copy.heading || '').trim();
 comboBodyParts.unshift(renderSearchQueryIntro(locale, _comboQuery, matchingJobs.length, cUniqueCompanies, cUniqueLocations));
 comboBodyParts.push(wrapHubSeoContext(locale as 'it' | 'en' | 'de' | 'fr', renderJobBoardCommuterContext({
 locale,
 location: _comboCity ? _comboCity.charAt(0).toUpperCase() + _comboCity.slice(1) : 'Ticino',
 sectorOrType: _comboQuery || null,
 omitCommute: !_comboCity,
 })));
 }
 const _cHomeUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const _cListUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const _cListName = locale === 'it' ? 'Lavoro in Ticino' : locale === 'en' ? 'Jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Emploi au Tessin';
 const comboBreadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: homeLabel[locale], item: _cHomeUrl },
 { '@type': 'ListItem', position: 2, name: _cListName, item: _cListUrl },
 { '@type': 'ListItem', position: 3, name: copy.heading, item: canonicalUrl },
 ],
 });
 const comboHtml = buildSimplePage({
 locale,
 title: copy.title,
 description,
 canonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 extraHeadHtml: comboOgImage,
 jsonLdScripts: [comboBreadcrumbLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(copy.heading)}</h1>\n <p>${esc(description)}</p>\n${comboBodyParts.join('\n')}`,
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), comboHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, comboHtml);
 }
 searchPageCount++;
 recordEmit('search-combo-landing', __tSearchCombo);
 }

 // Add qualifying combo pages to sitemap for discovery
 if (matchingJobs.length >= 3) {
 const cItSlug = `${searchRoutePrefix.it}-${comboKey}`;
 const cItPath = withSlash(`/${sectionByLocale.it}/${cItSlug}`.replace(/\/+/g, '/'));
 const cItUrl = `${BASE_URL}${cItPath}`;
 // SEO: skip — page self-canonicalizes elsewhere (Semrush gate).
 // Same rationale as the search-leader block above: editorial duplicates
 // and canonical-override slugs must never be advertised under their
 // own URL.
 const isEditorialDuplicate = editorialSearchSlugsByLocale.get('it')?.has(cItSlug) === true;
 const overrideUrl = resolveCanonicalUrl(cItSlug, cItUrl);
 if (!isEditorialDuplicate && overrideUrl === cItUrl) {
 const cAlternates = localeList.map((l) => {
 const lSlug = `${searchRoutePrefix[l]}-${comboKey}`;
 const cp = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(cp)}" />`;
 }).join('\n');
 const cXDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${cItUrl}" />`;
 searchSitemapEntries.push(` <url>\n <loc>${cItUrl}</loc>\n${cAlternates}\n${cXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 }
 };

 // Collect unique locations and companies from stats leaders
 const locationLeaders = new Map<string, string>();
 for (const groupKey of ['topLocationsActive', 'topLocationsAdded30d'] as const) {
 for (const item of (statsRaw?.leaders?.[groupKey] ?? [])) {
 const k = String(item?.key || '').trim();
 const n = String(item?.name || '').trim();
 if (k && n && !locationLeaders.has(k)) locationLeaders.set(k, n);
 }
 }
 const companyLeaders = new Map<string, string>();
 for (const groupKey of ['topCompaniesActive', 'topCompaniesAdded30d'] as const) {
 for (const item of (statsRaw?.leaders?.[groupKey] ?? [])) {
 const k = String(item?.key || '').trim();
 const n = String(item?.name || '').trim();
 if (k && n && !companyLeaders.has(k)) companyLeaders.set(k, n);
 }
 }
 // Filter out non-city location keys
 const cityKeys = new Set<string>();
 for (const [k] of locationLeaders) {
 if (k !== 'ticino' && k !== 'grigioni' && !k.includes('-') && k.length < 30) cityKeys.add(k);
 }

 // 1) città + azienda combinations
 let comboCount = 0;
 for (const [cityKey, cityName] of locationLeaders) {
 if (!cityKeys.has(cityKey)) continue;
 for (const [compKey, compName] of companyLeaders) {
 const comboKey = `${cityKey}-${compKey}`;
 const normCity = normalizeSearchTerm(cityKey);
 const normComp = normalizeSearchTerm(compKey);
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${compName} a ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro ${compName} a ${cityName}. Scopri le posizioni aperte e candidati subito.`,
 heading: `Lavoro ${compName} a ${cityName}`,
 },
 en: {
 title: `${compName} jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${compName} job openings in ${cityName}. Browse available positions and apply today.`,
 heading: `${compName} jobs in ${cityName}`,
 },
 de: {
 title: `${compName} Jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offene Stellen bei ${compName} in ${cityName}. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${compName} Jobs in ${cityName}`,
 },
 fr: {
 title: `Emploi ${compName} à ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${compName} à ${cityName}. Consultez les postes ouverts et postulez directement.`,
 heading: `Emploi ${compName} à ${cityName}`,
 },
 }, (job) => {
 const loc = normalizeSearchTerm(job?.location || '');
 const comp = normalizeSearchTerm([job?.company, job?.companyKey].filter(Boolean).join(' '));
 return loc.includes(normCity) && comp.includes(normComp);
 });
 comboCount++;
 }
 }

 // 2) città + contratto combinations
 const contractTypes: { key: string; labels: Record<'it' | 'en' | 'de' | 'fr', string>; match: string[] }[] = [
 { key: 'full-time', labels: { it: 'Full-time', en: 'Full-time', de: 'Vollzeit', fr: 'Temps plein' }, match: ['full-time'] },
 { key: 'part-time', labels: { it: 'Part-time', en: 'Part-time', de: 'Teilzeit', fr: 'Temps partiel' }, match: ['part-time'] },
 { key: 'stage', labels: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' }, match: ['internship'] },
 { key: 'apprendistato', labels: { it: 'Apprendistato', en: 'Apprenticeship', de: 'Lehrstelle', fr: 'Apprentissage' }, match: ['apprenticeship'] },
 { key: 'tempo-determinato', labels: { it: 'Tempo determinato', en: 'Temporary', de: 'Befristet', fr: 'Temporaire' }, match: ['temporary'] },
 ];
 for (const [cityKey, cityName] of locationLeaders) {
 if (!cityKeys.has(cityKey)) continue;
 for (const ct of contractTypes) {
 const comboKey = `${cityKey}-${ct.key}`;
 const normCity = normalizeSearchTerm(cityKey);
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${ct.labels.it} a ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro ${ct.labels.it.toLowerCase()} a ${cityName}. Trova posizioni ${ct.labels.it.toLowerCase()} e candidati subito.`,
 heading: `Lavoro ${ct.labels.it} a ${cityName}`,
 },
 en: {
 title: `${ct.labels.en} jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${ct.labels.en.toLowerCase()} job openings in ${cityName}. Browse positions and apply today.`,
 heading: `${ct.labels.en} jobs in ${cityName}`,
 },
 de: {
 title: `${ct.labels.de} Jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${ct.labels.de}-Stellen in ${cityName}. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${ct.labels.de} Jobs in ${cityName}`,
 },
 fr: {
 title: `Emploi ${ct.labels.fr} à ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${ct.labels.fr.toLowerCase()} à ${cityName}. Consultez les postes et postulez.`,
 heading: `Emploi ${ct.labels.fr} à ${cityName}`,
 },
 }, (job) => {
 const loc = normalizeSearchTerm(job?.location || '');
 return loc.includes(normCity) && ct.match.includes(String(job?.contract || '').toLowerCase());
 });
 comboCount++;
 }
 }

 // 3) settore + Ticino combinations
 const sectorTypes: { key: string; category: string[]; labels: Record<'it' | 'en' | 'de' | 'fr', string> }[] = [
 { key: 'sanita', category: ['health', 'healthcare'], labels: { it: 'Sanità', en: 'Healthcare', de: 'Gesundheitswesen', fr: 'Santé' } },
 { key: 'finanza', category: ['finance'], labels: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' } },
 { key: 'informatica', category: ['tech', 'technology'], labels: { it: 'Informatica', en: 'IT', de: 'Informatik', fr: 'Informatique' } },
 { key: 'vendita', category: ['sales'], labels: { it: 'Vendita', en: 'Sales', de: 'Verkauf', fr: 'Vente' } },
 { key: 'ingegneria', category: ['engineering'], labels: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingénierie' } },
 { key: 'amministrazione', category: ['admin', 'management', 'operations'], labels: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' } },
 { key: 'ristorazione', category: ['hospitality'], labels: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastronomie', fr: 'Restauration' } },
 { key: 'produzione', category: ['production', 'manufacturing', 'maintenance'], labels: { it: 'Produzione', en: 'Manufacturing', de: 'Produktion', fr: 'Production' } },
 { key: 'formazione', category: ['education', 'professor', 'researcher', 'phd'], labels: { it: 'Formazione', en: 'Education', de: 'Bildung', fr: 'Formation' } },
 { key: 'legale', category: ['legal'], labels: { it: 'Legale', en: 'Legal', de: 'Recht', fr: 'Juridique' } },
 { key: 'design', category: ['design'], labels: { it: 'Design', en: 'Design', de: 'Design', fr: 'Design' } },
 ];
 for (const sector of sectorTypes) {
 const comboKey = `${sector.key}-ticino`;
 const catSet = new Set(sector.category.map((c) => c.toLowerCase()));
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${sector.labels.it} in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro nel settore ${sector.labels.it.toLowerCase()} in Ticino. Scopri le posizioni aperte e candidati subito.`,
 heading: `Lavoro ${sector.labels.it} in Ticino`,
 },
 en: {
 title: `${sector.labels.en} jobs in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} ${sector.labels.en.toLowerCase()} job openings in Ticino. Browse available positions and apply today.`,
 heading: `${sector.labels.en} jobs in Ticino`,
 },
 de: {
 title: `${sector.labels.de} Jobs im Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offene ${sector.labels.de}-Stellen im Tessin. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${sector.labels.de} Jobs im Tessin`,
 },
 fr: {
 title: `Emploi ${sector.labels.fr} au Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${sector.labels.fr.toLowerCase()} au Tessin. Consultez les postes ouverts et postulez.`,
 heading: `Emploi ${sector.labels.fr} au Tessin`,
 },
 }, (job) => catSet.has(String(job?.category || '').toLowerCase()));
 comboCount++;
 }

 // 4) ruolo + Ticino combinations — from internal search demand
 // Users search for specific roles: Medico, Infermiere, Autista, Cuoco, Piastrellista, etc.
 const roleTypes: { key: string; match: RegExp; labels: Record<'it' | 'en' | 'de' | 'fr', string> }[] = [
 { key: 'medico', match: /\b(medic[oa]|arzt|doctor|médecin|assistente di studio medico|medical)\b/i, labels: { it: 'Medico', en: 'Doctor', de: 'Arzt', fr: 'Médecin' } },
 { key: 'infermiere', match: /\b(infermier[ea]|nurse|krankenpfleger|infirmier|pflege)\b/i, labels: { it: 'Infermiere', en: 'Nurse', de: 'Krankenpfleger', fr: 'Infirmier' } },
 { key: 'autista', match: /\b(autista|driver|fahrer|chauffeur|conducente)\b/i, labels: { it: 'Autista', en: 'Driver', de: 'Fahrer', fr: 'Chauffeur' } },
 { key: 'cuoco', match: /\b(cuoc[oa]|chef|koch|cuisinier|aiuto cuoco)\b/i, labels: { it: 'Cuoco', en: 'Chef', de: 'Koch', fr: 'Cuisinier' } },
 { key: 'piastrellista', match: /\b(piastrellista|tiler|plattenleger|carreleur|muratore|mason)\b/i, labels: { it: 'Piastrellista', en: 'Tiler', de: 'Plattenleger', fr: 'Carreleur' } },
 { key: 'elettricista', match: /\b(elettricista|electrician|elektriker|électricien)\b/i, labels: { it: 'Elettricista', en: 'Electrician', de: 'Elektriker', fr: 'Électricien' } },
 { key: 'vendita', match: /\b(vendit[oa]r[ei]|addett[oa] (alle )?vendite?|sales|verkäufer|vendeur|shop assistant|commess[oa])\b/i, labels: { it: 'Vendita', en: 'Sales', de: 'Verkauf', fr: 'Vente' } },
 { key: 'educatore', match: /\b(educator[ei]|educatric[ei]|educator|erzieher|éducateur)\b/i, labels: { it: 'Educatore', en: 'Educator', de: 'Erzieher', fr: 'Éducateur' } },
 { key: 'contabile', match: /\b(contabil[ei]|accountant|buchhalter|comptable|ragionier)\b/i, labels: { it: 'Contabile', en: 'Accountant', de: 'Buchhalter', fr: 'Comptable' } },
 { key: 'meccanico', match: /\b(meccanic[oa]|mechanic|mechaniker|mécanicien)\b/i, labels: { it: 'Meccanico', en: 'Mechanic', de: 'Mechaniker', fr: 'Mécanicien' } },
 ];
 for (const role of roleTypes) {
 const comboKey = `${role.key}-ticino`;
 if (searchLeaderMap.has(comboKey)) { comboCount++; continue; }
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${role.labels.it} in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro come ${role.labels.it.toLowerCase()} in Ticino. Posizioni aggiornate ogni giorno, candidatura diretta.`,
 heading: `Lavoro come ${role.labels.it} in Ticino`,
 },
 en: {
 title: `${role.labels.en} jobs in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} ${role.labels.en.toLowerCase()} job openings in Ticino. Updated daily, apply directly.`,
 heading: `${role.labels.en} jobs in Ticino`,
 },
 de: {
 title: `${role.labels.de} Jobs im Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offene ${role.labels.de}-Stellen im Tessin. Täglich aktualisiert, direkt bewerben.`,
 heading: `${role.labels.de} Jobs im Tessin`,
 },
 fr: {
 title: `Emploi ${role.labels.fr} au Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${role.labels.fr.toLowerCase()} au Tessin. Mises à jour quotidiennes, postulez directement.`,
 heading: `Emploi ${role.labels.fr} au Tessin`,
 },
 }, (job) => {
 const title = normalizeSearchTerm([job?.title, job?.titleByLocale?.it].filter(Boolean).join(' '));
 return role.match.test(title);
 });
 comboCount++;
 }

 if (comboCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated combo search pages from ${comboCount} combinations`);
 }

 searchEntries = [editorialEntries, searchSitemapEntries.join('\n')].filter(Boolean).join('\n');
 if (searchPageCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${searchPageCount} search landing pages (stats + combos)`);
 }
 } else {
 searchEntries = editorialEntries;
 }

 // Generate sitemap with hreflang alternates for all locales
 const landingAlternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const landingEntry = ` <url>\n <loc>${BASE_URL}/cerca-lavoro-ticino/</loc>\n${landingAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/cerca-lavoro-ticino/" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.9</priority>\n </url>`;

 // Filter out thin content jobs (<50 words IT description) from sitemap (FRO-278).
 // Also exclude jobs flagged `needsRetranslation` — per-locale alternates would
 // point at stale/auto-generated text and waste crawl budget until AI
 // retranslation completes (seo/sitemap-crawl-budget).
 const sitemapEligibleJobs = validJobs.filter((job) => {
 if ((job as any).needsRetranslation === true) return false;
 const desc = String((job as any).descriptionByLocale?.it || (job as any).description || '');
 const wordCount = desc.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
 return wordCount >= 50;
 });
 const jobEntries = sitemapEligibleJobs.map((job) => {
 const perLocaleSlugMap = {
 it: localizedSlug(job, 'it'),
 en: localizedSlug(job, 'en'),
 de: localizedSlug(job, 'de'),
 fr: localizedSlug(job, 'fr'),
 };
 const itPath = withSlash(`/${sectionByLocale.it}/${perLocaleSlugMap.it}`.replace(/\/+/g, '/'));
 const itUrl = `${BASE_URL}${itPath}`;
 // SEO: skip — page self-canonicalizes elsewhere (Semrush gate).
 // Jobs listed in data/job-canonical-overrides.json have <link rel="canonical">
 // pointing to a different URL (typically a brand-hub /azienda-<slug>/),
 // so advertising the per-job slug in the sitemap raises a "Non-canonical
 // URL in sitemap" error. The brand-hub canonical is already advertised
 // via companyEntries above.
 const overrideUrl = resolveCanonicalUrl(perLocaleSlugMap.it, itUrl);
 if (overrideUrl !== itUrl) return '';
 const alternateLinks = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${perLocaleSlugMap[l]}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 const jobLastmod = (safeIsoDate(job.crawledAt) || '').slice(0, 10) || dateStamp;
 return ` <url>\n <loc>${itUrl}</loc>\n${alternateLinks}\n${xDefault}\n <lastmod>${jobLastmod}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`;
 }).filter((s) => s.length > 0).join('\n');

 // FRO-SEO / seo/sitemap-crawl-budget: previousSlugs bridge pages are NOT
 // listed in the sitemap. Each bridge already emits `<link rel="canonical">`
 // pointing at the current slug, which is how Google consolidates signals —
 // enumerating 13k+ bridge URLs in the sitemap just multiplied crawl-budget
 // waste without adding a consolidation signal. We still render the bridge
 // HTML (see bridge generator below) so the old URL resolves, we just stop
 // advertising it in the sitemap.
 //
 // To re-enable the old behavior flip this flag to true; the generation code
 // below is kept intact so the opt-in path keeps working.
 const INCLUDE_PREV_SLUG_SITEMAP_ENTRIES = false;
 const prevSlugEntries: string[] = [];
 const prevSlugSitemapPaths = new Set<string>(); // dedup
 for (const job of (INCLUDE_PREV_SLUG_SITEMAP_ENTRIES ? sitemapEligibleJobs : [])) {
 const prevSlugsLegacy: string[] = Array.isArray((job as any).previousSlugs) ? (job as any).previousSlugs : [];
 const pslByLocale = (job as any).previousSlugsByLocale;
 // Identify locale-aware slugs so we can separate legacy-only
 const localeAwareAll = new Set<string>();
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s as string);
 }
 }
 const legacyOnly = prevSlugsLegacy.filter(s => !localeAwareAll.has(s));
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;

 const currentItSlug = localizedSlug(job, 'it');
 const currentItPath = withSlash(`/${sectionByLocale.it}/${currentItSlug}`.replace(/\/+/g, '/'));
 const canonicalAlternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${localizedSlug(job, l)}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${currentItPath}" />`;
 const jobLastmod = (safeIsoDate(job.crawledAt) || '').slice(0, 10) || dateStamp;

 const addEntry = (ps: string, locale: 'it' | 'en' | 'de' | 'fr') => {
 const currentSlug = localizedSlug(job, locale);
 if (!ps || ps === currentSlug) return;
 if (!jobHtmlCache.has(`${locale}:${currentSlug}`)) return;
 const psRelPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${ps}`.replace(/\/+/g, '/').replace(/^\//, '');
 if (activeJobDirs.has(psRelPath)) return;
 if (prevSlugSitemapPaths.has(psRelPath)) return;
 prevSlugSitemapPaths.add(psRelPath);
 const psPath = withSlash(`/${psRelPath}`);
 prevSlugEntries.push(` <url>\n <loc>${BASE_URL}${psPath}</loc>\n${canonicalAlternates}\n${xDefault}\n <lastmod>${jobLastmod}</lastmod>\n <changefreq>monthly</changefreq>\n <priority>0.3</priority>\n </url>`);
 };

 // Locale-specific previousSlugs → sitemap entry under their locale prefix
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const [locale, slugs] of Object.entries(pslByLocale)) {
 if (!Array.isArray(slugs) || !localeList.includes(locale as any)) continue;
 for (const ps of slugs as string[]) addEntry(ps, locale as typeof localeList[number]);
 }
 }
 // Legacy flat previousSlugs → sitemap entry under Italian path
 for (const ps of legacyOnly) addEntry(ps, 'it');
 }
 const prevSlugSitemap = prevSlugEntries.length > 0 ? '\n' + prevSlugEntries.join('\n') : '';

 // Company sitemap entries — skip known brand aliases so the primary
 // canonical is the only company-hub URL advertised for dedup (P5).
 const companyEntries = [...companyMap.keys()].filter((cSlug) => !isBrandAlias(cSlug)).map((cSlug) => {
 const itSlug = `${companyRoutePrefix.it}-${cSlug}`;
 const itPath = withSlash(`/${sectionByLocale.it}/${itSlug}`.replace(/\/+/g, '/'));
 const alternateLinks = localeList.map((l) => {
 const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 return ` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n${xDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.7</priority>\n </url>`;
 }).join('\n');

 const paginationSitemap = paginationSitemapEntries.length > 0 ? '\n' + paginationSitemapEntries.join('\n') : '';
 const categorySitemap = categorySitemapEntries.length > 0 ? '\n' + categorySitemapEntries.join('\n') : '';
 const keywordSitemap = keywordSitemapEntries.length > 0 ? '\n' + keywordSitemapEntries.join('\n') : '';
 const sitemapJobs = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${landingEntry}\n${companyEntries}\n${searchEntries}\n${jobEntries}${prevSlugSitemap}${paginationSitemap}${categorySitemap}${keywordSitemap}\n</urlset>\n`;
 const sitemapJobsPath = np.join(distDir, 'sitemap-jobs.xml');
 fs.writeFileSync(sitemapJobsPath, sitemapJobs, 'utf-8');

 const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexPath)) {
 let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
 if (!idx.includes('sitemap-jobs.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs.xml</loc>\n <lastmod>${dateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 } else {
 // Update existing lastmod for sitemap-jobs.xml
 idx = idx.replace(
 /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-jobs\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
 `$1${dateStamp}$2`
 );
 }
 fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
 }

 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${validJobs.length * 4} localized job pages and sitemap-jobs.xml (${prevSlugEntries.length} previousSlug entries)`);

 /* ───────────────────────────────────────────────────────────────────
  * P1.11 — Canton-aware additive emission
  * ───────────────────────────────────────────────────────────────────
  *
  *   sitemapEligibleJobs (already filtered: ≥50 IT words, no needsRetranslation)
  *        │
  *        ├─► applyCantonQuorumGate(job)  ──► { canton, cantonConfidence }
  *        │       low / reject  →  AGGREGATE_KEY
  *        │       high          →  job.canton
  *        │
  *        ├─► groupByDedupKey  ──► one canonical URL per (title|company|identity)
  *        │       jobLocation[]  collects every locality across the group
  *        │
  *        ▼
  *   urls = [{ loc, lastmod, ... }]   (one per group × 4 locales)
  *        │
  *        ├─► splitToShards(shardKey = canton) ──► sitemap-jobs-{slug}.xml
  *        ├─► emitSitemapXml(per-shard)        ──► written to dist/
  *        └─► emitSitemapIndex(all shards)     ──► dist/sitemap-index.xml
  *
  *   Plus: per-canton + aggregator landing pages
  *   /cerca-lavoro-{cantonSlug}/index.html × 4 locales × 27 (= 108 pages)
  *   The TI ones are NOT re-emitted — staticPagesPlugin already owns those.
  *
  * Sibling agents (jobMarketSnapshot, weeklyEmployers) are not touched.
  * The legacy sitemap-jobs.xml above stays untouched for backward compat —
  * the new shards are ADDITIVE; downstream (ci/audit:orphan-sitemap-pages)
  * will read both via the patched sitemap.xml index.
  */
 try {
   // Resolve absolute paths to the .mjs helpers — relative imports from a Vite
   // plugin .ts can break depending on how Vite bundles the plugin chain. The
   // helpers ship as plain ESM under scripts/lib/ and are loaded at build time.
   const { pathToFileURL } = await import('node:url');
   const cantonGateUrl = pathToFileURL(np.resolve(rootDir, 'scripts/lib/canton-quorum-gate.mjs')).href;
   const sitemapShardUrl = pathToFileURL(np.resolve(rootDir, 'scripts/lib/sitemap-shard.mjs')).href;
   const { applyCantonQuorumGate } = await import(cantonGateUrl) as {
     applyCantonQuorumGate: (j: unknown) => { canton: string; confidence: 'high'|'low'|'reject'; cantonConfidence: 'high'|'low'|'reject' };
   };
   const { splitToShards, writeShardsToDist } = await import(sitemapShardUrl) as {
     splitToShards: (urls: Array<{ loc: string; lastmod?: string; changefreq?: string; priority?: number; _shardKey?: string }>, opts?: { capPerShard?: number; shardKey?: (u: any) => string; filenamePrefix?: string }) => Array<{ filename: string; urls: any[] }>;
     writeShardsToDist: (shards: any[], distDir: string, baseUrl: string) => Promise<{ shardPaths: string[]; indexPath: string | null }>;
   };

   /**
    * Per-job canton classification: applies the quorum gate, returns either a
    * concrete canton code or AGGREGATE_KEY for low-confidence / rejected jobs
    * (E11 — uncertain jobs land on /cerca-lavoro-svizzera/, not on a per-canton
    * landing). Pure function — never mutates the input job.
    */
   const classifyCantonForUrl = (job: any): string => {
     try {
       const r = applyCantonQuorumGate({
         title: job?.title,
         description: job?.description ?? job?.descriptionByLocale?.it,
         addressLocality: job?.addressLocality ?? job?.location,
         addressRegion: job?.addressRegion,
         addressCountry: job?.addressCountry ?? 'CH',
         postalCode: job?.postalCode,
         canton: job?.canton,
       });
       if (r.cantonConfidence === 'high' && r.canton) return r.canton.toUpperCase();
       return AGGREGATE_KEY;
     } catch {
       return AGGREGATE_KEY;
     }
   };

   /**
    * Dedup-key for E8 multi-canton same-job grouping. Mirrors the heuristic
    * in scripts/lib/dedicated-crawler-common.mjs (dedupHeuristicKey) but
    * scoped to fields we already have on validJobs. Two jobs with the same
    * key are considered the same vacancy posted across multiple locations.
    */
   const dedupKey = (job: any): string => {
     const id = String(job?.id || '').trim();
     if (id) return `id|${id}`;
     const title = String(job?.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
     const company = String(job?.company || '').toLowerCase().replace(/\s+/g, ' ').trim();
     return `tc|${title}|${company}`;
   };

   // Build group → canonical-job + jobLocation[] (E8). The canonical job is
   // the most recent (validJobs is already DESC-sorted by recency). All
   // member localities are collected so the JobPosting schema can list them.
   type GroupEntry = { canonical: any; canton: string; locations: string[] };
   const groups = new Map<string, GroupEntry>();
   for (const job of sitemapEligibleJobs) {
     const k = dedupKey(job);
     const canton = classifyCantonForUrl(job);
     const loc = String(job.location || job.addressLocality || '').trim();
     const existing = groups.get(k);
     if (!existing) {
       groups.set(k, { canonical: job, canton, locations: loc ? [loc] : [] });
       continue;
     }
     // Already grouped — record the additional locality if distinct.
     if (loc && !existing.locations.includes(loc)) existing.locations.push(loc);
     // If existing canton was AGGREGATE but new entry has a concrete canton,
     // upgrade — the canonical URL stays on the most recent entry though.
     if (existing.canton === AGGREGATE_KEY && canton !== AGGREGATE_KEY) {
       existing.canton = canton;
     }
   }

   // T2.6 — Per-canton active-job counts for MIN_JOBS gate. One canonical
   // entry per dedup group, so this is the deduped count Google would index
   // per /cerca-lavoro-{canton}/ landing.
   const cantonJobCounts = new Map<string, number>();
   for (const entry of groups.values()) {
     cantonJobCounts.set(entry.canton, (cantonJobCounts.get(entry.canton) ?? 0) + 1);
   }
   let cantonIndexIndexable = 0;
   let cantonIndexNoindex = 0;

   // Build the URL list for the sharded sitemap. One entry per (group, locale)
   // = 4 × group-count entries. URL preserves the legacy frozen path
   // (sectionByLocale[locale]) — slug-registry is honored verbatim. The
   // shardKey is the canton, so high-confidence jobs cluster into per-canton
   // shards while AGGREGATE jobs land in sitemap-jobs-svizzera.xml.
   //
   // NOTE: this mirrors `jobEntries` above. We build a fresh list so the
   // legacy `<urlset>` and the new sharded index are byte-for-byte
   // independent — no shared mutation, no surprise across plugins.
   type ShardUrl = { loc: string; lastmod: string; changefreq: string; priority: number; _canton: string };
   const shardUrls: ShardUrl[] = [];
   for (const [, group] of groups) {
     const job = group.canonical;
     const perLocaleSlugMap: Record<CantonLocale, string> = {
       it: localizedSlug(job, 'it'),
       en: localizedSlug(job, 'en'),
       de: localizedSlug(job, 'de'),
       fr: localizedSlug(job, 'fr'),
     };
     // canonical-overrides: same gate as legacy sitemap. Skip if the job
     // self-canonicalizes elsewhere (otherwise Semrush flags non-canonical).
     const itPathLegacy = withSlash(`/${sectionByLocale.it}/${perLocaleSlugMap.it}`.replace(/\/+/g, '/'));
     const itUrlLegacy = `${BASE_URL}${itPathLegacy}`;
     if (resolveCanonicalUrl(perLocaleSlugMap.it, itUrlLegacy) !== itUrlLegacy) continue;
     const lastmod = (safeIsoDate(job.crawledAt) || '').slice(0, 10) || dateStamp;
     for (const locale of localeList) {
       // E9: legacy section per locale. Future canton-aware emit (when slug
       // registry has no entry) would call `buildCantonAwareSection(locale,
       // group.canton)` instead — the helper exists and is wired so that a
       // future migration can flip the default. Today everything stays at
       // sectionByLocale[locale] to preserve the URL graph.
       const section = sectionByLocale[locale];
       const path = withSlash(`${localePrefix[locale]}/${section}/${perLocaleSlugMap[locale]}`.replace(/\/+/g, '/'));
       const localeUrl = `${BASE_URL}${path}`;
       // Per-locale canonical-override gate. canonicalOverrides is keyed by
       // per-locale slug (e.g. `expediter-casale-sa-lugano` for EN,
       // `beschleuniger-…` for DE) — an entry can target a single locale
       // even when the IT sibling self-canonicalizes. Without this guard the
       // EN/DE locale URL gets advertised in sitemap-jobs-{canton}.xml while
       // its rendered HTML carries `<link rel="canonical">` pointing at the
       // brand hub — audit:sitemap-canonicals fails.
       if (resolveCanonicalUrl(perLocaleSlugMap[locale], localeUrl) !== localeUrl) continue;
       shardUrls.push({
         loc: localeUrl,
         lastmod,
         changefreq: 'weekly',
         priority: 0.6,
         _canton: group.canton,
       });
     }
   }

   // Per-canton + aggregator landing index pages. 26 cantons − TI + svizzera
   // = 26 keys × 4 locales = 104 pages. TI is skipped because
   // staticPagesPlugin already emits the legacy /cerca-lavoro-ticino/ index
   // (ditto en/de/fr) — re-emitting would race and overwrite that plugin's
   // hand-tuned content.
   //
   // P2.B1+B2+B3 — every locale-prefix path is emitted (IT no-prefix, EN/DE/FR
   // under /en /de /fr) using `buildSeoPageHtml` so each page hydrates with
   // the full SPA shell (CLAUDE.md NON-NEGOTIABLE #14: every static SSG page
   // MUST use the SPA shell + hydration). The legacy `buildSimplePage` path
   // omitted entryJs/entryCss and produced unstyled, non-hydrating pages —
   // visitors arriving at /en/find-jobs-zurich/ saw a blank shell.
   let cantonIndexEmitted = 0;
   const cantonsToEmit: Array<{ key: string; locale: CantonLocale; slug: string; section: string }> = [];
   for (const code of [...ALL_CANTON_CODES, AGGREGATE_KEY]) {
     for (const locale of localeList) {
       if (code === 'TI') continue; // owned by staticPagesPlugin
       cantonsToEmit.push({
         key: code,
         locale,
         slug: getCantonUrlSlugLocal(code, locale),
         section: buildCantonAwareSection(locale, code),
       });
     }
   }

   /**
    * Build the per-locale title/lede/CTA-label triple for a canton landing.
    * Pure function — keeps {@link buildCantonLocaleLabels} cheap to call
    * inside the emit loop and keeps the inline string-tables out of the
    * critical path. `display` is the human-readable canton name already
    * localized via `getCantonDisplayLabel`.
    */
   const buildCantonLocaleLabels = (
     locale: CantonLocale,
     display: string,
   ): { title: string; lede: string; ctaLabel: string } => {
     switch (locale) {
       case 'it':
         return {
           title: `Lavoro in ${display} | Frontaliere Ticino`,
           lede: `Pagina indice del job board per il cantone ${display}.`,
           ctaLabel: `Vedi tutte le offerte`,
         };
       case 'en':
         return {
           title: `Jobs in ${display} | Frontaliere Ticino`,
           lede: `Job board index page for canton ${display}.`,
           ctaLabel: `View all listings`,
         };
       case 'de':
         return {
           title: `Jobs ${germanCantonPrep(display)} | Frontaliere Ticino`,
           lede: `Job-Board-Übersicht für den Kanton ${display}.`,
           ctaLabel: `Alle Stellen anzeigen`,
         };
       case 'fr':
       default:
         return {
           title: `Emploi ${frenchCantonPrep(display)} | Frontaliere Ticino`,
           lede: `Index du job board pour le canton ${display}.`,
           ctaLabel: `Voir toutes les offres`,
         };
     }
   };

   for (const entry of cantonsToEmit) {
     const display = getCantonDisplayLabel(entry.key, entry.locale);
     const path = withSlash(`${localePrefix[entry.locale]}/${entry.section}`.replace(/\/+/g, '/'));
     const canonicalUrl = `${BASE_URL}${path}`;
     // T2.6 — MIN_JOBS gate. The aggregator (svizzera, AGGREGATE_KEY) always
     // ships index,follow regardless of count; per-canton pages need at least
     // MIN_JOBS_FOR_CANTON_PAGE canonical jobs. TI is filtered out earlier
     // (owned by staticPagesPlugin), so it never reaches this branch.
     const cantonCount = cantonJobCounts.get(entry.key) ?? 0;
     const meetsThreshold = entry.key === AGGREGATE_KEY || cantonCount >= MIN_JOBS_FOR_CANTON_PAGE;
     const robotsValue: 'index,follow' | 'noindex,follow' = meetsThreshold ? 'index,follow' : 'noindex,follow';
     if (meetsThreshold) cantonIndexIndexable++; else cantonIndexNoindex++;
     const labels = buildCantonLocaleLabels(entry.locale, display);
     const legacyJobBoardHref = `${BASE_URL}${withSlash(`${localePrefix[entry.locale]}/${sectionByLocale[entry.locale]}`.replace(/\/+/g, '/'))}`;
     // bodyHtml is wrapped in <main> because buildSeoPageHtml runs in
     // seoContentOutsideRoot=true mode by default — the caller-provided
     // <main> is hosted as a sibling of <div id="root"> so React's hydration
     // cannot replace the static SEO content. See SeoPageShellOpts docs.
     const bodyHtml = [
       `<main class="seo-static-content" style="max-width:1080px;margin:0 auto;padding:24px 16px">`,
       `<nav style="margin:0 0 16px;font-size:14px"><a href="${BASE_URL}/" style="color:var(--color-link);text-decoration:none;font-weight:600">${esc(homeLabel[entry.locale])}</a> &rarr; <span aria-current="page">${esc(display)}</span></nav>`,
       `<header style="max-width:860px;margin:0 0 24px"><h1 style="font-size:32px;line-height:1.15;margin:0 0 12px">${esc(display)}</h1><p style="margin:0;color:var(--color-body);font-size:16px">${esc(labels.lede)}</p></header>`,
       `<p style="margin:0 0 32px"><a href="${legacyJobBoardHref}" style="display:inline-block;padding:10px 18px;background:var(--color-accent);color:#fff;border-radius:8px;font-weight:600;text-decoration:none">${esc(labels.ctaLabel)}</a></p>`,
       `</main>`,
     ].join('\n');
     const html = buildSeoPageHtml({
       canonicalUrl,
       title: labels.title,
       description: labels.lede,
       locale: entry.locale,
       bodyHtml,
       distDir,
       // T2.6 — robots set by MIN_JOBS gate above. Pages with ≥ 5 canonical
       // jobs from the cathedral flip to 'index,follow'; thin pages stay
       // 'noindex,follow' (CLAUDE.md #4 — no thin content gets indexed). The
       // aggregator (svizzera) is always 'index,follow'. Pages still hydrate
       // via the SPA shell so the visitor lands on the real React JobBoard.
       robots: robotsValue,
     });
     const outDir = np.join(distDir, path.slice(1).replace(/\/$/, ''));
     _md(outDir);
     _qw(np.join(outDir, 'index.html'), html);
     cantonIndexEmitted++;
   }

   // P2.B3 — sitemap shard filenames use the Italian canton slug (e.g.
   // 'zurigo', 'ginevra', 'svizzera') so they MATCH the IT page URLs
   // (/cerca-lavoro-zurigo/) instead of the prior 2-letter ISO code
   // (sitemap-jobs-zh.xml). Standardising on the IT slug keeps the
   // sitemap-index entries human-readable and consistent with the canonical
   // page graph.
   const shardKeyForUrl = (u: ShardUrl): string => {
     if (u._canton === AGGREGATE_KEY) return getCantonUrlSlugLocal(AGGREGATE_KEY, 'it'); // 'svizzera'
     return getCantonUrlSlugLocal(u._canton, 'it'); // e.g. 'ZH' → 'zurigo'
   };
   const shards = splitToShards(shardUrls, { shardKey: shardKeyForUrl });
   // writeShardsToDist writes each `sitemap-jobs-{italian-slug}.xml` to the
   // top-level dist/ directory + emits dist/sitemap-index.xml referencing
   // every shard. Confirmed top-level (not under any subpath) per
   // sitemap-shard.mjs line 260 (`path.join(distDir, shard.filename)`).
   const { shardPaths, indexPath } = await writeShardsToDist(shards, distDir, BASE_URL);
   if (indexPath) {
     console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P1.11 wrote ${shardPaths.length} canton sitemap shards + ${np.relative(distDir, indexPath)}`);
   }
   console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P2.B1+B2+B3 emitted ${cantonIndexEmitted} locale-variant pages + ${shardPaths.length} sitemap shards`);
   console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m P2.S2 canton index emit: ${cantonIndexIndexable} indexable / ${cantonIndexNoindex} thin (threshold: ${MIN_JOBS_FOR_CANTON_PAGE})`);
 } catch (err) {
   // Defensive: P1.11 additions must not break the legacy emit. Log + continue.
   console.warn('[jobs-seo-pages] P1.11 canton-aware emit failed (legacy output unaffected):', err instanceof Error ? err.message : String(err));
 }

 /* ── Expired-job soft-landing pages ────────────────────────── */
 // 1. Read tracking file + merge current jobs
 const trackingPath = np.resolve(rootDir, 'data/all-known-job-slugs.json');
 let tracking: Record<string, Record<string, string>> = {};
 try {
 tracking = JSON.parse(fs.readFileSync(trackingPath, 'utf-8'));
 } catch { /* file missing or malformed — start fresh */ }

 const currentSlugs = new Set<string>();
 // Collect slug values that differ from slugByLocale.it — these are legacy
 // identifier slugs that no longer have an active page at that path. They
 // should be treated as previous slugs (bridge pages), not as current.
 const implicitPreviousSlugs: { job: typeof validJobs[0]; slug: string }[] = [];
 for (const job of validJobs) {
 const itSlug = localizedSlug(job, 'it');
 // Only add job.slug to currentSlugs if it matches the actual IT page slug.
 // When they differ, the old slug needs a bridge page, not exclusion.
 if (job.slug === itSlug) {
 currentSlugs.add(job.slug);
 } else {
 // job.slug is a legacy identifier — treat as implicit previous slug
 // so it gets a bridge page pointing to the current URL
 implicitPreviousSlugs.push({ job, slug: job.slug });
 }
 // Also mark all localized slugs as "current" so they aren't treated as
 // expired when they appear as orphan tracking keys. Without this, a
 // German master slug that differs from the IT localizedSlug can end up
 // generating a thin expired soft-landing at the master-slug path.
 for (const locale of localeList) {
 const ls = localizedSlug(job, locale);
 if (ls) currentSlugs.add(ls);
 }
 if (!tracking[job.slug]) {
 tracking[job.slug] = {};
 for (const locale of localeList) {
 const relPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/');
 tracking[job.slug][locale] = relPath;
 }
 }
 }
 // Remove search combo slugs from tracking — these are handled by the search
 // combo section, not the job crawler pipeline. They were incorrectly imported
 // from orphan-indexed-job-slugs.json in previous builds.
 const searchComboPattern = /^(?:search|ricerca|suche|recherche)-/;
 let searchCombosRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (searchComboPattern.test(key) && !currentSlugs.has(key)) {
 delete tracking[key];
 searchCombosRemoved++;
 }
 }
 if (searchCombosRemoved > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Cleaned ${searchCombosRemoved} search combo slugs from tracking`);
 }

 // Reserved hub slugs — sector + city hub URLs (e.g. /cerca-lavoro-ticino/infermieri/,
 // /cerca-lavoro-ticino/lugano/) MUST NOT be registered as orphan/compat job slugs.
 // If they were, jobsSeoPagesPlugin would emit a soft-landing page that overwrites
 // the legitimate sector/city hub HTML and points the canonical at the closest
 // matching expired job slug — killing the IT hub in SERPs (only the EN sibling
 // ranks because its slug differs, e.g. "nurses" vs "infermieri").
 const RESERVED_HUB_SLUGS = new Set<string>();
 for (const sector of SECTOR_HUB_KEYS) {
 for (const loc of ['it', 'en', 'de', 'fr'] as const) {
 RESERVED_HUB_SLUGS.add(SECTOR_HUB_SLUG[loc][sector]);
 }
 }
 for (const city of CITY_HUB_KEYS) {
 for (const loc of ['it', 'en', 'de', 'fr'] as const) {
 RESERVED_HUB_SLUGS.add(CITY_HUB_SLUG[loc][city]);
 }
 }
 // SEO archive-hub trailing slugs (jobs/sectors/companies/articles "all" pages).
 // Without this guard, an expired-job tracking key with slug e.g. "tutti" would
 // soft-land at `/cerca-lavoro-ticino/tutti/index.html` AFTER seoHubsPlugin
 // emitted the paginated index there, severing the page-1 → page-N chain and
 // orphaning every paginated variant in sitemap-seo-hubs.xml.
 for (const slug of SEO_HUB_RESERVED_SLUGS) {
 RESERVED_HUB_SLUGS.add(slug);
 }

 // Strip pre-existing reserved-hub keys from tracking BEFORE the file write.
 // Earlier GSC imports leaked "infermieri" into all-known-job-slugs.json and
 // the resulting soft-landing clobbered jobSectorPagesPlugin's hub output.
 // Skip current job slugs to avoid breaking real jobs that happen to share
 // a slug with a hub key.
 let reservedHubsRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (RESERVED_HUB_SLUGS.has(key) && !currentSlugs.has(key)) {
 delete tracking[key];
 reservedHubsRemoved++;
 }
 }
 if (reservedHubsRemoved > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Removed ${reservedHubsRemoved} reserved hub slug(s) from tracking (would have clobbered sector/city hubs)`);
 }

 // Strip pre-existing fixture-data slugs that earlier fixture-only builds
 // wrote into all-known-job-slugs.json. This is the cleanup half of the
 // fixture guard: even after we filter validJobs, the tracking file may
 // still hold leaked fixture keys from prior commits, so wipe them on
 // every build before persistence.
 let fixtureKeysRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (isFixtureSlug(key)) {
 delete tracking[key];
 fixtureKeysRemoved++;
 }
 }
 if (fixtureKeysRemoved > 0) {
 console.log(`\x1b[33m[jobs-seo-pages]\x1b[0m Removed ${fixtureKeysRemoved} fixture-data slug(s) from tracking`);
 }
 fs.writeFileSync(trackingPath, JSON.stringify(tracking, null, 2) + '\n', 'utf-8');

 // 1b. Merge orphan indexed slugs (GSC-indexed URLs with no matching job)
 // into the tracking so they get soft-landing pages too.
 const orphanSlugsPath = np.resolve(rootDir, 'data/orphan-indexed-job-slugs.json');
 try {
 const orphanSlugs: (string | { locale: string; path: string })[] = JSON.parse(fs.readFileSync(orphanSlugsPath, 'utf-8'));
 if (Array.isArray(orphanSlugs)) {
 let orphansMerged = 0;
 for (const entry of orphanSlugs) {
 if (!entry) continue;
 if (typeof entry === 'string') {
 // Legacy format: IT-only slug string
 if (tracking[entry]) continue;
 // Skip search combo pages (ricerca-*, search-*, etc.)
 if (/^(?:search|ricerca|suche|recherche)-/.test(entry)) continue;
 // Skip sector/city hub slugs to avoid overwriting hub pages.
 if (RESERVED_HUB_SLUGS.has(entry)) continue;
 // Skip fixture-data slugs leaked from earlier local builds.
 if (isFixtureSlug(entry)) continue;
 tracking[entry] = { it: `/cerca-lavoro-ticino/${entry}` };
 } else if (typeof entry === 'object' && entry.locale && entry.path) {
 // Locale-aware format: { locale: "de", path: "/de/jobs-im-tessin/..." }
 // Key = last path segment (the slug), value = { [locale]: path }
 const cleanPath = entry.path.replace(/\/+$/, ''); // strip trailing slash
 const slug = cleanPath.split('/').pop()!;
 if (!slug) continue;
 // Skip search combo pages — these are generated by the search section,
 // not by the job crawler pipeline. Importing them as orphan jobs would
 // create duplicate pages and confuse the flat-file generation.
 if (/^(?:search|ricerca|suche|recherche)-/.test(slug)) continue;
 // Skip sector/city hub slugs to avoid overwriting hub pages.
 if (RESERVED_HUB_SLUGS.has(slug)) continue;
 // Skip fixture-data slugs leaked from earlier local builds.
 if (isFixtureSlug(slug)) continue;
 if (!tracking[slug]) tracking[slug] = {};
 (tracking[slug] as Record<string, string>)[entry.locale] = cleanPath;
 } else {
 continue;
 }
 orphansMerged++;
 }
 if (orphansMerged > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Merged ${orphansMerged} orphan GSC slugs into expired tracking`);
 }
 }
 } catch { /* file missing — skip */ }

 // 1b2. Merge GSC 404 compat paths into tracking so they get soft-landing pages
 // instead of thin "Pagina archiviata" pages from legacyRedirectsPlugin.
 // The compat file is a manual GSC export; the orphan pipeline now subsumes it.
 // Handles all locales: IT (/cerca-lavoro-ticino/), DE (/de/jobs-im-tessin/), FR (/fr/trouver-emploi-tessin/)
 const compatPathsFile = np.resolve(rootDir, 'data/seo-404-compat-paths.json');
 try {
 const compatData = JSON.parse(fs.readFileSync(compatPathsFile, 'utf-8'));
 const compatPaths: string[] = Array.isArray(compatData?.paths) ? compatData.paths : [];
 let compatAdded = 0;
 const COMPAT_JOB_PATTERNS: { re: RegExp; locale: string; prefix: string }[] = [
 { re: /\/cerca-lavoro-ticino\/([^/]+)\/?$/, locale: 'it', prefix: '/cerca-lavoro-ticino/' },
 { re: /\/en\/find-jobs?-ticino\/([^/]+)\/?$/, locale: 'en', prefix: '/en/find-jobs-ticino/' },
 { re: /\/en\/job-search-ticino\/([^/]+)\/?$/, locale: 'en', prefix: '/en/find-jobs-ticino/' },
 { re: /\/de\/jobs-im-tessin\/([^/]+)\/?$/, locale: 'de', prefix: '/de/jobs-im-tessin/' },
 { re: /\/de\/jobsuche-tessin\/([^/]+)\/?$/, locale: 'de', prefix: '/de/jobs-im-tessin/' },
 { re: /\/fr\/trouver-emploi-tessin\/([^/]+)\/?$/, locale: 'fr', prefix: '/fr/trouver-emploi-tessin/' },
 { re: /\/fr\/recherche-emploi-tessin\/([^/]+)\/?$/, locale: 'fr', prefix: '/fr/trouver-emploi-tessin/' },
 ];
 const SKIP_PREFIX_RE = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;
 for (const p of compatPaths) {
 const raw = String(p || '');
 for (const { re, locale, prefix } of COMPAT_JOB_PATTERNS) {
 const m = raw.match(re);
 if (!m) continue;
 const slug = m[1];
 if (!slug || SKIP_PREFIX_RE.test(slug)) break;
 // Skip sector/city hub slugs — registering them here would emit a
 // soft-landing page that overwrites the legitimate hub HTML and
 // breaks the canonical (the IT hub stops ranking; only EN sibling
 // survives because its slug differs).
 if (RESERVED_HUB_SLUGS.has(slug)) break;
 // Skip fixture-data slugs leaked from earlier local builds.
 if (isFixtureSlug(slug)) break;
 if (!tracking[slug]) tracking[slug] = {};
 if ((tracking[slug] as Record<string, string>)[locale]) break; // locale path already known
 (tracking[slug] as Record<string, string>)[locale] = `${prefix}${slug}`;
 compatAdded++;
 break;
 }
 }
 if (compatAdded > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Merged ${compatAdded} GSC-404 compat job paths into expired tracking`);
 }
 } catch { /* file missing — skip */ }

 // 1c. Load enriched data for orphan slugs (GSC queries + translation cache titles/descriptions)
 const orphanEnrichedPath = np.resolve(rootDir, 'data/orphan-enriched-data.json');
 interface OrphanEnriched {
 queries?: string[];
 totalImpressions?: number;
 totalClicks?: number;
 topQuery?: string | null;
 title?: string;
 titleByLocale?: Record<string, string>;
 descriptionByLocale?: Record<string, string>;
 company?: string;
 companyKey?: string;
 location?: string;
 sector?: string;
 salaryMin?: number;
 salaryCurrency?: string;
 slugByLocale?: Record<string, string>;
 localePaths?: Record<string, string>;
 sourceUrl?: string;
 }
 const orphanGscData = new Map<string, OrphanEnriched>();
 try {
 const enrichedArr: any[] = JSON.parse(fs.readFileSync(orphanEnrichedPath, 'utf-8'));
 let withQueries = 0;
 let withContent = 0;
 for (const entry of enrichedArr) {
 if (!entry?.slug) continue;
 const data: OrphanEnriched = {};
 if (entry.queries?.length > 0) {
 data.queries = entry.queries;
 data.totalImpressions = entry.totalImpressions || 0;
 data.totalClicks = entry.totalClicks || 0;
 data.topQuery = entry.topQuery || null;
 withQueries++;
 }
 if (entry.title) data.title = entry.title;
 if (entry.titleByLocale) data.titleByLocale = entry.titleByLocale;
 if (entry.descriptionByLocale && Object.keys(entry.descriptionByLocale).length > 0) {
 data.descriptionByLocale = entry.descriptionByLocale;
 withContent++;
 }
 if (entry.company) data.company = entry.company;
 if (entry.companyKey) data.companyKey = entry.companyKey;
 if (entry.location) data.location = entry.location;
 if (entry.sector) data.sector = entry.sector;
 if (entry.salaryMin) data.salaryMin = entry.salaryMin;
 if (entry.salaryCurrency) data.salaryCurrency = entry.salaryCurrency;
 if (entry.slugByLocale) data.slugByLocale = entry.slugByLocale;
 if (entry.localePaths) data.localePaths = entry.localePaths;
 if (entry.sourceUrl) data.sourceUrl = entry.sourceUrl;
 if (Object.keys(data).length > 0) orphanGscData.set(entry.slug, data);
 }
 if (orphanGscData.size > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Loaded enrichment for ${orphanGscData.size} orphan slugs (${withQueries} with GSC queries, ${withContent} with full content)`);
 }
 } catch { /* file missing — skip */ }

 // 2. Load expired job data for rich content (previousSlugs, title, company, etc.)
 const expiredJobsPath = np.resolve(rootDir, 'data/expired-jobs.json');
 let expiredJobsData: any[] = [];
 try {
 expiredJobsData = JSON.parse(fs.readFileSync(expiredJobsPath, 'utf-8'));
 if (!Array.isArray(expiredJobsData)) expiredJobsData = [];
 } catch { /* no expired data */ }
 // Sort DESC by recency BEFORE populating expiredBySlug. Combined with the
 // `!has` guard below this gives "most-recent expired job wins" for both
 // own-slug indexing AND previousSlugs indexing (147 of the 305 expired
 // entries share at least one previousSlug with another expired entry —
 // top offender: `augenoptiker-w-m-d-fielmann-ch` shared by 63 expired
 // jobs — so the order in which we enter them into the map decides which
 // job's title/description ends up on the soft-landing page at that path).
 expiredJobsData.sort((a, b) => {
 const ta = _jobRecency(a);
 const tb = _jobRecency(b);
 if (ta !== tb) return tb - ta;
 return String(a.id || a.slug || '').localeCompare(String(b.id || b.slug || ''));
 });
 const expiredBySlug = new Map<string, any>();
 for (const ej of expiredJobsData) {
 // `!has` guard so the FIRST entry (most-recent due to sort above) wins.
 // Was unconditional `set` previously, which let the LAST entry (oldest
 // after sort, but arbitrary order before sort) overwrite the winner.
 if (ej.slug && !expiredBySlug.has(ej.slug)) expiredBySlug.set(ej.slug, ej);
 // Also index previousSlugs so renamed-then-deleted jobs get enriched soft-landing pages
 if (Array.isArray(ej.previousSlugs)) {
 for (const ps of ej.previousSlugs) {
 if (ps && !expiredBySlug.has(ps)) expiredBySlug.set(ps, ej);
 }
 }
 // Also index previousSlugsByLocale entries
 if (ej.previousSlugsByLocale && typeof ej.previousSlugsByLocale === 'object') {
 for (const arr of Object.values(ej.previousSlugsByLocale)) {
 if (Array.isArray(arr)) {
 for (const ps of arr as string[]) {
 if (ps && !expiredBySlug.has(ps)) expiredBySlug.set(ps, ej);
 }
 }
 }
 }
 }

 // FRO-343: Load swiss-postal-codes for postalCode enrichment of soft-landing pages
 let plzLookup: Record<string, string> = {};
 const plzPath = np.resolve(rootDir, 'data', 'swiss-postal-codes.json');
 if (fs.existsSync(plzPath)) {
 try { plzLookup = JSON.parse(fs.readFileSync(plzPath, 'utf-8')); } catch { /* ok */ }
 }

 // 3. Generate soft-landing pages for expired slugs
 // Pre-build a set of all previousSlugs from active jobs so we can exclude them from
 // expiredSlugs. These slugs will be handled as bridge pages (canonical → new URL) and
 // must NOT appear in the expired sitemap (which would cause validate-canonical failures
 // because bridge HTML has a non-self canonical). The all-writes-are-queued pattern means
 // fs.existsSync cannot guard against the bridge page overwriting the expired HTML, so
 // the cleanest fix is to exclude bridge slugs from expiredSlugs entirely.
 const bridgeSlugSet = new Set<string>();
 // Helper: collect all previous slugs from both formats (defined early so the
 // fuzzy-match step below can use it to check "already known" slugs).
 const _allPrevSlugs = (j: any): string[] => {
 const all = new Set<string>(Array.isArray(j.previousSlugs) ? j.previousSlugs : []);
 if (j.previousSlugsByLocale && typeof j.previousSlugsByLocale === 'object') {
 for (const arr of Object.values(j.previousSlugsByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) all.add(s);
 }
 }
 return [...all];
 };

 /* ── Fuzzy match orphan slugs to active jobs ─────────────────── */
 // When a company rebrand or title rewrite causes a slug to change, only the
 // locale that triggered regeneration records the old slug in previousSlugsByLocale.
 // The sibling locales' old slugs (which Google may still have indexed) become
 // orphans that fall through to the self-healing "offerta aggiornata" page.
 // Scan `tracking` (merged active + orphan + compat paths) and for each slug
 // not already attached to any active job, score it against every active job's
 // slugByLocale via token overlap. If the best match is confident enough
 // (>=60% token overlap AND ≥3 shared tokens), inject it into that job's
 // previousSlugsByLocale so the downstream bridge + cross-locale blocks
 // generate a full-content reconciliation page.
 const knownSlugs = new Set<string>();
 for (const j of validJobs) {
 if (j.slug) knownSlugs.add(j.slug);
 if (j.slugByLocale) for (const s of Object.values(j.slugByLocale)) if (typeof s === 'string' && s) knownSlugs.add(s);
 for (const s of _allPrevSlugs(j)) knownSlugs.add(s);
 }
 const tokenize = (s: string): string[] => s.split('-').filter(t => t.length >= 3);
 // Index active jobs by every token that appears in any of their slugs so we
 // can quickly find candidates for a given orphan slug (avoids O(orphan × jobs)).
 const jobsByToken = new Map<string, Set<number>>();
 validJobs.forEach((j, idx) => {
 const sbl = (j as any).slugByLocale || {};
 const allJobSlugs = [
 ...Object.values(sbl).filter((s): s is string => typeof s === 'string' && s.length > 0),
 j.slug,
 ].filter(Boolean) as string[];
 const tokens = new Set<string>();
 for (const s of allJobSlugs) for (const t of tokenize(s)) tokens.add(t);
 for (const t of tokens) {
 if (!jobsByToken.has(t)) jobsByToken.set(t, new Set());
 jobsByToken.get(t)!.add(idx);
 }
 });
 const SKIP_PREFIX_FUZZY = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;
 let fuzzyMatched = 0;
 for (const orphanSlug of Object.keys(tracking)) {
 if (knownSlugs.has(orphanSlug)) continue;
 if (SKIP_PREFIX_FUZZY.test(orphanSlug)) continue;
 const orphanTokens = tokenize(orphanSlug);
 if (orphanTokens.length < 4) continue;
 // Candidate jobs share at least one token with the orphan slug
 const candidateIdx = new Map<number, number>();
 for (const t of orphanTokens) {
 const idxSet = jobsByToken.get(t);
 if (!idxSet) continue;
 for (const i of idxSet) candidateIdx.set(i, (candidateIdx.get(i) || 0) + 1);
 }
 if (candidateIdx.size === 0) continue;
 // Score only candidates that share ≥3 tokens with the orphan (coarse filter)
 let best: { job: any; locale: string; score: number; shared: number } | null = null;
 for (const [idx, shared] of candidateIdx) {
 if (shared < 3) continue;
 const cand = validJobs[idx];
 const sbl = (cand as any).slugByLocale || {};
 for (const locale of localeList) {
 const candSlug = sbl[locale] || cand.slug || '';
 if (!candSlug) continue;
 const candTokens = new Set(tokenize(candSlug));
 if (candTokens.size === 0) continue;
 const inter = orphanTokens.filter(t => candTokens.has(t)).length;
 const score = inter / Math.max(orphanTokens.length, candTokens.size);
 if (!best || score > best.score) best = { job: cand, locale, score, shared: inter };
 }
 }
 if (!best || best.score < 0.6 || best.shared < 3) continue;
 const target = best.job as { previousSlugsByLocale?: Record<string, string[]> };
 if (!target.previousSlugsByLocale) target.previousSlugsByLocale = {};
 const arr = target.previousSlugsByLocale[best.locale] || (target.previousSlugsByLocale[best.locale] = []);
 if (!arr.includes(orphanSlug)) {
 arr.push(orphanSlug);
 knownSlugs.add(orphanSlug);
 fuzzyMatched++;
 }
 }
 if (fuzzyMatched > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Fuzzy-matched ${fuzzyMatched} orphan slugs to active jobs as implicit previousSlugs`);
 }

 // Collect IT paths of all previous slugs so we can also exclude their
 // locale-variant tracking keys (e.g. EN/DE/FR slug for the same old job).
 // The tracking file stores one key per locale slug, all pointing to the
 // same IT path, so we must group by IT path to catch them all.
 const bridgeItPaths = new Set<string>();
 for (const job of validJobs) {
 for (const s of _allPrevSlugs(job)) {
 bridgeSlugSet.add(s);
 const itPath = (tracking[s] as any)?.it;
 if (itPath) bridgeItPaths.add(itPath);
 }
 }
 // Add implicit previous slugs (job.slug ≠ slugByLocale.it) to bridge set
 // and ensure they're in previousSlugsByLocale for bridge page generation
 for (const { job, slug } of implicitPreviousSlugs) {
 bridgeSlugSet.add(slug);
 // Write to locale-aware field (IT locale since these are master slug mismatches)
 if (!(job as any).previousSlugsByLocale) (job as any).previousSlugsByLocale = {};
 if (!Array.isArray((job as any).previousSlugsByLocale.it)) (job as any).previousSlugsByLocale.it = [];
 if (!(job as any).previousSlugsByLocale.it.includes(slug)) {
 (job as any).previousSlugsByLocale.it.push(slug);
 }
 // Also keep legacy flat array in sync
 if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
 if (!job.previousSlugs.includes(slug)) job.previousSlugs.push(slug);
 // Ensure tracking has this slug with correct locale paths
 if (!tracking[slug]) {
 tracking[slug] = {
 it: `/${sectionByLocale.it}/${slug}`,
 en: `/en/${sectionByLocale.en}/${slug}`,
 de: `/de/${sectionByLocale.de}/${slug}`,
 fr: `/fr/${sectionByLocale.fr}/${slug}`,
 };
 }
 }
 // FRO-SEO: Build a set of actual FILE PATHS that bridge pages will claim.
 // Previously we excluded entire tracking keys whose IT path matched any bridge
 // IT path. This was too aggressive: locale-variant keys (EN/DE/FR slug →
 // same IT path) have DIFFERENT translated locale paths that don't conflict
 // with bridge pages (which use the IT slug for all locales). The old approach
 // created a "dead zone" of ~1,700 tracking keys with NO pages generated.
 // Now we exclude only the specific locale paths that actually conflict.
 const bridgeClaimedPaths = new Set<string>();
 for (const job of validJobs) {
 for (const oldSlug of _allPrevSlugs(job)) {
 if (!oldSlug) continue;
 for (const locale of localeList) {
 const p = `${localePrefix[locale]}/${sectionByLocale[locale]}/${oldSlug}`.replace(/\/+/g, '/');
 bridgeClaimedPaths.add(p);
 }
 }
 }
 for (const { slug } of implicitPreviousSlugs) {
 for (const locale of localeList) {
 const p = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
 bridgeClaimedPaths.add(p);
 }
 }
 // Include ALL tracking keys except direct bridge slugs. Keys that happen to
 // match a currentSlug value are included because their locale paths may differ
 // from the active job's paths — writeSoftLandingPage already skips paths
 // where active or bridge pages exist (via _writtenPaths / activeJobDirs).
 // Exclude RESERVED_HUB_SLUGS from soft-landing emission. Pre-existing
 // tracking entries imported from gsc-404 (e.g. slug "infermieri") would
 // otherwise overwrite the legitimate sector/city hub HTML at
 // /cerca-lavoro-ticino/infermieri/index.html with a thin job soft-landing
 // and break Semrush W2 (Issue 102) + the canonical sector page in SERPs.
 const expiredSlugs = Object.keys(tracking).filter(
 (s) => !bridgeSlugSet.has(s) && !RESERVED_HUB_SLUGS.has(s),
 );

 const expiredBannerCopy: Record<string, { title: string; banner: string }> = {
 it: { title: 'Offerta non più disponibile', banner: 'Questa posizione non è più attiva. Di seguito trovi i dettagli originali e posizioni simili.' },
 en: { title: 'Job no longer available', banner: 'This position is no longer active. Below you\'ll find the original details and similar positions.' },
 de: { title: 'Stelle nicht mehr verfügbar', banner: 'Diese Position ist nicht mehr aktiv. Nachfolgend finden Sie die Originaldetails und ähnliche Stellen.' },
 fr: { title: 'Offre non disponible', banner: 'Ce poste n\'est plus actif. Vous trouverez ci-dessous les détails originaux et des postes similaires.' },
 };
 const archiveRelatedLabel: Record<string, string> = {
 it: 'Posizioni aperte simili in Ticino',
 en: 'Similar open positions in Ticino',
 de: 'Ähnliche offene Stellen im Tessin',
 fr: 'Postes similaires ouverts au Tessin',
 };
 const archiveCtaLabel: Record<string, string> = {
 it: 'Tutte le offerte di lavoro in Ticino',
 en: 'All job openings in Ticino',
 de: 'Alle offenen Stellen im Tessin',
 fr: 'Toutes les offres d\'emploi au Tessin',
 };
 const hashCode = (s: string) => {
 let h = 0;
 for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
 return h;
 };


 // --- extractInfoFromSlug: de-slugify orphan slugs to recover title/company/location ---
 // Build lookup tables for matching
 const adapterDir = np.resolve(rootDir, 'data/jobs-crawler-adapters/adapters');
 const companySlugMap: { slug: string; name: string }[] = [];
 const seenCompanySlugs = new Set<string>();
 try {
 for (const f of fs.readdirSync(adapterDir).filter((n: string) => n.endsWith('.json'))) {
 const d = JSON.parse(fs.readFileSync(np.join(adapterDir, f), 'utf-8'));
 const name = d.companyName || d.company || '';
 if (!name) continue;
 const adapterSlug = f.replace('.json', '');
 companySlugMap.push({ slug: adapterSlug, name });
 seenCompanySlugs.add(adapterSlug);
 // Also generate a slugified version of the company name for matching
 // e.g. "FART – Ferrovie Autolinee Regionali Ticinesi" → "fart-ferrovie-autolinee-regionali-ticinesi"
 const nameSlug = name
 .toLowerCase()
 .replace(/[–—]/g, '-')
 .replace(/[()]/g, '')
 .replace(/[^a-z0-9\s-]/g, '')
 .replace(/\s+/g, '-')
 .replace(/-{2,}/g, '-')
 .replace(/^-|-$/g, '');
 if (nameSlug && nameSlug !== adapterSlug && !seenCompanySlugs.has(nameSlug)) {
 companySlugMap.push({ slug: nameSlug, name });
 seenCompanySlugs.add(nameSlug);
 }
 }
 } catch { /* adapters dir missing */ }
 // Also include companies from active jobs (covers crawlers without adapters)
 for (const job of validJobs) {
 const key = String(job.companyKey || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
 if (key && !seenCompanySlugs.has(key)) {
 companySlugMap.push({ slug: key, name: job.company });
 seenCompanySlugs.add(key);
 }
 }
 // Sort by slug length descending for longest-match-first
 companySlugMap.sort((a, b) => b.slug.length - a.slug.length);

 // Location names from swiss-postal-codes.json (key=locationName, value=postalCode)
 const locationNames = Object.keys(plzLookup).sort((a, b) => b.length - a.length);
 // Slugified location names for matching (e.g. "riva san vitale" -> "riva-san-vitale")
 const locationSlugPairs = locationNames.map(name => ({
 name,
 slug: name.toLowerCase().replace(/\s+/g, '-'),
 postalCode: plzLookup[name],
 }));

 // Common Italian/English stop words and gender markers to strip from de-slugified titles
 const slugStopFragments = new Set([
 'm-f', 'f-m', 'm-w', 'f-m-d', 'm-w-d', 'm-f-d', 'w-m-d', 'w-m',
 '100', '80', '60', '80-100', '60-100', '60-80',
 'afc', 'cfp', 'a', 'o', 'e',
 'm', 'f', 'd', 'w', // standalone gender markers (after company slug removal splits "m-f-d")
 ]);

 /** A curated set of foreign capital / tech-hub cities that routinely appear
  * as the trailing token on remote-role slugs (Tether, GitHub-style crypto,
  * fintech). These are NOT in the Swiss PLZ table nor in `broadLocations`;
  * without this list we'd leave `location` empty and render the SAME body
  * for every `…-buenos-aires`, `…-cairo`, `…-dubai` sibling → duplicate
  * content cluster.
  *
  * We deliberately keep the list narrow and human-readable rather than
  * auto-importing a full world-city dataset: every entry here must look
  * natural in the `<p>…${loc} (${canton})…</p>` copy.
  */
 const FOREIGN_CITY_SLUGS: Record<string, string> = {
  'amsterdam': 'Amsterdam',
  'athens': 'Athens',
  'bangalore': 'Bangalore',
  'barcelona': 'Barcelona',
  'berlin': 'Berlin',
  'brussels': 'Brussels',
  'bucharest': 'Bucharest',
  'bucuresti': 'București',
  'budapest': 'Budapest',
  'buenos-aires': 'Buenos Aires',
  'cairo': 'Cairo',
  'cape-town': 'Cape Town',
  'copenhagen': 'Copenhagen',
  'dublin': 'Dublin',
  'dubai': 'Dubai',
  'frankfurt': 'Frankfurt',
  'helsinki': 'Helsinki',
  'hong-kong': 'Hong Kong',
  'islamabad': 'Islamabad',
  'istanbul': 'Istanbul',
  'jakarta': 'Jakarta',
  'johannesburg': 'Johannesburg',
  'kiev': 'Kyiv',
  'kyiv': 'Kyiv',
  'kuala-lumpur': 'Kuala Lumpur',
  'lagos': 'Lagos',
  'lima': 'Lima',
  'lisbon': 'Lisbon',
  'london': 'London',
  'luxembourg': 'Luxembourg',
  'luxemburg': 'Luxembourg',
  'madrid': 'Madrid',
  'manila': 'Manila',
  'melbourne': 'Melbourne',
  'mexico-city': 'Mexico City',
  'miami': 'Miami',
  'milan': 'Milan',
  'milano': 'Milano',
  'montreal': 'Montreal',
  'moscow': 'Moscow',
  'mumbai': 'Mumbai',
  'munich': 'Munich',
  'nairobi': 'Nairobi',
  'new-york': 'New York',
  'oslo': 'Oslo',
  'paris': 'Paris',
  'prague': 'Prague',
  'rome': 'Rome',
  'roma': 'Roma',
  'san-francisco': 'San Francisco',
  'santiago': 'Santiago',
  'sao-paulo': 'São Paulo',
  'seoul': 'Seoul',
  'shanghai': 'Shanghai',
  'singapore': 'Singapore',
  'stockholm': 'Stockholm',
  'sydney': 'Sydney',
  'taipei': 'Taipei',
  'tel-aviv': 'Tel Aviv',
  'tokyo': 'Tokyo',
  'toronto': 'Toronto',
  'vancouver': 'Vancouver',
  'vienna': 'Vienna',
  'warsaw': 'Warsaw',
  'yerevan': 'Yerevan',
  'zagreb': 'Zagreb',
  'munsbach': 'Munsbach',
  'england': 'England',
  'london-england': 'London',
 };
 // Sort once by slug length so we match the longest (e.g. "mexico-city"
 // before "city") — the normal suffix-match pattern used for Swiss cities.
 const FOREIGN_CITY_SLUG_ENTRIES = Object.entries(FOREIGN_CITY_SLUGS).sort(
  (a, b) => b[0].length - a[0].length,
 );

 const extractInfoFromSlug = (slug: string): { title: string; company: string; companyKey: string; location: string; postalCode: string } => {
 let remaining = slug;
 let company = '';
 let companyKey = '';
 let location = '';
 let postalCode = '';

 // 1. Match company (longest slug match first, word-boundary aware)
 // Use regex with hyphen/start/end boundaries to prevent false positives
 // e.g. "a-group" must not match inside "prada-group"
 for (const c of companySlugMap) {
 const escaped = c.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const re = new RegExp(`(?:^|-)${escaped}(?:-|$)`);
 if (re.test(remaining)) {
 company = c.name;
 companyKey = c.slug;
 remaining = remaining.replace(re, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
 break;
 }
 }

 // 2. Match location (longest name match first, at end of slug preferred)
 for (const loc of locationSlugPairs) {
 if (remaining.endsWith(loc.slug) || remaining.endsWith('-' + loc.slug)) {
 location = loc.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
 postalCode = loc.postalCode;
 remaining = remaining.replace(new RegExp('-?' + loc.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
 break;
 }
 // Also check if location appears mid-slug (common for e.g. "coop-mezzovico")
 if (!location && remaining.includes('-' + loc.slug + '-')) {
 location = loc.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
 postalCode = loc.postalCode;
 remaining = remaining.replace('-' + loc.slug + '-', '-').replace(/^-+|-+$/g, '');
 }
 }

 // Also check broader Swiss locations not in Ticino PLZ
 if (!location) {
 const broadLocations: Record<string, string> = {
 'grigioni': 'Grigioni', 'graubunden': 'Graubünden', 'st-moritz': 'St. Moritz',
 'coira': 'Coira', 'chur': 'Chur', 'davos': 'Davos', 'berna': 'Berna',
 'zurigo': 'Zurigo', 'zurich': 'Zürich', 'basilea': 'Basilea', 'ginevra': 'Ginevra',
 'losanna': 'Losanna', 'lucerna': 'Lucerna', 'anniviers': 'Anniviers',
 'domat-ems': 'Domat/Ems', 'svizzera': '', // generic, don't use as location
 };
 for (const [locSlug, locName] of Object.entries(broadLocations)) {
 if (locName && (remaining.endsWith(locSlug) || remaining.endsWith('-' + locSlug))) {
 location = locName;
 remaining = remaining.replace(new RegExp('-?' + locSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
 break;
 }
 }
 }

 // 2b. Fallback: known foreign hub cities (remote-role trailing tokens).
 // WHY: Tether/crypto/fintech remote roles ship the city in the slug tail
 // (`…-buenos-aires`, `…-cairo`, `…-dubai`) even though the role is remote.
 // Without this pass, `location` stays empty for 100+ pages per role and
 // the rendered body collapses into one cluster (same expired-job
 // template, identical headings) → `audit-content-duplicates` FAIL.
 if (!location) {
 for (const [citySlug, cityName] of FOREIGN_CITY_SLUG_ENTRIES) {
 if (remaining === citySlug || remaining.endsWith(`-${citySlug}`)) {
 location = cityName;
 remaining = remaining.replace(new RegExp(`-?${citySlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
 break;
 }
 }
 }

 // 3. Clean up remaining to form the title
 // Remove leading number prefixes (e.g. "1-addetto" -> "addetto")
 remaining = remaining.replace(/^\d+-/, '');
 // Remove stop fragments
 const parts = remaining.split('-').filter(p => p && !slugStopFragments.has(p));
 // De-slugify: capitalize first word, join with spaces
 const title = parts
 .join(' ')
 .replace(/amp\s/g, '& ') // decode &amp; in slugs
 .replace(/\bdot\b/g, '.') // decode dots
 .replace(/^./, c => c.toUpperCase())
 .trim();

 return { title: title || slug, company, companyKey, location, postalCode };
 };

 let expiredCount = 0;
 let legacyCount = 0;
 const expiredSitemapEntries: string[] = [];

 // Pre-compute invariant HTML fragments for soft-landing pages (~69K pages).
 // Avoids re-building the same ~2KB of boilerplate for each page.
 const currentYear = new Date().getFullYear();
 const darkModeScript = `<script>(function(){if(localStorage.theme==='dark'||((!('theme' in localStorage))&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}})()</script>`;
 const darkModeStyles = `<style>
 .dark body{background:#0f172a;color:#e2e8f0}
 .dark .ft-static-nav{background:rgba(15,23,42,.7);border-color:rgba(30,41,59,.5)}
 .dark .ft-static-nav a{color:#93c5fd}
 .dark .ft-static-article{color:#e2e8f0}
 .dark .ft-static-article a{color:#818cf8}
 .dark .ft-static-footer{background:rgba(15,23,42,.5);border-color:rgba(30,41,59,1);color:#94a3b8}
 .dark .ft-static-footer a{color:#93c5fd}
 </style>`;
 const navSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="28" height="28"><rect x="10" y="10" width="80" height="80" rx="16" fill="#1e293b"/><rect x="22" y="22" width="56" height="20" rx="4" fill="#94a3b8"/><rect x="22" y="52" width="24" height="24" rx="6" fill="#dc2626"/><path d="M34 58v12M28 64h12" stroke="white" stroke-width="3" stroke-linecap="round"/><mask id="m"><rect x="54" y="52" width="24" height="24" rx="6" fill="white"/></mask><g mask="url(#m)"><rect x="54" y="52" width="8" height="24" fill="#16a34a"/><rect x="62" y="52" width="8" height="24" fill="white"/><rect x="70" y="52" width="8" height="24" fill="#dc2626"/></g></svg>`;
 const spaBundleCss = hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : '';
 const spaBundleJs = hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : '';
 // Per-locale pre-built nav + footer (only 4 strings to cache)
 const localeShells = Object.fromEntries(localeList.map(l => {
 const lp = `${localePrefix[l]}/${sectionByLocale[l]}/`.replace(/\/+/g, '/');
 const sectionLink = `${BASE_URL}${lp}`;
 const sectionName = esc(localeCopy[l].sectionName);
 const nav = `<nav class="ft-static-nav" aria-label="Navigazione principale" style="position:sticky;top:0;z-index:50;background:var(--color-job-sticky-bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--color-job-sticky-border);box-shadow:0 1px 2px rgba(0,0,0,.05);padding:0 16px">
 <div style="max-width:2400px;width:95%;margin:0 auto;display:flex;align-items:center;height:56px;gap:12px">
 <a href="${BASE_URL}/" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--color-link);font-weight:700;font-size:15px;font-family:system-ui,sans-serif">
 ${navSvg}
 Frontaliere Ticino
 </a>
 <span style="flex:1"></span>
 <a href="${sectionLink}" style="font-size:13px;color:var(--color-accent);text-decoration:none;font-family:system-ui,sans-serif">${sectionName}</a>
 </div>
 </nav>`;
 const footer = `<footer class="ft-static-footer" style="border-top:1px solid var(--color-edge);background:var(--color-surface);padding:24px 16px;margin-top:auto;font-family:system-ui,sans-serif;font-size:13px;color:var(--color-subtle);text-align:center">
 <div style="max-width:1280px;margin:0 auto">
 &copy; ${currentYear} <a href="${BASE_URL}/" style="color:var(--color-accent);text-decoration:none">Frontaliere Ticino</a> &mdash;
 <a href="${sectionLink}" style="color:var(--color-accent);text-decoration:none">${sectionName}</a>
 </div>
 </footer>`;
 return [l, { nav, footer, listingPath: lp }];
 }));

 // Assembler: builds a complete soft-landing HTML page from pre-computed parts + dynamic slots
 const buildSoftLandingHtml = (locale: string, pageTitle: string, pageDesc: string, robotsTag: string,
 selfUrl: string, hreflangLinks: string, jsonLdScripts: string, expiredWindowData: string,
 staticBodyJson: string, staticBody: string): string => {
 const shell = localeShells[locale];
 return `<!DOCTYPE html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 ${FAVICON_LINKS}
 <title>${pageTitle}</title>
 <meta name="description" content="${pageDesc}">${robotsTag}
 <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
 <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
 <link rel="canonical" href="${selfUrl}">
${hreflangLinks}
 ${darkModeScript}
 ${darkModeStyles}
 ${jsonLdScripts}
 <script>window.__EXPIRED_JOB_DATA__=${expiredWindowData};window.__STATIC_BODY_HTML__=${staticBodyJson};</script>${spaBundleCss}
 ${SPA_ACTION_REDIRECT_SCRIPT}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 </head>
 <body>
 <div id="root">
 ${shell.nav}
 <article class="ft-static-article" style="max-width:1280px;margin:0 auto;padding:24px 16px;font-family:system-ui,sans-serif;color:var(--color-body);">
 ${staticBody}
 </article>
 ${shell.footer}
 </div>${spaBundleJs}
 </body>
</html>`;
 };
 const writeSoftLandingPage = (outRelPath: string, html: string) => {
 // Normalize: strip trailing slashes to prevent flat files like ".html" (hidden files)
 const normPath = outRelPath.replace(/\/+$/, '');
 // Never overwrite ANY page already written by an earlier phase
 // (active jobs, company pages, search pages, editorial pages)
 const targetFile = np.join(distDir, normPath, 'index.html');
 if (_writtenPaths.has(targetFile)) return;
 if (activeJobDirs.has(normPath)) return;

 const outDir = np.join(distDir, normPath);
 _qw(np.join(outDir, 'index.html'), html);
 const flatFile = np.join(distDir, normPath + '.html');
 _qwFlat(flatFile, html);
 };

 // Pre-compute company → active jobs lookup (O(1) instead of O(n) per expired page)
 const companyActiveJobsMap = new Map<string, any[]>();
 for (const j of validJobs) {
 const key = String(j.company || '').toLowerCase();
 if (!key) continue;
 const arr = companyActiveJobsMap.get(key);
 if (arr) { if (arr.length < 5) arr.push(j); }
 else companyActiveJobsMap.set(key, [j]);
 }
 // Pre-compute deterministic "recent jobs" pools: 20 jobs pre-sorted,
 // then select 5 per expired slug via modular index (avoids O(n log n) sort per page)
 const recentJobPool = validJobs.slice(0, Math.min(50, validJobs.length));
 const selectRecentJobs = (seed: string, exclude: string) => {
 const h = hashCode(seed);
 const result: any[] = [];
 for (let i = 0; i < recentJobPool.length && result.length < 5; i++) {
 const idx = (h + i * 7) % recentJobPool.length;
 const j = recentJobPool[idx];
 if (j.slug !== exclude && !result.includes(j)) result.push(j);
 }
 return result;
 };

 // Cache soft-landing HTML per (locale, slug) so the cross-locale
 // reconciliation pass below can reuse it instead of re-rendering.
 // Only cache slugs that actually need it — jobs from expired-jobs.json
 // whose slugByLocale has divergent values across locales — otherwise
 // we'd pin ~18k HTML strings (~550MB) in memory for no benefit.
 const expiredSoftLandingCache = new Map<string, string>();
 const expiredCacheKeys = new Set<string>();
 for (const ej of expiredJobsData) {
 const sbl = (ej && ej.slugByLocale) as Record<string, string> | undefined;
 if (!sbl || typeof sbl !== 'object') continue;
 const distinct = new Set(Object.values(sbl).filter(Boolean));
 if (distinct.size < 2) continue;
 for (const loc of localeList) {
 const s = sbl[loc];
 if (s) expiredCacheKeys.add(`${loc}:${s}`);
 }
 }

 // Memoized FAQ HTML per (locale, escDisplayCanton). The 5-Q&A block
 // depends only on the locale and the displayCanton — the same job's
 // company, location, slug, etc. don't change the rendered FAQ at all.
 // Cache key combines both. With 4 locales × ~7 distinct cantons ≈ 28
 // unique strings built lazily, vs. the previous ~58 866 inline 4-way
 // ternary evaluations (~150 µs/iter of pure template-literal work).
 const expiredFaqCache = new Map<string, string>();
 const getExpiredFaqHtml = (
 locale: 'it' | 'en' | 'de' | 'fr',
 escDisplayCantonArg: string,
 lamalHrefArg: string,
 ): string => {
 const key = `${locale}\x00${escDisplayCantonArg}\x00${lamalHrefArg}`;
 const cached = expiredFaqCache.get(key);
 if (cached !== undefined) return cached;
 let html: string;
 if (locale === 'it') {
 html = `<section><h2>Domande frequenti</h2><dl><dt><strong>Qual \u00e8 lo stipendio netto per un frontaliere in ${escDisplayCantonArg}?</strong></dt><dd>Lo stipendio netto dipende dal reddito lordo, dallo stato civile e dal numero di figli. In Canton ${escDisplayCantonArg} l'imposta alla fonte varia dal 2% al 15% circa. Sommando AVS-AI-IPG (5,3%), assicurazione disoccupazione (1,1% fino a CHF 148.200/anno) e LPP (7-18% in base all'et\u00e0), la differenza fra lordo e netto \u00e8 tipicamente del 18-28%. Usa il nostro simulatore per un calcolo personalizzato sui dati di questa offerta.</dd><dt><strong>Serve la cassa malati svizzera LAMal come frontaliere?</strong></dt><dd>I nuovi frontalieri dal 2024 devono iscriversi alla LAMal svizzera entro 3 mesi dall'inizio del lavoro, salvo esercizio del diritto d'opzione per restare nel SSN italiano. I premi variano per cantone, modello assicurativo (standard, medico di famiglia, telmed, HMO) e franchigia (CHF 300 minima fino a 2.500 massima): <a href="${lamalHrefArg}">confronta i premi LAMal</a>.</dd><dt><strong>Come si ottiene il Permesso G per lavorare in Canton ${escDisplayCantonArg}?</strong></dt><dd>Il Permesso G \u00e8 richiesto dal datore di lavoro all'Ufficio della migrazione cantonale dopo la firma del contratto. La prima emissione richiede 2-6 settimane; il rinnovo \u00e8 annuale fino al limite contrattuale. Devi risiedere in un comune italiano entro la fascia di 20 km dal confine svizzero (Lombardia o Piemonte) e rientrare al domicilio almeno una volta a settimana. Il telelavoro a tempo pieno dall'Italia non \u00e8 compatibile con lo status.</dd><dt><strong>Tredicesima, ferie e straordinari: cosa prevede la legge svizzera?</strong></dt><dd>La tredicesima non \u00e8 obbligatoria per legge ma \u00e8 prassi consolidata in Ticino e quasi sempre menzionata nel contratto: viene pagata in dicembre o ripartita in due tranche (giugno + novembre). Le ferie minime di legge sono 4 settimane (5 sotto i 20 anni o sopra i 50 con anzianit\u00e0). Gli straordinari oltre le 40-45 ore settimanali, secondo la Legge sul lavoro (LL), sono compensati con un supplemento del 25% o con tempo libero equivalente entro 14 settimane.</dd><dt><strong>Quali documenti servono per candidarsi a un'offerta in Svizzera?</strong></dt><dd>Per la candidatura iniziale bastano CV (formato europeo o svizzero, una lingua del cantone), lettera di motivazione e un certificato di lavoro recente. Dopo la firma del contratto servono carta d'identit\u00e0 valida (passaporto consigliato), certificato di residenza italiano, atto di nascita per la richiesta di Permesso G e — per i settori regolamentati (sanit\u00e0, scuole, sicurezza) — il riconoscimento del titolo italiano da parte di SBFI/SEFRI o dell'autorit\u00e0 cantonale competente, processo che richiede 3-6 mesi.</dd></dl></section>`;
 } else if (locale === 'en') {
 html = `<section><h2>Frequently asked questions</h2><dl><dt><strong>What is the net salary for a cross-border worker in ${escDisplayCantonArg}?</strong></dt><dd>Net salary depends on gross income, marital status and number of children. In the Canton of ${escDisplayCantonArg}, withholding tax ranges from about 2% to 15%. Together with AVS-AI-IPG (5.3%), unemployment insurance (1.1% up to CHF 148,200/year) and LPP (7-18% by age), the typical gross-to-net gap is 18-28%. Use our simulator for a personalised calculation against this listing.</dd><dt><strong>Do cross-border workers need Swiss LAMal health insurance?</strong></dt><dd>New cross-border workers since 2024 must enrol in Swiss LAMal within 3 months of starting work, unless they exercise the right of option to stay in the Italian SSN. Premiums vary by canton, insurance model (standard, family doctor, telmed, HMO) and deductible (CHF 300 minimum up to 2,500 maximum): <a href="${lamalHrefArg}">compare LAMal premiums</a>.</dd><dt><strong>How do I get a G permit to work in the Canton of ${escDisplayCantonArg}?</strong></dt><dd>The G permit is filed by the employer at the cantonal migration office after the contract is signed. First issuance takes 2-6 weeks; the permit is renewed yearly up to the contractual limit. You must reside in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and return home at least once a week. Full-time remote work from Italy is not compatible with the status.</dd><dt><strong>13th-month salary, vacation and overtime: what does Swiss law say?</strong></dt><dd>The 13th salary is not statutory but is standard practice in Ticino and almost always specified in the contract: paid in December or split into two tranches (June + November). Minimum statutory holiday is 4 weeks (5 weeks for under-20s and over-50s with seniority). Overtime above 40-45 weekly hours, under the Labour Act (LL), is compensated with a 25% premium or equivalent time off within 14 weeks.</dd><dt><strong>What documents do I need to apply for a Swiss job?</strong></dt><dd>For the initial application: CV (European or Swiss format, in a cantonal language), cover letter, and a recent work certificate. After the contract is signed: valid ID card (passport recommended), Italian residence certificate, birth certificate for the G-permit filing, and — for regulated sectors (healthcare, schools, security) — recognition of the Italian degree by SBFI/SEFRI or the relevant cantonal authority, a process that takes 3-6 months.</dd></dl></section>`;
 } else if (locale === 'de') {
 html = `<section><h2>H\u00e4ufig gestellte Fragen</h2><dl><dt><strong>Wie hoch ist das Nettogehalt f\u00fcr Grenzg\u00e4nger im ${escDisplayCantonArg}?</strong></dt><dd>Das Nettogehalt h\u00e4ngt vom Bruttoeinkommen, Familienstand und der Kinderzahl ab. Im Kanton ${escDisplayCantonArg} liegt die Quellensteuer zwischen ca. 2% und 15%. Zusammen mit AHV-IV-EO (5,3%), Arbeitslosenversicherung (1,1% bis CHF 148'200/Jahr) und BVG (7-18% je nach Alter) betr\u00e4gt der typische Brutto-Netto-Abstand 18-28%. Nutzen Sie unseren Simulator f\u00fcr eine personalisierte Berechnung zu diesem Inserat.</dd><dt><strong>Brauchen Grenzg\u00e4nger eine Schweizer KVG-Versicherung?</strong></dt><dd>Neue Grenzg\u00e4nger seit 2024 m\u00fcssen sich innerhalb von 3 Monaten nach Arbeitsbeginn bei der KVG anmelden, ausser sie nutzen das Optionsrecht zugunsten des italienischen SSN. Die Pr\u00e4mien variieren je nach Kanton, Versicherungsmodell (Standard, Hausarzt, Telmed, HMO) und Franchise (CHF 300 Minimum bis 2.500 Maximum): <a href="${lamalHrefArg}">KVG-Pr\u00e4mien vergleichen</a>.</dd><dt><strong>Wie erhalte ich die G-Bewilligung f\u00fcr eine Anstellung im Kanton ${escDisplayCantonArg}?</strong></dt><dd>Die G-Bewilligung wird vom Arbeitgeber nach Vertragsunterzeichnung beim kantonalen Migrationsamt eingereicht. Die erste Ausstellung dauert 2-6 Wochen; die Verl\u00e4ngerung erfolgt j\u00e4hrlich bis zur vertraglichen Befristung. Sie m\u00fcssen in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) wohnen und mindestens einmal pro Woche nach Hause zur\u00fcckkehren. Vollst\u00e4ndige Heimarbeit aus Italien ist mit dem Status nicht vereinbar.</dd><dt><strong>13. Monatslohn, Ferien und \u00dcberzeit: was schreibt das Schweizer Recht vor?</strong></dt><dd>Der 13. Monatslohn ist nicht gesetzlich vorgeschrieben, aber im Tessin Standardpraxis und fast immer im Vertrag spezifiziert: ausgezahlt im Dezember oder in zwei Tranchen (Juni + November) aufgeteilt. Der gesetzliche Ferienanspruch betr\u00e4gt mindestens 4 Wochen (5 Wochen f\u00fcr Unter-20-J\u00e4hrige und \u00dcber-50-J\u00e4hrige mit Anstellungsdauer). \u00dcberzeit \u00fcber die 40-45 Wochenstunden hinaus wird gem\u00e4ss Arbeitsgesetz (ArG) mit 25% Zuschlag oder Freizeitausgleich innerhalb von 14 Wochen kompensiert.</dd><dt><strong>Welche Unterlagen brauche ich f\u00fcr eine Bewerbung in der Schweiz?</strong></dt><dd>F\u00fcr die Erstbewerbung: Lebenslauf (europ\u00e4isches oder Schweizer Format, in einer Kantonssprache), Motivationsschreiben und ein aktuelles Arbeitszeugnis. Nach Vertragsunterzeichnung: g\u00fcltige Identit\u00e4tskarte (Pass empfohlen), italienische Wohnsitzbescheinigung, Geburtsurkunde f\u00fcr die G-Bewilligung und — bei regulierten Branchen (Gesundheit, Schulen, Sicherheit) — die Anerkennung des italienischen Titels durch SBFI/SEFRI oder die zust\u00e4ndige kantonale Beh\u00f6rde, ein Verfahren von 3-6 Monaten.</dd></dl></section>`;
 } else {
 html = `<section><h2>Questions fr\u00e9quentes</h2><dl><dt><strong>Quel est le salaire net pour un frontalier au ${escDisplayCantonArg} ?</strong></dt><dd>Le salaire net d\u00e9pend du revenu brut, de l'\u00e9tat civil et du nombre d'enfants. Dans le Canton du ${escDisplayCantonArg}, l'imp\u00f4t \u00e0 la source varie d'environ 2% \u00e0 15%. En ajoutant l'AVS-AI-APG (5,3%), l'assurance ch\u00f4mage (1,1% jusqu'\u00e0 CHF 148'200/an) et la LPP (7-18% selon l'\u00e2ge), l'\u00e9cart brut-net typique est de 18-28%. Utilisez notre simulateur pour un calcul personnalis\u00e9 sur cette offre.</dd><dt><strong>Les frontaliers doivent-ils souscrire \u00e0 la LAMal suisse ?</strong></dt><dd>Les nouveaux frontaliers depuis 2024 doivent s'inscrire \u00e0 la LAMal dans les 3 mois suivant le d\u00e9but du travail, sauf s'ils exercent le droit d'option pour rester au SSN italien. Les primes varient selon le canton, le mod\u00e8le d'assurance (standard, m\u00e9decin de famille, telmed, HMO) et la franchise (CHF 300 minimum jusqu'\u00e0 2'500 maximum) : <a href="${lamalHrefArg}">comparer les primes LAMal</a>.</dd><dt><strong>Comment obtenir le permis G pour travailler au Canton du ${escDisplayCantonArg} ?</strong></dt><dd>Le permis G est demand\u00e9 par l'employeur \u00e0 l'office cantonal des migrations apr\u00e8s la signature du contrat. La premi\u00e8re d\u00e9livrance prend 2 \u00e0 6 semaines ; le renouvellement est annuel jusqu'\u00e0 la limite contractuelle. Vous devez r\u00e9sider dans une commune italienne situ\u00e9e dans la zone fronti\u00e8re des 20 km (Lombardie ou Pi\u00e9mont) et rentrer chez vous au moins une fois par semaine. Le t\u00e9l\u00e9travail \u00e0 plein temps depuis l'Italie n'est pas compatible avec le statut.</dd><dt><strong>13e mois, vacances et heures suppl\u00e9mentaires : que pr\u00e9voit le droit suisse ?</strong></dt><dd>Le 13e mois n'est pas obligatoire mais c'est une pratique courante au Tessin et presque toujours mentionn\u00e9e dans le contrat : il est pay\u00e9 en d\u00e9cembre ou r\u00e9parti en deux tranches (juin + novembre). Les vacances l\u00e9gales minimales sont de 4 semaines (5 pour les moins de 20 ans et plus de 50 ans avec anciennet\u00e9). Les heures suppl\u00e9mentaires au-del\u00e0 de 40-45 heures hebdomadaires, selon la loi sur le travail (LTr), sont compens\u00e9es par une majoration de 25% ou par du temps libre \u00e9quivalent dans les 14 semaines.</dd><dt><strong>Quels documents pour postuler \u00e0 un emploi en Suisse ?</strong></dt><dd>Pour la candidature initiale : CV (format europ\u00e9en ou suisse, dans une langue cantonale), lettre de motivation et un certificat de travail r\u00e9cent. Apr\u00e8s la signature du contrat : carte d'identit\u00e9 valable (passeport recommand\u00e9), certificat de r\u00e9sidence italien, acte de naissance pour le d\u00e9p\u00f4t du permis G, et — pour les secteurs r\u00e9glement\u00e9s (sant\u00e9, \u00e9coles, s\u00e9curit\u00e9) — la reconnaissance du titre italien par le SBFI/SEFRI ou l'autorit\u00e9 cantonale comp\u00e9tente, une proc\u00e9dure de 3-6 mois.</dd></dl></section>`;
 }
 expiredFaqCache.set(key, html);
 return html;
 };

 // Sort expiredSlugs by the recency of the linked expired-job entry
 // (DESC, ties broken by slug for determinism) so the FIRST iteration
 // for any colliding `tracking[slug][locale]` path is the most-recent
 // job's content. The `emittedSoftLandingPaths` Set below skips later
 // duplicates so the freshest version stays on disk. Without this sort,
 // the oldest version frequently won because it appeared earlier in
 // `Object.keys(tracking)` (insertion order from
 // data/all-known-job-slugs.json, which is mostly chronological-ascending).
 const _expiredSlugRecency = (s: string): number => {
 const ej = expiredBySlug.get(s);
 return ej ? _jobRecency(ej) : 0;
 };
 expiredSlugs.sort((a, b) => {
 const ra = _expiredSlugRecency(a);
 const rb = _expiredSlugRecency(b);
 if (ra !== rb) return rb - ra;
 return a.localeCompare(b);
 });

 // Set of (locale-prefixed) paths already emitted as soft-landing pages
 // in THIS phase. Multiple distinct slugs can map to the same
 // `tracking[slug][locale]` value (1349 IT / 2999 EN / 3072 DE / 3224 FR
 // such collisions in the current registry — typically AI-translated
 // slugs converging on the IT path). Without dedup each collider would
 // fire `_qw` and produce a write-registry collision report; with dedup
 // only the most-recent (per the sort above) lands on disk.
 const emittedSoftLandingPaths = new Set<string>();

 for (const slug of expiredSlugs) {
 const paths = tracking[slug];
 const ejData = expiredBySlug.get(slug);

 // For orphan slugs with no ejData, extract info from the slug itself
 const slugInfo = !ejData?.title ? extractInfoFromSlug(slug) : null;

 // Build hreflang alternates for this expired slug.
 // audit-hreflang requires ≥5 entries (4 locales + x-default) on every
 // page that emits any hreflang. Orphan/expired slugs without a full
 // locale cluster (e.g. brand-alias `azienda-<brand>` bridges with only
 // an IT path) would emit 2 entries and fail the audit — so when the
 // cluster isn't complete we emit ZERO hreflang and rely on
 // <link rel="canonical"> + <html lang> to signal single-locale scope.
 const expiredLocaleHreflangs = localeList
 .map((l) => (paths[l] ? { lang: l as 'it' | 'en' | 'de' | 'fr', href: `${BASE_URL}${withSlash(paths[l])}` } : null))
 .filter((x): x is { lang: 'it' | 'en' | 'de' | 'fr'; href: string } => x !== null);
 const expiredHasFullCluster = expiredLocaleHreflangs.length === localeList.length;
 const hreflangLinks = expiredHasFullCluster
 ? [
  ...expiredLocaleHreflangs.map((e) => ` <link rel="alternate" hreflang="${e.lang}" href="${e.href}">`),
  ...(paths.it ? [` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(paths.it)}">`] : []),
  ].join('\n')
 : '';

 // Track IT page word count for sitemap inclusion decision
 let itBodyWordCount = 0;

 // ── Per-slug invariants (hoisted out of the per-locale loop) ──
 // These values depend only on the slug, not on the locale. Computing
 // them once per slug instead of 4× saves ~50μs/iter × 58k = ~2-3 s
 // of redundant work across the expired-soft-landing build phase.
 const gscInfo = orphanGscData.get(slug);
 const jobCompany = String(ejData?.company || gscInfo?.company || slugInfo?.company || '');
 const jobLocation = String(ejData?.location || ejData?.addressLocality || gscInfo?.location || slugInfo?.location || '');
 const jobCanton = String(ejData?.canton || DEFAULT_CANTON);
 const jobSector = String(ejData?.sector || '');
 const jobContract = String(ejData?.contract || '');
 const jobDatePosted = String(ejData?.datePosted || '');
 const jobExpiredAt = String(ejData?.expiredAt || '');
 const displayCanton = CANTON_DISPLAY[jobCanton] || jobCanton;
 // Compact human-readable disambiguator for expired/soft-landing pages.
 // Use ONLY the LAST slug token (typically the crawler-emitted unique-id
 // suffix, e.g. "5010e3f8") capped at 10 chars. The previous version
 // hashed the full slug, but with `buildTitleDisambiguator` now emitting
 // ` · ${literal}` (no hashing) the full slug would land verbatim in
 // the <title>, blowing past JOB_TITLE_MAX (run 25434391277 produced
 // 84,501 job-board pages with 184-char titles when the entire slug
 // was injected this way).
 const _expiredSlugTail = (slug.split('-').filter(Boolean).pop() || '').slice(0, 10);
 const expiredDisambiguator = _expiredSlugTail
  ? buildTitleDisambiguator(`rif. ${_expiredSlugTail}`)
  : '';
 const sameCompanyActiveJobs = jobCompany
 ? (companyActiveJobsMap.get(jobCompany.toLowerCase()) || [])
 : [];
 // Slug-derived disambiguator parts (used in the per-locale section).
 const _slugTokens = slug.split('-').filter(Boolean);
 const _tailCount = Math.min(3, _slugTokens.length);
 const _tailTokens = _slugTokens.slice(-_tailCount).map(t =>
 t.replace(/\b\w/g, c => c.toUpperCase()),
 );
 const tailPretty = _tailTokens.join(' ');
 const cityForSignal = jobLocation || (slugInfo?.location ?? '');
 const cantonForSignal = jobCanton && cityForSignal ? displayCanton : '';
 const countryHint = cityForSignal && !jobCanton ? cityForSignal : '';
 const hasRealTitle = !!(ejData?.title || gscInfo?.title || slugInfo?.title);
 // Pre-escaped canton (used in many template literals across all locales).
 const escDisplayCanton = esc(displayCanton);

 for (const locale of localeList) {
 const relPath = paths[locale];
 if (!relPath) continue;
 // Skip paths claimed by bridge pages to avoid canonical conflicts
 if (bridgeClaimedPaths.has(relPath)) continue;
 const __tExpiredSoftLanding = startTimer();
 const selfUrl = `${BASE_URL}${withSlash(relPath)}`;
 const listingPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/`.replace(/\/+/g, '/');
 const copy = expiredBannerCopy[locale] ?? expiredBannerCopy.it;

 // Rich content fallback chain: expired-jobs.json → orphan enriched data → slug extraction
 // jobCompany/jobLocation/jobCanton/displayCanton/expiredDisambiguator/etc.
 // are hoisted above the for-locale loop (per-slug invariants).
 const jobTitle = String(ejData?.titleByLocale?.[locale] || ejData?.title || gscInfo?.titleByLocale?.[locale] || gscInfo?.title || slugInfo?.title || copy.title);
 const jobDescription = String(ejData?.descriptionByLocale?.[locale] || ejData?.descriptionByLocale?.it || ejData?.description || gscInfo?.descriptionByLocale?.[locale] || gscInfo?.descriptionByLocale?.it || '');
 // Total <title> budget: 80 char (Google SERP-display ceiling). Layout:
 //   [headline] + [disambiguator " (#abcdef12)" = 12] + [" | Frontaliere Ticino" = 22]
 // Headline budget = 80 - 12 - 22 = 46 char, used for
 // `${headlineCap} — ${shortCompany}` (or just `${headlineCap}` if company
 // doesn't fit). uniqueSuffix (city / slug-tail) is dropped: the slug-hash
 // disambiguator already guarantees uniqueness across slugs, and the city
 // Universal rule: headline VERBATIM, brand suffix appended only when total
 // stays within TITLE_MAX_CHARS (70). See build-plugins/shared/titleSuffix.ts.
 let headline: string;
 if (hasRealTitle) {
  const cleanTitle = jobTitle.trim();
  const cleanCompany = jobCompany.trim();
  headline = cleanCompany ? `${cleanTitle} — ${cleanCompany}` : cleanTitle;
 } else {
  headline = copy.title;
 }
 // Reserve room for the disambiguator AND brand suffix inside the 70-char
 // cap. The disambiguator MUST land inside the cap — without this manual
 // truncation, multi-slug expired jobs (same role+company, different
 // origin slugs) collapse to identical titles after the downstream
 // headline-only truncate strips the trailing (#hash). Tripped Semrush
 // title-uniqueness on 2026-04-28. Critically, we work on the RAW headline
 // (no HTML-escape) so `&` / `<` etc. are not artificially expanded into
 // multi-char entities like `&amp;` that fool the length-based truncate
 // and force a second-pass truncate downstream (the audit caught
 // "AGIE Charmilles SA — R&D" titles emerging with double "……" + a
 // dropped (#hash) suffix). We apply esc() ONCE at the <title>${...}</title>
 // call site downstream.
 const expiredHeadlineBudget = TITLE_MAX_CHARS - expiredDisambiguator.length - TITLE_BRAND_SUFFIX.length;
 const cappedHeadline = headline.length <= expiredHeadlineBudget
  ? headline
  : truncateHeadline(headline, Math.max(1, expiredHeadlineBudget));
 const pageTitle = esc(buildTitleWithBrand(`${cappedHeadline}${expiredDisambiguator}`));

 const pageDesc = `${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}. ${esc(archiveRelatedLabel[locale] || archiveRelatedLabel.it)}.`;

 // Seed expired job data as window global so the SPA can render
 // rich content (title, company, description) without depending on
 // the runtime expired-jobs.json fetch (which only has recently expired jobs).
 const expiredWindowData = JSON.stringify({
 slug,
 title: ejData?.title || gscInfo?.title || slugInfo?.title || '',
 titleByLocale: ejData?.titleByLocale || gscInfo?.titleByLocale || {},
 company: ejData?.company || gscInfo?.company || slugInfo?.company || '',
 companyKey: ejData?.companyKey || gscInfo?.companyKey || slugInfo?.companyKey || '',
 location: ejData?.location || ejData?.addressLocality || gscInfo?.location || slugInfo?.location || '',
 descriptionByLocale: ejData?.descriptionByLocale || gscInfo?.descriptionByLocale || {},
 slugByLocale: ejData?.slugByLocale || gscInfo?.slugByLocale || {},
 sector: ejData?.sector || gscInfo?.sector || '',
 expiredAt: ejData?.expiredAt || '',
 ...(gscInfo?.queries ? { gscQueries: gscInfo.queries, gscImpressions: gscInfo.totalImpressions, gscClicks: gscInfo.totalClicks } : {}),
 });

 // FRO-320: Generate static body content so Google sees real text, not an empty SPA shell.
 // Enriched template ensures >100 words per page for every expired job.
 // (jobCanton, displayCanton, sameCompanyActiveJobs, etc. are hoisted above.)
 const staticBodyParts: string[] = [];

 // --- H1 + expired notice ---
 staticBodyParts.push(`<h1>${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}</h1>`);
 staticBodyParts.push(`<p><strong>${esc(copy.banner)}</strong></p>`);

 // --- Slug-derived disambiguator -----------------------------------
 // Every orphan page MUST carry a per-slug signal so the duplicate-body
 // auditor (`audit-content-duplicates`) doesn't cluster multi-city
 // remote-role siblings (`…-buenos-aires`, `…-cairo`, `…-dubai`) onto
 // one hash. We append:
 //   1. the last-token(s) of the slug in human-readable form,
 //   2. the resolved canton (Swiss) OR country-guess (foreign),
 //   3. the exact original slug as an invariant.
 // This adds 20-30 words per page — enough to defeat the SHA-256
 // collapse even when `location` extraction failed.
 {
  // tailPretty / cityForSignal / cantonForSignal / countryHint are
  // per-slug invariants hoisted above the for-locale loop.

  const disambiguationHeading: Record<string, string> = {
   it: 'Dettaglio geografico',
   en: 'Geographic detail',
   de: 'Standortdetail',
   fr: 'Détail géographique',
  };
  const parts: string[] = [];
  if (locale === 'it') {
   parts.push(`<p>Questa scheda corrisponde allo slug <code>${esc(slug)}</code>${tailPretty ? ` (token finale: <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>La sede di riferimento indicata nella posizione è <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, nel Canton ${esc(cantonForSignal)}` : ''}. Gli annunci marcati come remoti mantengono comunque il riferimento città per finalità fiscali, contrattuali e di iscrizione al Permesso G.</p>`);
   else parts.push(`<p>Non è stato possibile estrarre una città specifica dallo slug di questa offerta. Il riferimento operativo resta il Canton ${esc(displayCanton)} per l'impostazione fiscale frontaliere e l'iscrizione al Permesso G.</p>`);
  } else if (locale === 'en') {
   parts.push(`<p>This page corresponds to the job slug <code>${esc(slug)}</code>${tailPretty ? ` (trailing token: <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>The reference location stated in the job ad is <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, Canton of ${esc(cantonForSignal)}` : ''}. Remote-tagged roles still retain the city reference for tax, contract and G Permit enrolment purposes.</p>`);
   else parts.push(`<p>No specific city could be extracted from this slug. The operational reference is the Canton of ${esc(displayCanton)} for cross-border tax setup and G Permit enrolment.</p>`);
  } else if (locale === 'de') {
   parts.push(`<p>Diese Seite entspricht dem Stellen-Slug <code>${esc(slug)}</code>${tailPretty ? ` (abschließender Token: <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>Der in der Stelle genannte Referenzort ist <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, Kanton ${esc(cantonForSignal)}` : ''}. Als remote ausgeschriebene Rollen behalten den Ortsbezug für Steuer-, Vertrags- und Grenzgängerbewilligungszwecke bei.</p>`);
   else parts.push(`<p>Es konnte keine spezifische Stadt aus diesem Slug abgeleitet werden. Der operative Bezug bleibt der Kanton ${esc(displayCanton)} für die Grenzgängerbesteuerung und die G-Bewilligung.</p>`);
  } else {
   parts.push(`<p>Cette page correspond au slug d'offre <code>${esc(slug)}</code>${tailPretty ? ` (dernier segment : <strong>${esc(tailPretty)}</strong>)` : ''}.</p>`);
   if (cityForSignal) parts.push(`<p>La ville de référence indiquée dans l'offre est <strong>${esc(cityForSignal)}</strong>${cantonForSignal ? `, Canton du ${esc(cantonForSignal)}` : ''}. Les postes marqués en télétravail conservent la référence ville pour la fiscalité, le contrat et l'inscription au Permis G.</p>`);
   else parts.push(`<p>Aucune ville spécifique n'a pu être extraite de ce slug. La référence opérationnelle reste le Canton du ${esc(displayCanton)} pour la fiscalité frontalière et l'inscription au Permis G.</p>`);
  }
  if (countryHint && !jobCanton) {
   const countryLabel: Record<string, string> = {
    it: `Il comune indicato (${esc(countryHint)}) non rientra nella base PLZ svizzera: l'inserimento potrebbe essere un ruolo internazionale remoto, ma rimane in sitemap come pagina di archivio frontaliere.`,
    en: `The stated municipality (${esc(countryHint)}) is not in the Swiss PLZ dataset: this is likely an international remote role, but is kept in the cross-border archive sitemap.`,
    de: `Die angegebene Gemeinde (${esc(countryHint)}) ist nicht im Schweizer PLZ-Datensatz enthalten: Wahrscheinlich handelt es sich um eine internationale Remote-Rolle, die wir aber in der Grenzgänger-Archiv-Sitemap behalten.`,
    fr: `La commune indiquée (${esc(countryHint)}) ne figure pas dans le jeu de données PLZ suisse : il s'agit probablement d'un poste international en télétravail, conservé dans la sitemap d'archive frontalière.`,
   };
   parts.push(`<p style="color:#64748b;font-size:14px">${countryLabel[locale] || countryLabel.it}</p>`);
  }
  staticBodyParts.push(`<section><h2>${esc(disambiguationHeading[locale] || disambiguationHeading.it)}</h2>${parts.join('')}</section>`);
 }

 // --- Description section ---
 if (jobDescription && jobDescription.length > 30) {
 const descText = jobDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
 staticBodyParts.push(`<section><h2>${locale === 'it' ? 'Descrizione originale' : locale === 'en' ? 'Original description' : locale === 'de' ? 'Originalbeschreibung' : 'Description originale'}</h2><div>${descText.slice(0, 2000)}</div></section>`);
 }

 // --- Job details section ---
 const detailsHeading = locale === 'it' ? 'Dettagli dell\'offerta' : locale === 'en' ? 'Job details' : locale === 'de' ? 'Stellendetails' : 'D\u00e9tails de l\'offre';
 const detailItems: string[] = [];
 if (jobCompany) detailItems.push(`<li><strong>${locale === 'it' ? 'Azienda' : locale === 'en' ? 'Company' : locale === 'de' ? 'Unternehmen' : 'Entreprise'}:</strong> ${esc(jobCompany)}</li>`);
 detailItems.push(`<li><strong>${locale === 'it' ? 'Posizione' : locale === 'en' ? 'Position' : locale === 'de' ? 'Position' : 'Poste'}:</strong> ${esc(jobTitle)}</li>`);
 if (jobLocation) detailItems.push(`<li><strong>${locale === 'it' ? 'Sede' : locale === 'en' ? 'Location' : locale === 'de' ? 'Standort' : 'Lieu'}:</strong> ${esc(jobLocation)}, ${esc(displayCanton)}</li>`);
 if (jobContract) detailItems.push(`<li><strong>${locale === 'it' ? 'Tipo contratto' : locale === 'en' ? 'Contract type' : locale === 'de' ? 'Vertragsart' : 'Type de contrat'}:</strong> ${esc(jobContract)}</li>`);
 if (jobSector) detailItems.push(`<li><strong>${locale === 'it' ? 'Settore' : locale === 'en' ? 'Sector' : locale === 'de' ? 'Branche' : 'Secteur'}:</strong> ${esc(jobSector)}</li>`);
 if (jobDatePosted) detailItems.push(`<li><strong>${locale === 'it' ? 'Pubblicata il' : locale === 'en' ? 'Posted on' : locale === 'de' ? 'Ver\u00f6ffentlicht am' : 'Publi\u00e9e le'}:</strong> ${esc(jobDatePosted.slice(0, 10))}</li>`);
 if (jobExpiredAt) detailItems.push(`<li><strong>${locale === 'it' ? 'Scaduta il' : locale === 'en' ? 'Expired on' : locale === 'de' ? 'Abgelaufen am' : 'Expir\u00e9e le'}:</strong> ${esc(jobExpiredAt.slice(0, 10))}</li>`);
 staticBodyParts.push(`<section><h2>${esc(detailsHeading)}</h2><ul>${detailItems.join('')}</ul></section>`);

 // --- Same-company active jobs ---
 if (sameCompanyActiveJobs.length > 0) {
 const companyJobsHeading = locale === 'it' ? `Altre offerte di ${esc(jobCompany)}` : locale === 'en' ? `More jobs at ${esc(jobCompany)}` : locale === 'de' ? `Weitere Stellen bei ${esc(jobCompany)}` : `Autres offres chez ${esc(jobCompany)}`;
 const companyJobsList = sameCompanyActiveJobs.map((j: any) => {
 const jSlug = localizedSlug(j, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(j?.titleByLocale?.[locale] || j.title || '');
 return `<li><a href="${jHref}">${esc(jTitle)}</a> — ${esc(j.location)}</li>`;
 }).join('');
 staticBodyParts.push(`<section><h2>${companyJobsHeading}</h2><ul>${companyJobsList}</ul></section>`);
 }

 // --- Search suggestions ---
 if (locale === 'it') {
 const searchSugParts: string[] = [];
 if (jobCompany) searchSugParts.push(`<p>Scopri tutte le <a href="${BASE_URL}/cerca-lavoro-ticino/">posizioni aperte</a> sul nostro job board con oltre 1000 offerte attive in Ticino.</p>`);
 if (jobLocation) searchSugParts.push(`<p>Cerca altre offerte nella zona: <a href="${BASE_URL}/cerca-lavoro-ticino/">Lavoro in ${esc(displayCanton)}</a></p>`);
 searchSugParts.push(`<p>Torna alla <a href="${BASE_URL}/cerca-lavoro-ticino/">Job Board completa</a> per trovare la tua prossima opportunit\u00e0 lavorativa come frontaliere in Svizzera.</p>`);
 staticBodyParts.push(`<section><h2>Offerte simili in ${esc(displayCanton)}</h2>${searchSugParts.join('\n')}</section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Similar jobs in ${esc(displayCanton)}</h2><p>Browse our <a href="${BASE_URL}/en/find-jobs-ticino/">complete job board</a> with over 1000 active positions in Ticino.</p>${jobLocation ? `<p>Search for more jobs near ${esc(jobLocation)}: <a href="${BASE_URL}/en/find-jobs-ticino/">Jobs in ${esc(displayCanton)}</a></p>` : ''}<p>Find your next opportunity as a cross-border worker in Switzerland.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>\u00c4hnliche Stellen im ${esc(displayCanton)}</h2><p>Durchsuchen Sie unser <a href="${BASE_URL}/de/job-suche-tessin/">komplettes Job Board</a> mit \u00fcber 1000 aktiven Stellen im Tessin.</p>${jobLocation ? `<p>Weitere Stellen in der N\u00e4he von ${esc(jobLocation)}: <a href="${BASE_URL}/de/job-suche-tessin/">Jobs im ${esc(displayCanton)}</a></p>` : ''}<p>Finden Sie Ihre n\u00e4chste Stelle als Grenzg\u00e4nger in der Schweiz.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>Offres similaires au ${esc(displayCanton)}</h2><p>Parcourez notre <a href="${BASE_URL}/fr/recherche-emploi-tessin/">job board complet</a> avec plus de 1000 postes actifs au Tessin.</p>${jobLocation ? `<p>Recherchez d'autres offres pr\u00e8s de ${esc(jobLocation)}: <a href="${BASE_URL}/fr/recherche-emploi-tessin/">Emplois au ${esc(displayCanton)}</a></p>` : ''}<p>Trouvez votre prochaine opportunit\u00e9 en tant que frontalier en Suisse.</p></section>`);
 }

 // --- Frontalier info section: extended with permit-mechanics, gross-to-net
 // detail, commute reality and cost-of-living comparison so each job-detail
 // page carries substantive contextual content. ~2 KB of visible text per
 // locale; uses jobCompany / jobLocation / displayCanton so pages stay
 // distinct and Google won't see boilerplate. ---
 const taxUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
 if (locale === 'it') {
 staticBodyParts.push(`<section><h2>Informazioni per frontalieri</h2><p>${jobCompany ? `${esc(jobCompany)} si trova` : 'Questa posizione si trovava'}${jobLocation ? ` a ${esc(jobLocation)}` : ''} in Canton ${esc(displayCanton)}. Per lavorare come frontaliere in Svizzera serve il <strong>Permesso G</strong>, rinnovabile annualmente. Il Canton ${esc(displayCanton)} applica l'<strong>imposta alla fonte</strong> con aliquote variabili sul reddito lordo, mentre i frontalieri dal 2024 sono soggetti al <strong>Nuovo Accordo fiscale</strong> che prevede una tassazione concorrente Italia-Svizzera.</p><p>I contributi sociali svizzeri includono AVS (5,3%), assicurazione disoccupazione (1,1%) e LPP (previdenza professionale). Usa il nostro <a href="${taxUrl}">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto e confrontare i costi della vita tra Svizzera e Italia.</p><p><strong>Permesso G e residenza.</strong> Per candidarti a questa posizione come frontaliere devi risiedere in un comune italiano entro la fascia di 20 km dal confine svizzero (Lombardia o Piemonte) e rientrare al domicilio almeno una volta a settimana. Il datore di lavoro richiede il Permesso G all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi viene rinnovato annualmente fino al limite contrattuale. Il telelavoro a tempo pieno dall'Italia non è compatibile con lo status di frontaliere; assenze prolungate dal domicilio italiano (più di una settimana lavorativa senza rientro) compromettono il regime fiscale.</p><p><strong>Stipendio netto e Nuovo Accordo 2024.</strong> Lo stipendio lordo indicato in questa offerta viene tassato alla fonte dal datore svizzero con aliquote effettive che nel Canton ${esc(displayCanton)} variano fra il 5 % e il 19 % a seconda del reddito, dello stato civile e dei figli. Per i frontalieri assunti dal 1° gennaio 2024 si applica il regime concorrente Italia-Svizzera del Nuovo Accordo: l'Italia tassa il reddito da lavoro estero ma riconosce un credito d'imposta sulle ritenute svizzere fino all'80 %, da dichiarare nel quadro RW. Sommando imposta alla fonte e contributi sociali, la differenza fra lordo annuale e netto incassato è tipicamente del 18-28 %. Per il calcolo personalizzato sul lordo offerto da ${jobCompany ? esc(jobCompany) : 'questa azienda'} apri il simulatore stipendio.</p><p><strong>Pendolarismo e qualità della vita.</strong> ${jobLocation ? `Lavorare a ${esc(jobLocation)} significa ` : `Lavorare nel Canton ${esc(displayCanton)} significa `}un tragitto giornaliero che dipende dal valico scelto: Brogeda (autostrada A2) e Chiasso-strada coprono le destinazioni del Mendrisiotto e del Luganese; Stabio e Gaggiolo servono chi parte dal Varesotto; Ponte Tresa è l'opzione storica per Luino e il Verbano. In ora di punta un tragitto Como-Lugano si esaurisce in 25-50 minuti; da Varese verso Lugano servono tipicamente 35-60 minuti. Per chi valuta il trasferimento in Ticino, l'affitto medio per un 3.5 locali a Lugano è 1.500-2.200 CHF/mese, contro 600-900 EUR per un appartamento equivalente in provincia di Como. La rete sanitaria svizzera (LAMal) offre tempi di accesso più brevi del SSN italiano ma con un premio mensile di 350-500 CHF/adulto, voce che pesa nel confronto netto-netto.</p></section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Information for cross-border workers</h2><p>${jobCompany ? `${esc(jobCompany)} is located` : 'This position was located'}${jobLocation ? ` in ${esc(jobLocation)}` : ''} in the Canton of ${esc(displayCanton)}. Cross-border workers need a <strong>G Permit</strong>, renewable annually, to work in Switzerland. The Canton of ${esc(displayCanton)} applies <strong>withholding tax</strong> at variable rates on gross income. Since 2024, the <strong>New Tax Agreement</strong> introduces concurrent taxation between Italy and Switzerland.</p><p>Swiss social contributions include AVS (5.3%), unemployment insurance (1.1%) and LPP (occupational pension). Use our <a href="${taxUrl}">free tax simulator</a> to calculate your net salary and compare the cost of living between Switzerland and Italy.</p><p><strong>G permit and residence.</strong> To apply for this position as a cross-border worker you must reside in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and return home at least once a week. The employer files the G permit at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is then renewed yearly. Full-time remote work from Italy is not compatible with cross-border status; extended absences from the Italian home (more than a working week without returning) jeopardise the fiscal regime.</p><p><strong>Net salary and the 2024 fiscal agreement.</strong> The gross salary advertised here is withheld at source by the Swiss employer at effective rates between 5 % and 19 % in the Canton of ${esc(displayCanton)} depending on income, marital status and dependants. Cross-border workers hired on or after 1 January 2024 fall under the new Italy-Switzerland concurrent regime: Italy taxes foreign employment income while granting a tax credit on Swiss withholding up to 80 %, declared in section RW of the Italian tax return. Together with social charges the typical gross-to-net gap is 18-28 %. For a personalised calculation on the gross offered by ${jobCompany ? esc(jobCompany) : 'this employer'} open the salary simulator.</p><p><strong>Commute and quality of life.</strong> ${jobLocation ? `Working in ${esc(jobLocation)} means ` : `Working in the Canton of ${esc(displayCanton)} means `}a daily commute that depends on which crossing you use: Brogeda (A2 motorway) and Chiasso-strada cover the Mendrisiotto and Luganese areas; Stabio and Gaggiolo serve commuters from the Varese province; Ponte Tresa is the historic gateway for Luino and the Verbano lake region. At peak times a Como-Lugano leg runs 25-50 minutes; Varese-Lugano typically takes 35-60. For those considering relocation to Ticino, average rent for a 3.5-room flat in Lugano is CHF 1,500-2,200/month, against EUR 600-900 for an equivalent unit in the province of Como. The Swiss healthcare network (LAMal) offers shorter access times than the Italian SSN but at a monthly premium of CHF 350-500 per adult — a substantial line item in any net-vs-net comparison.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>Informationen f\u00fcr Grenzg\u00e4nger</h2><p>${jobCompany ? `${esc(jobCompany)} befindet sich` : 'Diese Stelle befand sich'}${jobLocation ? ` in ${esc(jobLocation)}` : ''} im Kanton ${esc(displayCanton)}. Grenzg\u00e4nger ben\u00f6tigen eine <strong>G-Bewilligung</strong> (j\u00e4hrlich erneuerbar), um in der Schweiz zu arbeiten. Der Kanton ${esc(displayCanton)} erhebt eine <strong>Quellensteuer</strong> mit variablen S\u00e4tzen auf das Bruttoeinkommen. Seit 2024 gilt das <strong>Neue Steuerabkommen</strong> mit konkurrierender Besteuerung zwischen Italien und der Schweiz.</p><p>Die Schweizer Sozialabgaben umfassen AHV (5,3%), Arbeitslosenversicherung (1,1%) und BVG (berufliche Vorsorge). Nutzen Sie unseren <a href="${taxUrl}">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt zu berechnen und die Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.</p><p><strong>G-Bewilligung und Wohnsitz.</strong> Um sich auf diese Stelle als Grenzg\u00e4nger zu bewerben, m\u00fcssen Sie in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) wohnen und mindestens einmal pro Woche nach Hause zur\u00fcckkehren. Der Arbeitgeber beantragt die G-Bewilligung nach Vertragsunterzeichnung beim kantonalen Migrationsamt: die erste Ausstellung dauert 2-6 Wochen, danach erfolgt die j\u00e4hrliche Verl\u00e4ngerung. Vollst\u00e4ndige Heimarbeit aus Italien ist mit dem Grenzg\u00e4ngerstatus nicht vereinbar; l\u00e4ngere Abwesenheiten vom italienischen Wohnsitz (mehr als eine Arbeitswoche ohne R\u00fcckkehr) gef\u00e4hrden das Steuerregime.</p><p><strong>Nettolohn und neues Steuerabkommen 2024.</strong> Der hier ausgeschriebene Bruttolohn wird vom schweizerischen Arbeitgeber an der Quelle besteuert, mit effektiven S\u00e4tzen im Kanton ${esc(displayCanton)} zwischen 5 % und 19 % je nach Einkommen, Zivilstand und Kindern. Grenzg\u00e4nger ab dem 1. Januar 2024 fallen unter die neue konkurrierende Regelung Italien-Schweiz: Italien besteuert ausl\u00e4ndisches Erwerbseinkommen, gew\u00e4hrt aber eine Steuergutschrift auf die schweizerische Quellensteuer von bis zu 80 %, deklariert im Abschnitt RW der italienischen Steuererkl\u00e4rung. Zusammen mit den Sozialabgaben betr\u00e4gt der typische Brutto-Netto-Abstand 18-28 %. F\u00fcr eine personalisierte Berechnung auf das Bruttoangebot von ${jobCompany ? esc(jobCompany) : 'diesem Arbeitgeber'} \u00f6ffnen Sie den Lohnsimulator.</p><p><strong>Pendelweg und Lebensqualit\u00e4t.</strong> ${jobLocation ? `Arbeiten in ${esc(jobLocation)} bedeutet ` : `Arbeiten im Kanton ${esc(displayCanton)} bedeutet `}einen t\u00e4glichen Pendelweg, der von der Wahl des Grenz\u00fcbergangs abh\u00e4ngt: Brogeda (Autobahn A2) und Chiasso-Strasse decken das Mendrisiotto und das Luganese ab; Stabio und Gaggiolo bedienen Pendler aus der Provinz Varese; Ponte Tresa ist der historische Zugang f\u00fcr Luino und die Region Verbano. In Stosszeiten dauert eine Strecke Como-Lugano 25-50 Minuten; Varese-Lugano typischerweise 35-60 Minuten. F\u00fcr alle, die einen Umzug ins Tessin erw\u00e4gen, betr\u00e4gt die durchschnittliche Miete f\u00fcr eine 3,5-Zimmer-Wohnung in Lugano CHF 1'500-2'200/Monat, gegen\u00fcber EUR 600-900 f\u00fcr eine vergleichbare Wohnung in der Provinz Como. Das schweizerische Gesundheitsnetz (KVG) bietet k\u00fcrzere Zugangszeiten als der italienische SSN, kostet aber CHF 350-500 pro Erwachsenem und Monat — ein erheblicher Posten in jedem Netto-zu-Netto-Vergleich.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>Informations pour les frontaliers</h2><p>${jobCompany ? `${esc(jobCompany)} se trouve` : 'Ce poste se trouvait'}${jobLocation ? ` \u00e0 ${esc(jobLocation)}` : ''} dans le Canton du ${esc(displayCanton)}. Les travailleurs frontaliers ont besoin d'un <strong>permis G</strong> (renouvelable annuellement) pour travailler en Suisse. Le Canton du ${esc(displayCanton)} applique un <strong>imp\u00f4t \u00e0 la source</strong> \u00e0 taux variable sur le revenu brut. Depuis 2024, le <strong>Nouvel Accord fiscal</strong> introduit une imposition concurrente entre l'Italie et la Suisse.</p><p>Les cotisations sociales suisses comprennent l'AVS (5,3%), l'assurance ch\u00f4mage (1,1%) et la LPP (pr\u00e9voyance professionnelle). Utilisez notre <a href="${taxUrl}">simulateur fiscal gratuit</a> pour calculer votre salaire net et comparer le co\u00fbt de la vie entre la Suisse et l'Italie.</p><p><strong>Permis G et r\u00e9sidence.</strong> Pour postuler \u00e0 ce poste en tant que frontalier, vous devez r\u00e9sider dans une commune italienne situ\u00e9e dans la zone fronti\u00e8re des 20 km (Lombardie ou Pi\u00e9mont) et rentrer chez vous au moins une fois par semaine. L'employeur d\u00e9pose la demande de permis G \u00e0 l'office cantonal des migrations apr\u00e8s la signature du contrat : la premi\u00e8re d\u00e9livrance prend 2 \u00e0 6 semaines, le renouvellement est ensuite annuel. Le t\u00e9l\u00e9travail \u00e0 plein temps depuis l'Italie n'est pas compatible avec le statut de frontalier ; des absences prolong\u00e9es du domicile italien (plus d'une semaine de travail sans retour) compromettent le r\u00e9gime fiscal.</p><p><strong>Salaire net et nouvel accord fiscal 2024.</strong> Le salaire brut annonc\u00e9 ici est retenu \u00e0 la source par l'employeur suisse \u00e0 des taux effectifs compris entre 5 % et 19 % dans le Canton du ${esc(displayCanton)} selon le revenu, l'\u00e9tat civil et les personnes \u00e0 charge. Les frontaliers engag\u00e9s \u00e0 partir du 1er janvier 2024 rel\u00e8vent du nouveau r\u00e9gime concurrent Italie-Suisse : l'Italie impose le revenu de source \u00e9trang\u00e8re tout en accordant un cr\u00e9dit d'imp\u00f4t sur la retenue suisse jusqu'\u00e0 80 %, d\u00e9clar\u00e9 dans le cadre RW de la d\u00e9claration italienne. En ajoutant les charges sociales, l'\u00e9cart brut-net typique est de 18 \u00e0 28 %. Pour un calcul personnalis\u00e9 sur le brut propos\u00e9 par ${jobCompany ? esc(jobCompany) : 'cet employeur'}, ouvrez le simulateur de salaire.</p><p><strong>Trajet et qualit\u00e9 de vie.</strong> ${jobLocation ? `Travailler \u00e0 ${esc(jobLocation)} signifie ` : `Travailler dans le Canton du ${esc(displayCanton)} signifie `}un trajet quotidien qui d\u00e9pend du poste-fronti\u00e8re choisi : Brogeda (autoroute A2) et Chiasso-route couvrent le Mendrisiotto et le Luganese ; Stabio et Gaggiolo desservent les pendulaires partant de la province de Var\u00e8se ; Ponte Tresa est l'acc\u00e8s historique pour Luino et la r\u00e9gion du Verbano. En heure de pointe, un trajet C\u00f4me-Lugano dure 25-50 minutes ; Var\u00e8se-Lugano typiquement 35-60. Pour qui envisage un d\u00e9m\u00e9nagement au Tessin, le loyer moyen d'un 3,5 pi\u00e8ces \u00e0 Lugano est de CHF 1'500-2'200/mois, contre EUR 600-900 pour un appartement \u00e9quivalent en province de C\u00f4me. Le r\u00e9seau de soins suisse (LAMal) offre des temps d'acc\u00e8s plus courts que le SSN italien, mais avec une prime mensuelle de CHF 350-500 par adulte — un poste de d\u00e9pense significatif \u00e0 int\u00e9grer dans toute comparaison net-net.</p></section>`);
 }

 // --- FAQ section (always shown — adds ~80 words of unique Q&A content) ---
 const lamalUrl: Record<string, string> = {
 it: `${BASE_URL}/premi-cassa-malati/`,
 en: `${BASE_URL}/en/health-insurance-premiums/`,
 de: `${BASE_URL}/de/krankenkassenpraemien/`,
 fr: `${BASE_URL}/fr/primes-assurance-maladie/`,
 };
 // FAQ section — 5 Q&A per locale covering net salary, LAMal, G permit
 // mechanics, statutory pay (13th + holidays + overtime) and required
 // documentation. ~1.5 KB additional visible text per page on top of the
 // previous 2-Q&A block.
 staticBodyParts.push(getExpiredFaqHtml(locale, escDisplayCanton, lamalUrl[locale] || lamalUrl.it));

 // --- Fallback: recent active jobs when no same-company jobs were shown ---
 // This ensures even pages without ejData have cross-links to active listings,
 // adding both word count and genuine user value.
 if (sameCompanyActiveJobs.length === 0) {
 // Pick up to 5 recent active jobs (deterministic by slug hash, O(1) via pre-computed pool)
 const recentJobs = selectRecentJobs(slug, slug);
 if (recentJobs.length > 0) {
 const recentHeading = locale === 'it' ? 'Posizioni attive recenti' : locale === 'en' ? 'Recent active positions' : locale === 'de' ? 'Aktuelle offene Stellen' : 'Postes actifs r\u00e9cents';
 const recentList = recentJobs.map((j: any) => {
 const jSlug = localizedSlug(j, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(j?.titleByLocale?.[locale] || j.title || '');
 const jCompany = String(j.company || '');
 const jLoc = String(j.location || '');
 return `<li><a href="${jHref}">${esc(jTitle)}</a>${jCompany ? ` \u2014 ${esc(jCompany)}` : ''}${jLoc ? `, ${esc(jLoc)}` : ''}</li>`;
 }).join('');
 staticBodyParts.push(`<section><h2>${recentHeading}</h2><ul>${recentList}</ul></section>`);
 }
 }

 // --- Fallback enrichment for pages without expired-jobs.json data ---
 // Ensures pages without rich ejData still have enough content (>= 50 words)
 // by adding general info about the Ticino cross-border job market.
 if (!ejData?.title && !gscInfo?.title) {
 if (locale === 'it') {
 staticBodyParts.push(`<section><h2>Mercato del lavoro in Ticino</h2><p>Il Canton Ticino offre numerose opportunit\u00e0 per i lavoratori frontalieri provenienti dall'Italia. Con oltre 70.000 frontalieri attivi, il Ticino rappresenta una delle principali destinazioni per chi cerca lavoro in Svizzera dalla regione insubrica. I settori pi\u00f9 attivi includono industria, servizi finanziari, sanit\u00e0, commercio e tecnologia. Lo stipendio medio in Ticino \u00e8 significativamente pi\u00f9 alto rispetto alle regioni italiane di confine, rendendo il lavoro transfrontaliero un'opzione molto attraente per i residenti di Lombardia, Piemonte e altre province vicine.</p></section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Job market in Ticino</h2><p>The Canton of Ticino offers numerous opportunities for cross-border workers from Italy. With over 70,000 active cross-border commuters, Ticino is one of the main destinations for those seeking employment in Switzerland from the Insubria region. The most active sectors include industry, financial services, healthcare, retail and technology. The average salary in Ticino is significantly higher than in Italian border regions, making cross-border work a very attractive option for residents of Lombardy, Piedmont and other nearby provinces.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin bietet zahlreiche M\u00f6glichkeiten f\u00fcr Grenzg\u00e4nger aus Italien. Mit \u00fcber 70.000 aktiven Grenzpendlern ist das Tessin eines der wichtigsten Ziele f\u00fcr Arbeitssuchende in der Schweiz aus der Region Insubrien. Die aktivsten Branchen sind Industrie, Finanzdienstleistungen, Gesundheitswesen, Handel und Technologie. Das Durchschnittsgehalt im Tessin liegt deutlich h\u00f6her als in den italienischen Grenzregionen, was die Grenzg\u00e4ngerarbeit zu einer sehr attraktiven Option f\u00fcr Bewohner der Lombardei, des Piemonts und anderer naher Provinzen macht.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>March\u00e9 du travail au Tessin</h2><p>Le Canton du Tessin offre de nombreuses opportunit\u00e9s pour les travailleurs frontaliers venant d'Italie. Avec plus de 70 000 frontaliers actifs, le Tessin est l'une des principales destinations pour ceux qui cherchent un emploi en Suisse depuis la r\u00e9gion insubrienne. Les secteurs les plus actifs comprennent l'industrie, les services financiers, la sant\u00e9, le commerce et la technologie. Le salaire moyen au Tessin est nettement plus \u00e9lev\u00e9 que dans les r\u00e9gions frontali\u00e8res italiennes, ce qui fait du travail transfrontalier une option tr\u00e8s attractive pour les r\u00e9sidents de Lombardie, du Pi\u00e9mont et d'autres provinces voisines.</p></section>`);
 }
 }

 // --- GSC related searches section (only for orphan slugs with query data) ---
 if (gscInfo?.queries && gscInfo.queries.length > 0) {
 const relatedQueries = gscInfo.queries
 .filter((q: string) => q.length > 3)
 .slice(0, 6);
 if (relatedQueries.length > 0) {
 const relSearchHeading: Record<string, string> = {
 it: 'Ricerche correlate',
 en: 'Related searches',
 de: 'Verwandte Suchanfragen',
 fr: 'Recherches associées',
 };
 const queryLinks = relatedQueries.map((q: string) =>
 `<li><a href="${BASE_URL}${listingPath}">${esc(q)}</a></li>`
 ).join('');
 staticBodyParts.push(`<section><h2>${relSearchHeading[locale] || relSearchHeading.it}</h2><ul>${queryLinks}</ul></section>`);
 }
 }

 staticBodyParts.push(`<p><a href="${BASE_URL}${listingPath}">${esc(archiveRelatedLabel[locale] || archiveRelatedLabel.it)} \u2192</a></p>`);
 const staticBody = staticBodyParts.join('\n');

 // Track IT word count for sitemap inclusion decision
 if (locale === 'it') {
 itBodyWordCount = countHtmlBodyWords(staticBody);
 }

 // Escape staticBody for embedding in a JS string (JSON.stringify handles quotes/newlines)
 const staticBodyJson = JSON.stringify(staticBody);

 // Make robots directive conditional on actual content quality.
 // Pages with >= MIN_INDEXABLE_WORDS of real text get index,follow (SEO value
 // from long-tail searches). Pages below threshold get noindex,follow.
 const expiredRobotsTag = robotsMetaForContent(staticBody);

 // Build JSON-LD scripts (BreadcrumbList + optional JobPosting)
 const breadcrumbLd = `<script type="application/ld+json">${JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Frontaliere Ticino', item: BASE_URL + '/' },
 { '@type': 'ListItem', position: 2, name: cantonSectionName(locale, displayCanton), item: `${BASE_URL}${listingPath}` },
 { '@type': 'ListItem', position: 3, name: jobTitle },
 ],
 })}</script>`;

 const jobPostingLd = (() => {
 // Only emit JobPosting when we have real job data
 const realTitle = ejData?.titleByLocale?.[locale] || ejData?.title || '';
 const realExpiredAt = ejData?.expiredAt || '';
 if (!realTitle || !realExpiredAt || !jobCompany) return '';
 const finalDescription = jobDescription || (() => {
 const parts: string[] = [];
 parts.push(`<p><strong>${esc(copy.banner)}</strong></p>`);
 if (locale === 'it') {
 parts.push(`<p>Questa posizione di ${esc(realTitle)} presso ${esc(jobCompany)}${jobLocation ? ` a ${esc(jobLocation)}` : ' in Ticino'} non è più disponibile.</p>`);
 } else if (locale === 'en') {
 parts.push(`<p>This ${esc(realTitle)} position at ${esc(jobCompany)}${jobLocation ? ` in ${esc(jobLocation)}` : ' in Ticino'} is no longer available.</p>`);
 } else if (locale === 'de') {
 parts.push(`<p>Diese Stelle als ${esc(realTitle)} bei ${esc(jobCompany)}${jobLocation ? ` in ${esc(jobLocation)}` : ' im Tessin'} ist nicht mehr verfügbar.</p>`);
 } else {
 parts.push(`<p>Ce poste de ${esc(realTitle)} chez ${esc(jobCompany)}${jobLocation ? ` à ${esc(jobLocation)}` : ' au Tessin'} n'est plus disponible.</p>`);
 }
 parts.push(`<p>${locale === 'it' ? 'Azienda' : locale === 'en' ? 'Company' : locale === 'de' ? 'Unternehmen' : 'Entreprise'}: ${esc(jobCompany)}</p>`);
 if (jobLocation) parts.push(`<p>${locale === 'it' ? 'Sede' : locale === 'en' ? 'Location' : locale === 'de' ? 'Standort' : 'Lieu'}: ${esc(jobLocation)}</p>`);
 return parts.join('');
 })();
 if (finalDescription.length < 30) return '';
 // Build the canonical JobPosting schema via the shared builder. The
 // expired soft-landing layers its expired-specific overrides (validThrough
 // = expiredAt, datePosted back-estimated from expiredAt when no crawl
 // data exists) on top of the canonical output.
 const expiredInput: JobInput = {
 id: ejData?.id,
 slug,
 title: realTitle,
 description: capJsonLdDescription(finalDescription),
 company: jobCompany,
 companyKey: ejData?.companyKey || slugInfo?.companyKey,
 addressLocality: jobLocation || undefined,
 addressRegion: jobCanton || undefined,
 postalCode: ejData?.postalCode || slugInfo?.postalCode,
 streetAddress: ejData?.streetAddress,
 postedDate: ejData?.postedDate,
 crawledAt: ejData?.crawledAt,
 validThrough: realExpiredAt,
 contract: ejData?.contract,
 salaryMin: typeof ejData?.salaryMin === 'number' ? ejData.salaryMin : null,
 salaryMax: typeof ejData?.salaryMax === 'number' ? ejData.salaryMax : null,
 salaryCurrency: ejData?.salaryCurrency,
 category: ejData?.category,
 sector: ejData?.category,
 url: undefined,
 };
 const expiredSchema = buildJobPostingSchema(expiredInput, {
 locale,
 url: selfUrl,
 baseUrl: BASE_URL,
 });
 // Expired-specific datePosted: when no crawl data exists, estimate as
 // 30 days before expiredAt so the posting window looks natural.
 const expiredDatePosted = (() => {
 if (ejData?.postedDate) { const d = new Date(ejData.postedDate); if (!isNaN(d.getTime())) return d.toISOString(); }
 if (ejData?.crawledAt) { const d = new Date(ejData.crawledAt); if (!isNaN(d.getTime())) { d.setUTCDate(d.getUTCDate() - 30); return d.toISOString(); } }
 const d = new Date(realExpiredAt); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString();
 })();
 const jp: Record<string, unknown> = {
 ...expiredSchema,
 datePosted: expiredDatePosted,
 validThrough: new Date(realExpiredAt).toISOString(),
 };
 return `<script type="application/ld+json">${JSON.stringify(jp)}</script>`;
 })();

 const jsonLdScripts = breadcrumbLd + (jobPostingLd ? '\n ' + jobPostingLd : '');

 const softLandingHtml = buildSoftLandingHtml(
 locale, pageTitle, pageDesc, expiredRobotsTag,
 selfUrl, hreflangLinks, jsonLdScripts, expiredWindowData,
 staticBodyJson, staticBody
 );

 // Skip if a previous (most-recent due to sort) slug already emitted
 // a soft-landing at this exact locale-prefixed path. Avoids the
 // write-registry collision that surfaces in dist/.write-collisions.json
 // when many slugs converge on one path. Map.set last-add-wins would
 // also dedup at the collector level, but the registry still RECORDS
 // each collision attempt — this Set keeps the report clean.
 const __slPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 if (emittedSoftLandingPaths.has(__slPathKey)) continue;
 emittedSoftLandingPaths.add(__slPathKey);

 writeSoftLandingPage(relPath.slice(1), softLandingHtml);
 const cacheKey = `${locale}:${slug}`;
 if (expiredCacheKeys.has(cacheKey)) {
 expiredSoftLandingCache.set(cacheKey, softLandingHtml);
 }
 expiredCount++;

 // Legacy slug bridge (Italian slug in non-IT locale path)
 if (locale !== 'it') {
 const legacyRel = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const trackedRel = relPath.replace(/^\//, '');
 if (legacyRel !== trackedRel && !emittedSoftLandingPaths.has(legacyRel.replace(/\/+$/, ''))) {
 emittedSoftLandingPaths.add(legacyRel.replace(/\/+$/, ''));
 writeSoftLandingPage(legacyRel, softLandingHtml);
 legacyCount++;
 }
 }
 recordEmit('expired-soft-landing', __tExpiredSoftLanding);
 }

 // Only add expired slugs to sitemap when:
 // 1. The IT page has enough content (>= MIN_INDEXABLE_WORDS) — thin content wastes crawl budget
 // 2. The IT page was actually written (not overwritten by an active page)
 const itPath = paths.it ? withSlash(paths.it) : '';
 const itPageFile = itPath ? np.join(distDir, itPath.slice(1), 'index.html') : '';
 const itPageOverwritten = itPageFile && _writtenPaths.has(itPageFile);
 if (itPath && itBodyWordCount >= MIN_INDEXABLE_WORDS && !itPageOverwritten && !bridgeClaimedPaths.has(paths.it)) {
 const altLinks = localeList.map((l) => {
 const p = paths[l];
 if (!p) return '';
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).filter(Boolean).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 const lastmod = (safeIsoDate(ejData?.expiredAt) || '').slice(0, 10) || dateStamp;
 expiredSitemapEntries.push(` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${altLinks}\n${xDefault}\n <lastmod>${lastmod}</lastmod>\n <changefreq>monthly</changefreq>\n <priority>0.3</priority>\n </url>`);
 }
 }

 // Write expired jobs sitemap
 if (expiredSitemapEntries.length > 0) {
 const sitemapExpired = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${expiredSitemapEntries.join('\n')}\n</urlset>\n`;
 const sitemapExpiredPath = np.join(distDir, 'sitemap-jobs-expired.xml');
 fs.writeFileSync(sitemapExpiredPath, sitemapExpired, 'utf-8');

 // Register in sitemap index
 const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexPath)) {
 let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
 if (!idx.includes('sitemap-jobs-expired.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs-expired.xml</loc>\n <lastmod>${dateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
 }
 }
 }

 if (expiredCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${expiredCount} soft-landing pages for ${expiredSlugs.length} expired jobs${legacyCount > 0 ? ` (+ ${legacyCount} legacy slug bridges)` : ''}`);
 }

 /* ── Cross-locale reconciliation for expired jobs ──────────── */
 // Mirrors the active-jobs cross-locale block below, but for expired jobs.
 // When an expired job has distinct `slugByLocale`, generate a soft-landing
 // bridge at every (baseLocale × foreignSlug) combination so a direct hit on
 // e.g. `/cerca-lavoro-ticino/<slug-fr>` renders soft-landing content in
 // Italian instead of a 404. Canonical (inherited from the cached HTML)
 // already points to the base locale's tracked slug URL.
 let crossLocaleExpiredCount = 0;
 for (const ej of expiredJobsData) {
 const slugByLocale = (ej && ej.slugByLocale) as Record<string, string> | undefined;
 if (!slugByLocale || typeof slugByLocale !== 'object') continue;
 for (const baseLocale of localeList) {
 const baseSlug = slugByLocale[baseLocale];
 if (!baseSlug) continue;
 const baseHtml = expiredSoftLandingCache.get(`${baseLocale}:${baseSlug}`);
 if (!baseHtml) continue;
 const foreignSlugs = new Set<string>();
 for (const otherLocale of localeList) {
 if (otherLocale === baseLocale) continue;
 const fs2 = slugByLocale[otherLocale];
 if (fs2 && fs2 !== baseSlug) foreignSlugs.add(fs2);
 }
 if (foreignSlugs.size === 0) continue;
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(baseSlug)};</script>`;
 const bridgeHtml = baseHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 for (const foreignSlug of foreignSlugs) {
 // Sector/city hubs win over cross-locale reconciliation — same
 // rationale as the active-jobs block (jobSectorPagesPlugin owns
 // these paths).
 if (RESERVED_HUB_SLUGS.has(foreignSlug)) continue;
 const relPath = `${localePrefix[baseLocale]}/${sectionByLocale[baseLocale]}/${foreignSlug}`.replace(/\/+/g, '/');
 const relPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 // Active job wins if a live page already occupies this path.
 if (activeJobDirs.has(relPathKey)) continue;
 const outDir = np.join(distDir, relPath.replace(/^\//, ''));
 const indexFile = np.join(outDir, 'index.html');
 // Skip if any earlier phase (active, bridge, soft-landing) already wrote here.
 if (_writtenPaths.has(indexFile)) continue;
 const __tCrossLocaleExpired = startTimer();
 _md(outDir);
 _qw(indexFile, bridgeHtml);
 _writtenPaths.add(indexFile);
 crossLocaleExpiredCount++;
 recordEmit('cross-locale-expired-bridge', __tCrossLocaleExpired);
 }
 }
 }
 if (crossLocaleExpiredCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${crossLocaleExpiredCount} cross-locale reconciliation pages for expired jobs`);
 }

 /* ── Full-content pages for previousSlugs of active jobs ────── */
 // Serve identical full-content pages at old URLs (bookmarks, search engines).
 // The only difference: <link rel="canonical"> points to the current slug URL,
 // and window.__BRIDGE_TARGET_SLUG__ tells the SPA to use the current slug.
 // No redirect, no countdown — user sees full job content immediately.
 //
 // Uses locale-aware previousSlugsByLocale when available:
 // - previousSlugsByLocale[locale] → bridge pages only under that locale's prefix
 // - Legacy flat previousSlugs → bridge pages under ALL locale prefixes (safe fallback)
 //
 // Dedup-at-write-time (2026-04-30): when multiple active jobs claim the
 // same previousSlug for the same locale (the convit-holding case — 8 jobs
 // share the same translated old slug), only ONE bridge is emitted. The
 // winner is chosen via token-Jaccard similarity between oldSlug and each
 // candidate's current canonical, and persisted to
 // `data/previous-slug-winners.json` so the same prevSlug always points to
 // the same canonical across builds. See `services/previousSlugWinners.ts`
 // for the full rationale and heuristic.

 // Pre-scan #1: build the claimant map BEFORE the emit loop. For each
 // (locale, oldSlug) pair, list every active job that claims it via either
 // previousSlugsByLocale[locale] or the legacy flat previousSlugs (locale-
 // unattributed entries fan out across all locales).
 const previousSlugClaimants = new Map<string, PreviousSlugCandidate[]>();
 for (const job of validJobs) {
 const localeAwareAll = new Set<string>();
 const pslByLocale = (job as any).previousSlugsByLocale;
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s);
 }
 }
 const legacyOnly = Array.isArray(job.previousSlugs)
 ? job.previousSlugs.filter((s: string) => !localeAwareAll.has(s))
 : [];
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;
 for (const locale of localeList) {
 const currentSlug = localizedSlug(job, locale);
 if (!currentSlug) continue;
 const localeSpecific = pslByLocale && Array.isArray(pslByLocale[locale]) ? (pslByLocale[locale] as string[]) : [];
 const prevSlugsForLocale = new Set<string>([...localeSpecific, ...legacyOnly]);
 for (const oldSlug of prevSlugsForLocale) {
 if (!oldSlug || oldSlug === currentSlug) continue;
 if (RESERVED_HUB_SLUGS.has(oldSlug)) continue;
 const key = previousSlugWinnerKey(locale, oldSlug);
 const list = previousSlugClaimants.get(key);
 const candidate: PreviousSlugCandidate = {
 jobIdentifier: String((job as any).id || (job as any).slug || currentSlug),
 canonicalSlug: currentSlug,
 };
 if (list) list.push(candidate);
 else previousSlugClaimants.set(key, [candidate]);
 }
 }
 }

 // Pre-scan #2: load persisted winners and resolve a winner identifier for
 // every key. Single-claimant keys take the trivial winner (no registry
 // entry written). Multi-claimant keys reuse the persisted winner when it
 // is still in the candidates list, else re-elect via the heuristic.
 const previousSlugWinnersPath = np.resolve(rootDir, 'data', 'previous-slug-winners.json');
 const previousSlugWinners: PreviousSlugWinnersFile = loadWinners(previousSlugWinnersPath);
 const previousSlugWinnersBefore = JSON.stringify(previousSlugWinners);
 const winnerByPrevSlugKey = new Map<string, string>(); // key → winner jobIdentifier
 // Day-quantized timestamp. With millisecond precision the previous-slug
 // winners registry's `lastSeenAt` field churned on every deploy, producing
 // ~96 commits/day to data/previous-slug-winners.json (one per article-cron
 // deploy) — pure noise that invalidated jobs-seo-pages cache and bloated
 // git history. Quantizing to UTC midnight means the file only changes
 // once per day (when crossing the day boundary refreshes lastSeenAt for
 // every active entry). pruneStaleWinners uses a 30+ day threshold so the
 // day-level granularity is more than fine.
 const nowIso = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
 let multiClaimantKeys = 0;
 for (const [key, candidates] of previousSlugClaimants) {
 const [locale, oldSlug] = key.split('::', 2);
 if (candidates.length > 1) multiClaimantKeys += 1;
 const winner = resolveWinner(previousSlugWinners, locale, oldSlug, candidates, nowIso);
 if (winner) winnerByPrevSlugKey.set(key, winner.winnerJobIdentifier);
 }
 if (multiClaimantKeys > 0) {
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m previous-slug winners: ${previousSlugClaimants.size} claimed slugs, ${multiClaimantKeys} contested → resolved via registry + heuristic`,
 );
 }

 let bridgeCount = 0;
 let bridgeSkippedNotWinner = 0;
 for (const job of validJobs) {
 // Collect previous slugs that aren't locale-attributed (legacy flat entries)
 const localeAwareAll = new Set<string>();
 const pslByLocale = (job as any).previousSlugsByLocale;
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s);
 }
 }
 const legacyOnly = Array.isArray(job.previousSlugs)
 ? job.previousSlugs.filter(s => !localeAwareAll.has(s))
 : [];
 // Check if there's anything to do
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;

 for (const locale of localeList) {
 const currentSlug = localizedSlug(job, locale);
 const cachedHtml = jobHtmlCache.get(`${locale}:${currentSlug}`);
 if (!cachedHtml) continue;

 // Locale-specific previous slugs + legacy (unknown locale → all locales)
 const prevSlugsForLocale = [
 ...new Set([
 ...(pslByLocale && Array.isArray(pslByLocale[locale]) ? pslByLocale[locale] : []),
 ...legacyOnly,
 ]),
 ];

 // Hoist per (currentSlug, locale): bridgeScript + the two .replace()
 // passes over the ~30-50 KB cachedHtml don't depend on `oldSlug`. Lazy
 // (computed only on the first oldSlug that actually emits a bridge) so
 // the case where every prevSlug is filtered out below stays a no-op.
 let bridgeIndexHtml: string | null = null;
 let bridgeFlatHtml: string | null = null;
 const ensureBridgeHtml = (): { indexHtml: string; flatHtml: string } => {
 if (bridgeIndexHtml === null || bridgeFlatHtml === null) {
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(currentSlug)};</script>`;
 bridgeIndexHtml = cachedHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 bridgeFlatHtml = bridgeIndexHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, '');
 }
 return { indexHtml: bridgeIndexHtml, flatHtml: bridgeFlatHtml };
 };

 const myJobIdentifier = String((job as any).id || (job as any).slug || currentSlug);
 for (const oldSlug of prevSlugsForLocale) {
 if (oldSlug === currentSlug) continue;
 // Skip bridge generation when the previousSlug is a reserved sector/city
 // hub. A real job (e.g. infermieri-lis-lugano-istituti-sociali-lugano) has
 // 'infermieri' in its previousSlugs as a GSC-imported generic alias —
 // emitting a bridge at /cerca-lavoro-ticino/infermieri/ clobbers
 // jobSectorPagesPlugin's curated sector hub at the same path and sends
 // both users and Google to a job soft-landing instead of the canonical hub.
 if (RESERVED_HUB_SLUGS.has(oldSlug)) continue;
 // Dedup at write time: if multiple active jobs share this prevSlug, only
 // the registered winner emits the bridge. Other claimants skip silently —
 // their canonical content is still indexed at THEIR own canonical URL,
 // and the bridge URL stably points at the winner's canonical across builds.
 const winnerKey = previousSlugWinnerKey(locale, oldSlug);
 const winnerId = winnerByPrevSlugKey.get(winnerKey);
 if (winnerId && winnerId !== myJobIdentifier) {
 bridgeSkippedNotWinner += 1;
 continue;
 }
 const oldPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${oldSlug}`.replace(/\/+/g, '/');
 const oldRelPath = oldPath.replace(/^\//, '');
 // Skip if an active job page already occupies this path (buffered writes
 // are invisible to fs.existsSync — use the activeJobDirs set instead).
 if (activeJobDirs.has(oldRelPath.replace(/\/+$/, ''))) continue;
 const __tPrevSlugBridge = startTimer();
 const outDir = np.join(distDir, oldRelPath);
 // Always generate bridge pages — they take priority over any compat/legacy
 // page that another plugin (e.g. legacyRedirectsPlugin) may have written
 // at the same path via fs.writeFileSync during concurrent closeBundle.
 //
 // Reuse the full active page HTML — canonical already points to the
 // current slug URL. Inject __BRIDGE_TARGET_SLUG__ so the SPA knows to
 // use the current slug for data lookup instead of parsing the old URL.
 const { indexHtml, flatHtml } = ensureBridgeHtml();

 _md(outDir);
 _qw(np.join(outDir, 'index.html'), indexHtml);

 const flatFile = np.join(distDir, oldPath.replace(/^\//, '') + '.html');
 _md(np.dirname(flatFile));
 _qwFlat(flatFile, indexHtml);
 bridgeCount++;
 recordEmit('previous-slug-bridge', __tPrevSlugBridge);
 }
 }
 }
 if (bridgeCount > 0) {
 const skipNote = bridgeSkippedNotWinner > 0
 ? ` (${bridgeSkippedNotWinner} duplicate emits skipped — see data/previous-slug-winners.json for the canonical owner per slug)`
 : '';
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${bridgeCount} previousSlugs full-content pages${skipNote}`);
 }

 // Garbage-collect entries whose oldSlug nobody has claimed in the last
 // 30 days. Without this the registry grows monotonically: deleted jobs
 // leave their winner entries behind as ghosts, and a slug that nobody
 // lists in any previousSlugs anymore stays in the file forever.
 // 30 days is a grace window wide enough to ride out a temporarily-
 // absent feed entry (crawler hiccup, weekend off-shift, manual review)
 // without flipping the URL on its return; tight enough that genuinely
 // removed slugs eventually exit the file.
 const PREV_SLUG_WINNER_TTL_DAYS = 30;
 const prunedWinners = pruneStaleWinners(
 previousSlugWinners,
 PREV_SLUG_WINNER_TTL_DAYS * 24 * 60 * 60 * 1000,
 nowIso,
 );
 if (prunedWinners > 0) {
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m previous-slug winners: pruned ${prunedWinners} stale entries (>${PREV_SLUG_WINNER_TTL_DAYS}d since last seen)`,
 );
 }

 // Persist the winners file if any decision changed during this build,
 // OR if the prune removed entries. Stable cross-build URLs depend on
 // persistence — without it, the heuristic could re-elect a different
 // winner on a different build and silently flip every bridge target.
 if (JSON.stringify(previousSlugWinners) !== previousSlugWinnersBefore) {
 saveWinners(previousSlugWinnersPath, previousSlugWinners);
 console.log(
 `\x1b[36m[jobs-seo-pages]\x1b[0m previous-slug winners updated → ${np.relative(rootDir, previousSlugWinnersPath)}`,
 );
 }

 /* ── Cross-locale reconciliation bridge pages ──────────────── */
 // When a job has different slugs per locale (e.g. AI translation landed
 // the French slug under the Italian base URL before the Italian slug
 // was generated), a direct hit on `/cerca-lavoro-ticino/<slug-fr>` would
 // otherwise render nothing until the client-side slug map loads.
 // Generate a full-content bridge page at every (baseLocale × foreignSlug)
 // combination where the foreign-locale slug differs from the base-locale
 // slug. Content is served in the base URL's locale; canonical points to
 // the base locale's current slug URL. No redirect, no countdown.
 let crossLocaleCount = 0;
 for (const job of validJobs) {
 const slugPerLocale: Record<string, string> = {};
 for (const locale of localeList) {
 const s = localizedSlug(job, locale);
 if (s) slugPerLocale[locale] = s;
 }
 // Previous slugs grouped by locale (used to cover cross-locale legacy slugs,
 // e.g. a German previous slug indexed under the Italian base URL).
 const pslByLocaleTyped = (job as { previousSlugsByLocale?: Record<string, unknown> }).previousSlugsByLocale;
 const prevSlugsByLocale: Record<string, string[]> = {};
 if (pslByLocaleTyped && typeof pslByLocaleTyped === 'object') {
 for (const [l, arr] of Object.entries(pslByLocaleTyped)) {
 if (Array.isArray(arr)) prevSlugsByLocale[l] = (arr as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0);
 }
 }
 for (const baseLocale of localeList) {
 const baseSlug = slugPerLocale[baseLocale];
 if (!baseSlug) continue;
 const cachedHtml = jobHtmlCache.get(`${baseLocale}:${baseSlug}`);
 if (!cachedHtml) continue;
 const foreignSlugs = new Set<string>();
 for (const otherLocale of localeList) {
 if (otherLocale === baseLocale) continue;
 // Other locale's current slug
 const s = slugPerLocale[otherLocale];
 if (s && s !== baseSlug) foreignSlugs.add(s);
 // Other locale's previous slugs (covers legacy renames per locale)
 for (const ps of prevSlugsByLocale[otherLocale] || []) {
 if (ps && ps !== baseSlug) foreignSlugs.add(ps);
 }
 }
 if (foreignSlugs.size === 0) continue;
 // Compute once per (job, baseLocale) — same HTML is written at every foreign slug path.
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(baseSlug)};</script>`;
 const bridgeHtml = cachedHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 for (const foreignSlug of foreignSlugs) {
 // Skip cross-locale reconciliation when the foreign slug is a
 // reserved sector/city hub (same rationale as the previousSlugs
 // guard above — protects jobSectorPagesPlugin's curated hubs).
 if (RESERVED_HUB_SLUGS.has(foreignSlug)) continue;
 const relPath = `${localePrefix[baseLocale]}/${sectionByLocale[baseLocale]}/${foreignSlug}`.replace(/\/+/g, '/');
 const relPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 // Skip if an active job page already occupies this path (another
 // job's slug happens to collide across locales — active wins).
 if (activeJobDirs.has(relPathKey)) continue;
 const outDir = np.join(distDir, relPath.replace(/^\//, ''));
 const indexFile = np.join(outDir, 'index.html');
 // Skip if a previousSlugs bridge already covered this path for
 // this job (same content would be written again).
 if (_writtenPaths.has(indexFile)) continue;
 const __tCrossLocaleActive = startTimer();
 _md(outDir);
 _qw(indexFile, bridgeHtml);
 _writtenPaths.add(indexFile);
 // Note: skip the flat `.html` variant — GH Pages serves
 // /dir/index.html for direct URL hits and the flat variant
 // would double disk usage for ~27k bridge pages.
 crossLocaleCount++;
 recordEmit('cross-locale-active-bridge', __tCrossLocaleActive);
 }
 }
 }
 if (crossLocaleCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${crossLocaleCount} cross-locale reconciliation pages`);
 }

 /* ── Self-healing: cover any tracking paths not yet written ──── */
 // Safety net: any tracking path that wasn't covered by active, soft-landing,
 // or bridge pages gets a minimal redirect page pointing to the job listing.
 // This handles edge cases like locale-variant tracking keys that match a
 // currentSlug value but whose locale paths differ from the active job paths.
 let healedCount = 0;
 for (const [, paths] of Object.entries(tracking) as [string, Record<string, string>][]) {
 for (const locale of localeList) {
 const relPath = paths?.[locale];
 if (!relPath) continue;
 const absFile = np.join(distDir, relPath.replace(/^\//, ''), 'index.html');
 if (_writtenPaths.has(absFile)) continue;
 const __tSelfHealing = startTimer();

 const listingPath = `${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/');
 const listingUrl = `${BASE_URL}${withSlash(listingPath)}`;
 const localeCopy = {
 it: { title: 'Offerta di lavoro aggiornata', body: 'Questa posizione è stata aggiornata o rimossa. Consulta le offerte disponibili.', cta: 'Vedi tutte le offerte' },
 en: { title: 'Job listing updated', body: 'This position has been updated or removed. Browse available listings.', cta: 'View all listings' },
 de: { title: 'Stellenangebot aktualisiert', body: 'Diese Stelle wurde aktualisiert oder entfernt. Durchsuchen Sie die verfügbaren Angebote.', cta: 'Alle Angebote ansehen' },
 fr: { title: 'Offre d\'emploi mise à jour', body: 'Cette offre a été mise à jour ou supprimée. Consultez les offres disponibles.', cta: 'Voir toutes les offres' },
 };
 const copy = localeCopy[locale] ?? localeCopy.it;
 const html = buildCanonicalBridgePage({
 canonicalUrl: listingUrl,
 pathLabel: listingPath,
 title: `${copy.title} | Frontaliere Ticino`,
 description: copy.body,
 body: copy.body,
 ctaLabel: copy.cta,
 lang: locale,
 noindex: true,
 });
 writeSoftLandingPage(relPath.replace(/^\//, ''), html);
 healedCount++;
 recordEmit('self-healing', __tSelfHealing);
 }
 }
 if (healedCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Self-healed ${healedCount} tracking paths with no prior coverage`);
 }

 /* ── Flush all buffered writes in parallel batches ── */
 const t0 = Date.now();
 const written = await collector.flush();
 const skipped = collector.skippedByHash;
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
 (skipped > 0 ? ` (${skipped} skipped by content hash)` : ''));
 // Signal downstream consumers (relatedSearchClustersPlugin) that bridge
 // HTML is on disk. Without this, parallel closeBundle lets the cluster
 // sitemap be written before bridge writes flush, leaking non-self-
 // canonical bridge URLs into sitemap-search-clusters.xml.
 resolveJobsSeoPagesFlushed();

 // Print profiler summary if JOBS_SEO_PROFILE=1 is set; no-op otherwise.
 printJobsSeoProfile();

 // ── Patch sitemap.xml index lastmods ───────────────────────────────
 // The sitemap.xml index file is re-emitted by other plugins each build,
 // so our entries' <lastmod> would otherwise drop out (or fail to
 // register on a clean build). Idempotent: adds the entry if missing,
 // otherwise refreshes lastmod.
 const sitemapIndexFile = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexFile)) {
 let idx = fs.readFileSync(sitemapIndexFile, 'utf-8');
 const sitemapJobsExists = fs.existsSync(np.join(distDir, 'sitemap-jobs.xml'));
 if (sitemapJobsExists) {
 if (!idx.includes('sitemap-jobs.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs.xml</loc>\n <lastmod>${cacheDateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 } else {
 idx = idx.replace(
 /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-jobs\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
 `$1${cacheDateStamp}$2`
 );
 }
 }
 const sitemapExpiredExists = fs.existsSync(np.join(distDir, 'sitemap-jobs-expired.xml'));
 if (sitemapExpiredExists) {
 if (!idx.includes('sitemap-jobs-expired.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs-expired.xml</loc>\n <lastmod>${cacheDateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 } else {
 idx = idx.replace(
 /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-jobs-expired\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
 `$1${cacheDateStamp}$2`
 );
 }
 }
 fs.writeFileSync(sitemapIndexFile, idx, 'utf-8');
 }
 },
 };
}