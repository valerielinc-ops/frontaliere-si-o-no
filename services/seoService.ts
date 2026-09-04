/**
 * SEO Service - Dynamic Meta Tags Management
 * Manages SEO metadata for different sections of the app
 */

import { getLocale, setLocale, t, getCantonI18nParams, type Locale } from './i18n';
import { parsePath, buildPath, buildAllLocalePaths, ensureJobSlugEntriesLoaded, getJobMetaForSlug, type AppRoute } from './router';
import { ALL_GLOSSARY_TERM_IDS, ALL_BORDER_CROSSING_IDS } from './router';
import { fetchJobsForCanton } from './jobsService';
import { JOB_CANTON_MANIFEST_PATH, type CantonShardManifest } from './jobCantonShards';
import { resolveCompanyLogoUrl, isMultiLocation } from './jobDataNormalization';
import { reportCaughtError } from './errorReporter';
import { bustAssetHttpCache, isChunkLoadError, isModuleParseError } from './resilientImport';
import { cdnDataUrl } from './cdnDataBase';
import { seededJobMatchesSlug } from './seededExpiredJob';
import { normalizeStructuredData } from './seo/schema-normalizers';
import { GLOSSARY_TERM_DEFINITIONS, truncateForMetaDescription } from './seo/glossaryTermDefinitions';
import { cdnBlogImage } from './seo/blogImageCdn';
import { resolveArticleAuthorUrl, loadArticleAuthorRegistry, type ArticleAuthorRegistry } from './seo/articleAuthorUrl';
import { translateSchema } from './seo/schema-translators';
import { buildJobPostingSchema, type JobInput } from '../build-plugins/shared/jobPostingSchema';
import { buildJobPostingFaqPairs, type BuildJobPostingFaqOptions } from '../build-plugins/shared/jobPostingFaq';
import { getCantonDisplayName } from '../build-plugins/shared/cantonDisplay';
import { resolveJobCanton } from '../build-plugins/shared/cantonSection';
import { buildTitleWithBrand, buildJobTitleWithLocation, clampMetaDescription, truncateHeadline, truncateTitleAtClauseBoundary, MIN_PEELED_TITLE_CHARS } from '../build-plugins/shared/titleSuffix';
import { ROBOTS_INDEX_ENHANCED_CONTENT } from '../build-plugins/shared/robotsDirective';
import { truncateCodeUnits } from '../build-plugins/shared/safeTruncate';
import { borderCrossingLabel, buildBorderCrossingTitle, buildBorderCrossingDescription } from '../build-plugins/shared/borderCrossingTitle';
import { BLOG_SEO_SHARD_IDS, type BlogSeoShardId } from '../build-plugins/shared/blogSeoShards';

/**
 * Retry a dynamic import once after clearing SW caches.
 * Mirrors the logic in lazyRetry.ts but for non-React imports.
 */
async function retryImport<T>(factory: () => Promise<T>, label: string): Promise<T> {
 try {
 return await factory();
 } catch (err) {
 // Shared isChunkLoadError predicate (resilientImport.ts) instead of a
 // hand-copied substring list — this file used to carry its own literal
 // copy (missing WebKit's "Importing a module script failed" wording) that
 // had drifted from resilientImport.ts's (issue #3216 item 1; AGENTS.md
 // §Non-Negotiables #6).
 //
 // A PARSE-time SyntaxError is folded in here too (issue #5531), mirroring
 // lazyRetry.ts: the chunk URL answered, but with bytes that are not
 // JavaScript (HTML 404/SPA-fallback parsed as a module). Excludes the
 // link-time skew wordings so that no-retry class keeps its own path.
 if (!isChunkLoadError(err) && !isModuleParseError(err)) throw err;

 // Clear SW caches and retry once. CacheStorage alone is not enough: the
 // chunk also lives in the HTTP disk cache (stable-named, max-age=600), which
 // a bare retry would re-read — bust it so the retry fetches current bytes (#3097).
 if ('caches' in window) {
 const names = await caches.keys();
 await Promise.all(names.map(n => caches.delete(n)));
 }
 await bustAssetHttpCache();
 try {
 return await factory();
 } catch (retryErr) {
 reportCaughtError(retryErr, `seo.chunkRetry.${label}`);
 throw retryErr;
 }
 }
}

export interface SEOMetadata {
 title: string;
 description: string;
 keywords: string;
 ogTitle: string;
 ogDescription: string;
 canonicalPath: string;
 structuredData?: Record<string, any> | Record<string, any>[];
 /** Optional H1 override — if set, static HTML renders this instead of ogTitle (H.6 SEO). */
 h1?: string;
}

const BASE_URL = 'https://frontaliereticino.ch';

// inLanguage whitelist lives in ./seo/inlanguage-whitelist so that test files
// which mock '@/services/seoService' (tests/setup.tsx) don't accidentally
// hide it from non-mocked consumers like services/seo/schema-normalizers.ts.
export { TYPES_ACCEPT_IN_LANGUAGE } from './seo/inlanguage-whitelist';
import { TYPES_ACCEPT_IN_LANGUAGE } from './seo/inlanguage-whitelist';
import { ORGANIZATION_LD } from './seo/organizationLd';

/**
 * E-E-A-T Author & Publisher Schema for YMYL content.
 * Using Organization with expert-level knowsAbout signals.
 * Reused across all structured data to ensure consistency.
 *
 * Includes inline E-E-A-T fields (name, description, knowsAbout) alongside
 * the @id reference so that AI crawlers and schema validators see expertise
 * signals even without resolving the referenced #organization entity.
 */
export const SCHEMA_AUTHOR = {
 "@type": "Organization",
 "@id": `${BASE_URL}/#organization`,
 "name": "Redazione Frontaliere Ticino",
 "url": `${BASE_URL}/chi-siamo/`,
 "description": "Team editoriale specializzato in fiscalità, previdenza e vita quotidiana dei lavoratori frontalieri in Ticino",
 "knowsAbout": [
 "Fiscalità frontalieri Svizzera-Italia",
 "Nuovo accordo fiscale 2026",
 "Previdenza sociale AVS/LPP",
 "Assicurazione malattia LAMal/CMB",
 "Permesso G e permesso B",
 "Mercato del lavoro Ticino",
 ],
} as const;

// Full inline Organization node (shared canonical entity) — a bare `@id`
// pointer dangles for page-local structured-data parsers when the graph
// doesn't also define the entity (#3524).
export const SCHEMA_PUBLISHER = ORGANIZATION_LD;

/**
 * Organization author for blog articles and editorial content.
 * Uses the same enriched author object as SCHEMA_AUTHOR so that
 * AI systems see E-E-A-T signals (knowsAbout, description) inline,
 * while the @id still links to the standalone Organization in index.html
 * for knowledge graph consistency.
 */
export const SCHEMA_EXPERT_AUTHOR = {
 "@type": "Organization",
 "@id": `${BASE_URL}/#organization`,
 "name": "Redazione Frontaliere Ticino",
 "url": `${BASE_URL}/chi-siamo/`,
 "description": "Team editoriale specializzato in fiscalità, previdenza e vita quotidiana dei lavoratori frontalieri in Ticino",
 "knowsAbout": [
 "Fiscalità frontalieri Svizzera-Italia",
 "Nuovo accordo fiscale 2026",
 "Previdenza sociale AVS/LPP",
 "Assicurazione malattia LAMal/CMB",
 "Permesso G e permesso B",
 "Mercato del lavoro Ticino",
 ],
} as const;

/**
 * Previously SpeakableSpecification. Google's speakable is restricted to news
 * publishers and triggered SEMrush "unrecognized property" errors on
 * WebApplication/Dataset schemas. Kept as empty export only to preserve
 * import compatibility.
 * @deprecated
 */
export const SCHEMA_SPEAKABLE = {} as const;

const SERP_EXPERIMENT_CACHE_KEY = 'seo_serp_experiment_state_v1';
const SEARCH_ENGINES = ['google.', 'bing.', 'yahoo.', 'duckduckgo.', 'ecosia.', 'yandex.'];
const SERP_EXPERIMENT_DEFAULTS = {
 enabled: true,
 variant: 'year_intent' as SerpExperimentVariant,
 targets: '*',
 year: '2026',
};

type SerpExperimentVariant = 'control' | 'year_intent' | 'intent_simulation';
type SerpExperimentState = {
 enabled: boolean;
 variant: SerpExperimentVariant;
 targets: Set<string>;
 year: string;
 loaded: boolean;
};

const serpExperimentState: SerpExperimentState = {
 enabled: false,
 variant: 'control',
 targets: new Set(),
 year: '2026',
 loaded: false,
};

let serpExperimentLoadPromise: Promise<void> | null = null;
let lastSerpExposureContext: { section: string; path: string; variant: SerpExperimentVariant } | null = null;
const jobsBySlugCacheByLocale: Partial<Record<Locale, Map<string, any>>> = {};
const jobsBySlugPromiseByLocale: Partial<Record<Locale, Promise<Map<string, any>>>> = {};
let totalActiveJobCount: number | null = null;

function normalizeSeoText(input: string): string {
 return String(input || '').replace(/\s+/g, ' ').trim();
}

function compactSeoDescription(input: string, maxChars = 320): string {
 const cleaned = normalizeSeoText(input).replace(/<[^>]+>/g, ' ');
 if (cleaned.length <= maxChars) return cleaned;
 // Surrogate-safe cut (truncateHeadline slices via truncateCodeUnits): this
 // feeds the SPA-runtime JSON-LD `description`; a raw slice can split an emoji
 // pair and leave a lone surrogate that breaks parsing. truncateHeadline adds
 // the word-boundary + dangling-clause peel the raw slice lacked, so the text
 // no longer stops mid-word or on a preposition.
 return truncateHeadline(cleaned, maxChars);
}

function companyLogoFromJob(job: any): string {
 const logo = resolveCompanyLogoUrl({
 company: String(job?.company || ''),
 companyKey: String(job?.companyKey || ''),
 companyDomain: String(job?.companyDomain || ''),
 url: String(job?.url || ''),
 });
 return logo || `${BASE_URL}/icons/icon-512x512.png`;
}

function parseRawDateToIso(raw = ''): string {
 const value = normalizeSeoText(raw);
 if (!value) return new Date().toISOString();
 const parsed = new Date(value);
 if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
 const safe = new Date(`${value}T00:00:00.000Z`);
 return Number.isNaN(safe.getTime()) ? new Date().toISOString() : safe.toISOString();
}

function addDaysIso(rawDate = '', days = 60): string {
 const d = new Date(parseRawDateToIso(rawDate));
 d.setUTCDate(d.getUTCDate() + days);
 return d.toISOString();
}

function normalizeEmploymentType(contractRaw = ''): string {
 const v = normalizeSeoText(contractRaw).toLowerCase();
 if (v.includes('full')) return 'FULL_TIME';
 if (v.includes('permanent')) return 'FULL_TIME';
 if (v.includes('part')) return 'PART_TIME';
 if (/\bintern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(v) || /\bstages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(v) || v.includes('tirocin')) return 'INTERN';
 if (v.includes('temp')) return 'TEMPORARY';
 if (v.includes('contract')) return 'CONTRACTOR';
 return 'OTHER';
}

function numericValue(value: unknown): number | null {
 const parsed = Number(value);
 return Number.isFinite(parsed) ? parsed : null;
}

function resolveJobAddress(job: any): {
 locality: string;
 region: string;
 country: string;
 postalCode?: string;
 streetAddress?: string;
} {
 // Parameterized defaults — change when expanding beyond TI/GR
 const DEFAULT_CANTON = 'TI';
 const DEFAULT_CANTON_DISPLAY = 'Ticino';
 const locality = String(job?.addressLocality || job?.location || DEFAULT_CANTON_DISPLAY);
 const region = String(job?.addressRegion || job?.canton || DEFAULT_CANTON);
 const country = String(job?.addressCountry || 'CH');
 const postalCode = normalizeSeoText(String(job?.postalCode || ''));
 const streetAddress = normalizeSeoText(String(job?.streetAddress || ''));
 return {
 locality,
 region,
 country,
 ...(postalCode ? { postalCode } : {}),
 ...(streetAddress ? { streetAddress } : {}),
 };
}

function resolveJobSalary(job: any): { minValue: number; maxValue?: number; currency: string } | null {
 const minDirect = numericValue(job?.salaryMin);
 const maxDirect = numericValue(job?.salaryMax);
 const baseSalaryValue = job?.baseSalary?.value || {};
 const minFromBase = numericValue(baseSalaryValue?.minValue);
 const maxFromBase = numericValue(baseSalaryValue?.maxValue);
 const minValue = minDirect ?? minFromBase;
 if (minValue == null) return null;
 const maxValue = maxDirect ?? maxFromBase ?? undefined;
 const currency = String(
 job?.currency ||
 job?.baseSalary?.currency ||
 baseSalaryValue?.currency ||
 'CHF'
 ).toUpperCase();
 return { minValue, ...(maxValue ? { maxValue } : {}), currency };
}

function localizedJobKeywords(locale: Locale, title: string, company: string, location: string): string {
 const role = normalizeSeoText(title).toLowerCase();
 const org = normalizeSeoText(company).toLowerCase();
 const loc = normalizeSeoText(location).toLowerCase();
 const baseByLocale: Record<Locale, string> = {
 it: 'lavoro ticino, offerte lavoro frontalieri, lavoro svizzera frontalieri, impiego ticino, carriera svizzera',
 en: 'jobs ticino, cross-border jobs switzerland italy, job offers ticino, work in ticino',
 de: 'jobs tessin, stellenangebote grenzgaenger, arbeit im tessin, stellen schweiz italien',
 fr: 'emplois tessin, offres frontaliers, travail tessin, emploi suisse italie',
 };
 return `${role}, ${org}, ${loc}, ${baseByLocale[locale]}`;
}

async function loadJobsBySlug(locale: Locale): Promise<Map<string, any>> {
 const cached = jobsBySlugCacheByLocale[locale];
 if (cached) return cached;
 const pending = jobsBySlugPromiseByLocale[locale];
 if (pending) return pending;
 // Per-locale fetch: the slim listing index `jobs-{locale}-index.json` (the
 // full `jobs-{locale}.json` monolith is no longer emitted). The index has
 // the slug→id mapping + listing fields; the SEO meta path (resolveJobSeoBySlug)
 // lazy-fetches `job-detail/{id}.json` for the description + structured-data
 // fields (postalCode/streetAddress/...) it needs per job. The count path
 // (getActiveJobCountLabel) only needs map.size, which the index provides.
 const promise = (async () => {
 const out = new Map<string, any>();
 try {
 const res = await fetch(cdnDataUrl(`/data/jobs-${locale}-index.json`));
 if (!res.ok) return out;
 const list = await res.json();
 if (!Array.isArray(list)) return out;
 for (const item of list) {
 const canonicalSlug = normalizeSeoText(String(item?.slug || ''));
 if (canonicalSlug && !out.has(canonicalSlug)) out.set(canonicalSlug, item);
 }
 } catch {
 // Ignore runtime fetch failures; keep SEO fallback.
 }
 jobsBySlugCacheByLocale[locale] = out;
 return out;
 })();
 jobsBySlugPromiseByLocale[locale] = promise;
 return promise;
}

/** Per-job detail cache (description + structured-data fields), keyed by job id.
 * Replaces the description fields the slim index drops; CDN-cached + memoised
 * here so repeat SPA navigations to the same job don't refetch. */
const jobDetailCache = new Map<string, any>();
async function loadJobDetail(jobId: string | undefined | null): Promise<any | null> {
 if (!jobId) return null;
 if (jobDetailCache.has(jobId)) return jobDetailCache.get(jobId);
 try {
 const res = await fetch(cdnDataUrl(`/data/job-detail/${jobId}.json`));
 if (!res.ok) {
 jobDetailCache.set(jobId, null);
 return null;
 }
 const detail = await res.json();
 jobDetailCache.set(jobId, detail);
 return detail;
 } catch {
 jobDetailCache.set(jobId, null);
 return null;
 }
}

/**
 * Get the total number of unique active jobs from the loaded dataset.
 * Returns a rounded-down label like "1500+" for SEO titles, or null if
 * data hasn't loaded yet (fallback to static title).
 */
async function getActiveJobCountLabel(locale: Locale): Promise<string | null> {
 if (totalActiveJobCount !== null) {
 const rounded = Math.floor(totalActiveJobCount / 100) * 100;
 return `${rounded}+`;
 }
 try {
 // Read the count from the 221 B (br) shard manifest instead of downloading a
 // 21k-record index just to call `.size` on it. This runs on EVERY job-board
 // listing page, so before the canton-shard pipeline it pulled the full
 // locale index into every canton SERP on its own — independently of
 // JobBoard's loader. Sharding the board without fixing this would have
 // moved the bytes between modules, not removed them.
 //
 // Count is locale-invariant (same job set, only its strings are localised),
 // so one manifest serves all four locales.
 const res = await fetch(cdnDataUrl(JOB_CANTON_MANIFEST_PATH));
 if (res.ok) {
 const manifest = (await res.json()) as Partial<CantonShardManifest> | null;
 const total = manifest?.total;
 if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
 totalActiveJobCount = total;
 const rounded = Math.floor(total / 100) * 100;
 return rounded > 0 ? `${rounded}+` : null;
 }
 }
 // Manifest missing (pre-shard deploy, CDN propagation lag) → fall back to
 // the index. Costlier but correct: the label keeps working on any deploy
 // where the shard set has not published yet.
 const map = await loadJobsBySlug(locale);
 // Each slug maps to one job object now (per-locale shard has no
 // cross-locale slug aliases). Map.size == active job count.
 totalActiveJobCount = map.size;
 const rounded = Math.floor(totalActiveJobCount / 100) * 100;
 return rounded > 0 ? `${rounded}+` : null;
 } catch {
 return null;
 }
}

/**
 * Resolve ONE slim job record by slug, cheapest path first.
 *
 * Job-detail pages need exactly one record, but the only way to get it used to
 * be `loadJobsBySlug` — i.e. download and index the entire locale corpus. Now
 * that per-canton shards exist the same record is two small fetches away, both
 * of which the page is likely to have already made:
 *
 *   1. the slug's ~16 KB slug-map shard → `{ id, canton }`  (the job-detail
 *      route already ensures this for locale switching / bridge resolution);
 *   2. that canton's job shard → the record, by stable id  (JobBoard fetches
 *      the same file for its listing, so this is usually an HTTP/IDB hit).
 *
 * Falls back to the full index whenever either step misses — an unknown slug,
 * a job whose canton is absent, a pre-shard deploy, or CDN propagation lag.
 * The fallback is what keeps this correct rather than merely fast: it must
 * stay, because a job-detail page that silently resolves to `null` loses its
 * JobPosting structured data (CLAUDE.md rule #3) and its meta description.
 */
async function loadJobSlimBySlug(cleanSlug: string, locale: Locale): Promise<any | null> {
 try {
 await ensureJobSlugEntriesLoaded([cleanSlug]);
 const meta = getJobMetaForSlug(cleanSlug);
 if (meta?.id && meta?.canton) {
 const shard = await fetchJobsForCanton(meta.canton, locale);
 const hit = shard.find((j) => (j as { id?: unknown }).id === meta.id);
 if (hit) return hit;
 }
 } catch {
 // Fall through to the corpus-wide loader below.
 }
 const map = await loadJobsBySlug(locale);
 return map.get(cleanSlug) ?? null;
}

async function resolveJobSeoBySlug(
 slug: string,
 locale: Locale,
 canonicalLocalePath: string
): Promise<{
 title: string;
 description: string;
 keywords: string;
 logoUrl: string;
 structuredData: Record<string, any> | Record<string, any>[];
} | null> {
 const cleanSlug = normalizeSeoText(slug);
 if (!cleanSlug) return null;
 const slim = await loadJobSlimBySlug(cleanSlug, locale);
 if (!slim) return null;
 // The slim index lacks description + structured-data fields (postalCode,
 // streetAddress, baseSalary). Lazy-fetch the per-job detail and merge so the
 // JobPosting builder still gets all 9 mandatory fields (CLAUDE.md rule #3).
 const detail = await loadJobDetail(slim?.id);
 const job = detail ? { ...slim, ...detail } : slim;
 const localizedTitle = normalizeSeoText(String(job?.titleByLocale?.[locale] || job?.title || ''));
 const localizedDescription = compactSeoDescription(String(job?.descriptionByLocale?.[locale] || job?.description || ''), 360);
 if (!localizedTitle || !localizedDescription) return null;
 const logoUrl = companyLogoFromJob(job);
 const canonicalUrl = `${BASE_URL}${canonicalLocalePath}`;
 const address = resolveJobAddress(job);
 const salary = resolveJobSalary(job);
 // isRemote detection mirrors build-plugins/jobsSeoPagesPlugin.ts's regex so
 // both paths agree on the same job. Computed BEFORE canonicalInput (rather
 // than after canonicalSchema, as before) so it can be threaded into the
 // canonical builder — otherwise buildJobPostingSchema never learns a job is
 // remote and silently omits `jobLocationType`/`applicantLocationRequirements`
 // on the SPA path, unlike the SSG path (parity fix).
 const isRemote = /remote|telelavor|smart[-\s]?working|home office|hybrid/i.test(
 `${localizedTitle} ${localizedDescription} ${job?.location || ''}`
 );
 // Delegate to the canonical builder — see
 // build-plugins/shared/jobPostingSchema.ts. This guarantees all 9
 // mandatory JobPosting fields (CLAUDE.md rule #3) with realistic defaults,
 // plus industry/occupationalCategory/applicantLocationRequirements when the
 // source data supports them.
 const canonicalInput: JobInput = {
 id: job?.id,
 slug: job?.slug || cleanSlug,
 title: localizedTitle,
 description: String(job?.descriptionByLocale?.[locale] || job?.description || localizedDescription),
 company: job?.company,
 companyKey: job?.companyKey,
 companyLogoUrl: logoUrl,
 addressLocality: address.locality,
 addressRegion: address.region,
 addressCountry: address.country,
 postalCode: address.postalCode,
 streetAddress: address.streetAddress,
 postedDate: job?.postedDate,
 crawledAt: job?.crawledAt,
 updatedAt: job?.updatedAt,
 contract: job?.contract,
 salaryMin: salary?.minValue ?? null,
 salaryMax: salary?.maxValue ?? null,
 salaryCurrency: salary?.currency,
 sector: job?.category,
 category: job?.category,
 url: job?.url,
 isRemote,
 };
 const canonicalSchema = buildJobPostingSchema(canonicalInput, {
 locale,
 url: canonicalUrl,
 baseUrl: BASE_URL,
 });
 // Job-specific FAQPage (build-plugins/shared/jobPostingFaq.ts) — same
 // deterministic template the static SSG plugin uses, so the client-hydrated
 // SPA content matches the prerendered HTML for a client-side navigation to
 // this job (content-parity rule, CLAUDE.md § Static SEO Pages).
 //
 // Canton for the FAQ's G-permit answer MUST use resolveJobCanton (the same
 // resolver JobBoard.tsx uses for its visible accordion, via `detailJobCanton
 // = resolveJobCanton(selectedJob)`) rather than `address.region`.
 // `resolveJobAddress()` above defaults straight to 'TI' whenever both
 // `addressRegion` and `canton` are unset, without ever consulting
 // `location` — for jobs where only `location`/`addressLocality` names a
 // non-Ticino city (real cases in the dataset, e.g. Valais hospital
 // listings), that default disagreed with JobBoard.tsx's more careful
 // city-aware resolution and served the wrong canton's legal border-permit
 // guidance in the FAQ's structured data (review finding on PR #4595).
 const faqCanton = resolveJobCanton(job);
 const isTicino = faqCanton === 'TI';
 const cantonDisplay = getCantonDisplayName(faqCanton, locale);
 const faqOpts: BuildJobPostingFaqOptions = {
 locale,
 jobUrl: String(job?.url || canonicalUrl),
 cantonDisplay,
 isTicino,
 isRemote,
 };
 const jobFaqPairs = buildJobPostingFaqPairs(canonicalSchema, faqOpts);
 const faqPageSchema: Record<string, any> | null = jobFaqPairs.length > 0
 ? {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: jobFaqPairs.map((f) => ({
 '@type': 'Question',
 name: f.q,
 acceptedAnswer: { '@type': 'Answer', text: f.a },
 })),
 }
 : null;
 // Multi-location jobs carry a non-geographic blob (e.g. "ganz Schweiz",
 // "toute la Suisse") in `location` — never inject it as the city, or the
 // authoritative job title (→ document.title + og:title) blows the cap and
 // dilutes the keyword. Mirrors the JobBoard.tsx SPA guard.
 const titleCity = isMultiLocation(job?.location) ? '' : String(job?.location || '');
 return {
 title: buildJobTitleWithLocation(localizedTitle, String(job?.company || ''), titleCity, locale),
 description: localizedDescription,
 keywords: localizedJobKeywords(locale, localizedTitle, String(job?.company || ''), String(job?.location || '')),
 logoUrl,
 structuredData: faqPageSchema ? [canonicalSchema, faqPageSchema] : canonicalSchema,
 };
}

function parseSerpExperimentTargets(raw: string): Set<string> {
 const normalized = (raw || '').trim();
 if (!normalized) return new Set();
 if (normalized === '*') return new Set(['*']);
 return new Set(
 normalized
 .split(',')
 .map((item) => item.trim())
 .filter(Boolean)
 );
}

function restoreCachedSerpExperimentState(): void {
 if (typeof window === 'undefined') return;
 try {
 const cachedRaw = window.localStorage.getItem(SERP_EXPERIMENT_CACHE_KEY);
 if (!cachedRaw) return;
 const cached = JSON.parse(cachedRaw) as {
 enabled?: boolean;
 variant?: string;
 targets?: string;
 year?: string;
 };
 serpExperimentState.enabled = Boolean(cached.enabled);
 serpExperimentState.variant = (cached.variant === 'year_intent' || cached.variant === 'intent_simulation')
 ? cached.variant
 : 'control';
 serpExperimentState.targets = parseSerpExperimentTargets(cached.targets || '');
 serpExperimentState.year = (cached.year || '2026').trim() || '2026';
 } catch {
 // Ignore malformed cache
 }
}

function loadSerpExperimentState(): void {
 if (typeof window === 'undefined' || serpExperimentLoadPromise) return;
 restoreCachedSerpExperimentState();
 serpExperimentLoadPromise = (async () => {
 try {
 const { getConfigValue } = await import('./firebase');
 const [enabledRaw, variantRaw, targetsRaw, yearRaw] = await Promise.all([
 getConfigValue('SEO_SERP_EXPERIMENT_ENABLED'),
 getConfigValue('SEO_SERP_EXPERIMENT_VARIANT'),
 getConfigValue('SEO_SERP_EXPERIMENT_TARGETS'),
 getConfigValue('SEO_SERP_EXPERIMENT_YEAR'),
 ]);
 serpExperimentState.enabled = enabledRaw === 'true';
 serpExperimentState.variant = (variantRaw === 'year_intent' || variantRaw === 'intent_simulation')
 ? variantRaw
 : 'control';
 serpExperimentState.targets = parseSerpExperimentTargets(targetsRaw);
 serpExperimentState.year = (yearRaw || '2026').trim() || '2026';
 // RC override vs defaults is expected behavior, not a warning condition.
 // The AdminPanel surfaces this via getSerpExperimentDiagnostics().hasRemoteOverride
 // for operators who need to inspect drift — no console channel needed.
 try {
 window.localStorage.setItem(SERP_EXPERIMENT_CACHE_KEY, JSON.stringify({
 enabled: serpExperimentState.enabled,
 variant: serpExperimentState.variant,
 targets: Array.from(serpExperimentState.targets).join(','),
 year: serpExperimentState.year,
 }));
 } catch {
 // Storage not available; keep in-memory config only
 }
 } catch {
 // Keep fallback state from cache/defaults
 } finally {
 serpExperimentState.loaded = true;
 }
 })();
}

export function getSerpExperimentDiagnostics(): {
 loaded: boolean;
 runtime: { enabled: boolean; variant: SerpExperimentVariant; targets: string; year: string };
 defaults: { enabled: boolean; variant: SerpExperimentVariant; targets: string; year: string };
 hasRemoteOverride: boolean;
} {
 loadSerpExperimentState();
 const runtimeTargets = Array.from(serpExperimentState.targets).join(',');
 const normalizedTargets = runtimeTargets || '';
 const hasRemoteOverride =
 serpExperimentState.enabled !== SERP_EXPERIMENT_DEFAULTS.enabled ||
 serpExperimentState.variant !== SERP_EXPERIMENT_DEFAULTS.variant ||
 normalizedTargets !== SERP_EXPERIMENT_DEFAULTS.targets ||
 serpExperimentState.year !== SERP_EXPERIMENT_DEFAULTS.year;

 return {
 loaded: serpExperimentState.loaded,
 runtime: {
 enabled: serpExperimentState.enabled,
 variant: serpExperimentState.variant,
 targets: normalizedTargets,
 year: serpExperimentState.year,
 },
 defaults: SERP_EXPERIMENT_DEFAULTS,
 hasRemoteOverride,
 };
}

function shouldApplySerpExperiment(section: string): boolean {
 if (!serpExperimentState.enabled || serpExperimentState.variant === 'control') return false;
 if (serpExperimentState.targets.size === 0) return false;
 if (serpExperimentState.targets.has('*')) return true;
 return serpExperimentState.targets.has(section);
}

// Returns null when the path doesn't match a known calculator/tool intent —
// callers must skip the experiment entirely rather than fall back to a
// generic label. The vocabulary here is calculator-shaped by design ("oltre
// 20km", "cambio CHF EUR", "pensione frontalieri"); pages outside that set
// (blog articles, guides, listings) have their own editorial titles, and
// slapping an unrelated "| simulazione | 2026" suffix on them is a
// content/intent mismatch that measurably drags down CTR (issue #5479) —
// the same reasoning that already excludes job-detail pages below.
//
// The `pension` entry is intentionally scoped to the two ACTUAL
// retirement-planning tools (`calcola-previdenza`, `simula-terzo-pilastro`),
// not the whole `/tasse-e-pensione/` section (issue #5481): most pages under
// that prefix — dichiarazione-redditi, ristorni-fiscali, scadenze-fiscali,
// credito-imposta, aliquote-imposta-alla-fonte-*, quiz-fiscale,
// festivita-ticino, tasse-svizzere-frontalieri, nuova-legge-frontalieri-2026 —
// are about tax filing/rates/deadlines, not pension, so tagging them
// "pensione frontalieri" is the same content-mismatch defect #5479 fixed,
// just with a real (over-broad) match instead of the generic fallback.
export function getSerpIntentLabel(path: string, locale: Locale): string | null {
 const map = {
 it: {
 over20: 'oltre 20km',
 within20: 'entro 20km',
 exchange: 'cambio CHF EUR',
 pension: 'pensione frontalieri',
 },
 en: {
 over20: 'over 20km',
 within20: 'within 20km',
 exchange: 'CHF EUR exchange',
 pension: 'cross-border pension',
 },
 de: {
 over20: 'ueber 20km',
 within20: 'innerhalb 20km',
 exchange: 'CHF EUR wechsel',
 pension: 'grenzgaenger rente',
 },
 fr: {
 over20: 'au-dela de 20km',
 within20: 'dans 20km',
 exchange: 'change CHF EUR',
 pension: 'retraite frontalier',
 },
 }[locale];

 if (path.includes('oltre-20km')) return map.over20;
 if (path.includes('entro-20km')) return map.within20;
 if (path.includes('cambio-franco-euro')) return map.exchange;
 if (path.includes('calcola-previdenza') || path.includes('simula-terzo-pilastro')) return map.pension;
 return null;
}

function applySerpTitleDescriptionVariant(
 section: string,
 path: string,
 locale: Locale,
 title: string,
 description: string,
): { title: string; description: string; variant: SerpExperimentVariant } {
 if (!shouldApplySerpExperiment(section)) {
 return { title, description, variant: 'control' };
 }

 const intent = getSerpIntentLabel(path, locale);
 if (intent === null) {
 // No calculator/tool intent matches this path — the experiment's
 // suffix vocabulary has nothing relevant to say here, so leave the
 // page's own title/description untouched instead of appending a
 // mismatched generic tag (see getSerpIntentLabel above).
 return { title, description, variant: 'control' };
 }

 const MAX_TITLE_LENGTH = 60;
 const MAX_DESCRIPTION_LENGTH = 160;
 const year = serpExperimentState.year;
 const cleanTitle = title.replace(/\s+\|\s+Frontaliere Ticino$/i, '').trim();

 // Clause-boundary truncation (shared, build-plugins/shared/titleSuffix.ts):
 // strips dangling ` | X` pipe segments AND dangling conjunctions/prepositions
 // ("Stipendio netto frontaliere 2026: come | simulazione | 2026", #3510).
 // A result under 10 chars falls back to the untruncated title below.
 const safeTruncate = truncateTitleAtClauseBoundary;

 if (serpExperimentState.variant === 'year_intent') {
 const suffix = ` ${year} | ${intent}`;
 let experimentTitle: string;
 if (cleanTitle.length + suffix.length <= MAX_TITLE_LENGTH) {
 experimentTitle = `${cleanTitle}${suffix}`;
 } else {
 const maxClean = MAX_TITLE_LENGTH - suffix.length;
 const truncatedClean = maxClean >= MIN_PEELED_TITLE_CHARS ? safeTruncate(cleanTitle, maxClean) : '';
 experimentTitle = truncatedClean.length >= MIN_PEELED_TITLE_CHARS ? `${truncatedClean}${suffix}` : title;
 }
 const experimentDesc = `${description} Aggiornato ${year} con focus: ${intent}.`;
 return {
 title: experimentTitle,
 description: experimentDesc.length <= MAX_DESCRIPTION_LENGTH ? experimentDesc : description,
 variant: 'year_intent',
 };
 }

 if (serpExperimentState.variant === 'intent_simulation') {
 const suffix = ` | ${intent} | ${year}`;
 let experimentTitle: string;
 if (cleanTitle.length + suffix.length <= MAX_TITLE_LENGTH) {
 experimentTitle = `${cleanTitle}${suffix}`;
 } else {
 const maxClean = MAX_TITLE_LENGTH - suffix.length;
 const truncatedClean = maxClean >= MIN_PEELED_TITLE_CHARS ? safeTruncate(cleanTitle, maxClean) : '';
 experimentTitle = truncatedClean.length >= MIN_PEELED_TITLE_CHARS ? `${truncatedClean}${suffix}` : title;
 }
 const experimentDesc = `${description} Simulazione aggiornata ${year} per ${intent}.`;
 return {
 title: experimentTitle,
 description: experimentDesc.length <= MAX_DESCRIPTION_LENGTH ? experimentDesc : description,
 variant: 'intent_simulation',
 };
 }

 return { title, description, variant: 'control' };
}

function isSearchReferrer(): { fromSearch: boolean; host: string } {
 if (typeof document === 'undefined' || !document.referrer) {
 return { fromSearch: false, host: 'direct' };
 }
 try {
 const host = new URL(document.referrer).hostname.toLowerCase();
 const fromSearch = SEARCH_ENGINES.some((engine) => host.includes(engine));
 return { fromSearch, host };
 } catch {
 return { fromSearch: false, host: 'unknown' };
 }
}

function withNormalizedStructuredData(map: Record<string, SEOMetadata>): Record<string, SEOMetadata> {
 const out: Record<string, SEOMetadata> = {};
 for (const [key, meta] of Object.entries(map)) {
 out[key] = meta.structuredData
 ? { ...meta, structuredData: normalizeStructuredData(meta.structuredData) }
 : meta;
 }
 return out;
}

function normalizeSeoEntry(meta: SEOMetadata): SEOMetadata {
 return meta.structuredData
 ? { ...meta, structuredData: normalizeStructuredData(meta.structuredData) }
 : meta;
}

// ─── speakable removed ─────────────────────────────────────────────────
// Google's SpeakableSpecification is limited to news publishers; auto-
// injection was triggering SEMrush "unrecognized property" errors on
// WebApplication/Dataset schemas. Pass-through retained to preserve the
// pipeline shape; safe to drop once call sites are refactored.
function withSpeakable(map: Record<string, SEOMetadata>): Record<string, SEOMetadata> {
 return map;
}

function titleizeGlossaryTermId(termId: string): string {
 // Converts camelCase / snake_case ids into a readable label (IT-friendly baseline)
 const base = termId
 .replace(/_/g, ' ')
 .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
 .replace(/(\d+)/g, ' $1 ')
 .replace(/\s+/g, ' ')
 .trim();

 // Preserve common acronyms
 return base
 .replace(/\bavs\b/gi, 'AVS')
 .replace(/\blpp\b/gi, 'LPP')
 .replace(/\bcu\b/gi, 'CU')
 .replace(/\bral\b/gi, 'RAL')
 .replace(/\bssn\b/gi, 'SSN')
 .replace(/\bsepa\b/gi, 'SEPA')
 .replace(/\bccnl\b/gi, 'CCNL')
 .replace(/\bipg\b/gi, 'IPG')
 .replace(/\bac\b/gi, 'AC')
 .replace(/\bcmu\b/gi, 'CMU')
 .replace(/\blamal\b/gi, 'LAMal')
 .replace(/\bnaspi\b/gi, 'NASpI');
}

function buildGlossarySeoMetadata(): Record<string, SEOMetadata> {
 return Object.fromEntries(
 ALL_GLOSSARY_TERM_IDS.map((termId) => {
 const route = { activeTab: 'glossario' as const, glossaryTerm: termId as any };
 const canonicalPath = buildPath(route, 'it');
 const label = titleizeGlossaryTermId(termId);
 const title = buildTitleWithBrand(`${label} (Glossario)`);
 // Real, number-forward definition from the shared registry (#4409) —
 // sibling of the SSG fallback in build-plugins/staticPagesPlugin.ts, both
 // read the SAME map so they can never drift back into the placeholder.
 // Fallback template only covers a term id added without a definition.
 const slug = canonicalPath.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
 const fullDescription = GLOSSARY_TERM_DEFINITIONS[slug]
 || `Definizione e spiegazione di ${label} per frontalieri (Svizzera–Italia): significato, contesto e impatto pratico.`;
 // Meta/og description capped to Google's ~170-char display limit
 // (tests/seo-description-length.test.ts) — structuredData below keeps the
 // full, untruncated definition for JSON-LD/AI-citation purposes.
 const description = truncateForMetaDescription(fullDescription);
 return [
 `glossario-${termId}`,
 {
 title,
 description,
 keywords: `glossario frontalieri, ${label}, significato ${label}, definizione ${label}, frontalieri ticino`,
 ogTitle: title,
 ogDescription: description,
 canonicalPath,
 structuredData: {
 '@context': 'https://schema.org',
 '@type': 'WebPage',
 name: `${label} (Glossario)`,
 url: `${BASE_URL}${canonicalPath}`,
 description: fullDescription,
 },
 } satisfies SEOMetadata,
 ];
 })
 ) as Record<string, SEOMetadata>;
}

function buildBorderCrossingSeoMetadata(): Record<string, SEOMetadata> {
 return Object.fromEntries(
 ALL_BORDER_CROSSING_IDS.map((crossingId) => {
 const route = { activeTab: 'guida' as const, guidaSubTab: 'border' as const, borderCrossing: crossingId as any };
 const canonicalPath = buildPath(route, 'it');
 // Label + <title> both come from the shared leaf module (#4828). This file
 // used to carry its own `titleizeBorderCrossingId` plus a literal copy of
 // the `Traffico dogana ${label} | Tempi attesa valico` template — the same
 // pair staticPagesPlugin emitted, duplicated verbatim. The SSG page and the
 // SPA runtime head MUST agree on the indexed title, so a cap applied to only
 // one of them would have left the runtime DOM over the 66-char budget on
 // exactly the long DE/FR crossings the cap exists for. One module, no drift
 // by construction (AGENTS.md non-negotiable #6).
 const label = borderCrossingLabel(crossingId);
 const title = buildBorderCrossingTitle(label);
 const description = buildBorderCrossingDescription(label);
 return [
 `valico-${crossingId}`,
 {
 title,
 description,
 keywords: `traffico dogana ${label}, tempi attesa dogana ${label}, valico ${label}, frontaliere ticino, valichi svizzera italia`,
 ogTitle: title,
 ogDescription: description,
 canonicalPath,
 structuredData: {
 '@context': 'https://schema.org',
 '@type': 'WebPage',
 // Must be the SAME string as <title> (reviewer catch on PR #5111, same
 // class fixed in borderMunicipalityPagesPlugin.ts): the raw
 // `Traffico dogana ${label}` here used to match `title` by accident
 // before the #4828 cap, and would diverge for exactly the long DE/FR
 // labels the cap exists for.
 name: title,
 url: `${BASE_URL}${canonicalPath}`,
 description,
 },
 } satisfies SEOMetadata,
 ];
 })
 ) as Record<string, SEOMetadata>;
}

/**
 * Hand-tuned SEO overrides for high-value border crossing pages.
 * These override the generic template in buildBorderCrossingSeoMetadata()
 * for crossings that rank in striking distance on GSC.
 */
const BORDER_CROSSING_SEO_OVERRIDES: Record<string, SEOMetadata> = {
 'valico-chiasso-centro': {
   title: 'Traffico Dogana Chiasso Centro e Brogeda | Tempi di Attesa e Coda',
   description: 'Traffico dogana Chiasso Centro e Brogeda: tempi di attesa in tempo reale, coda dogana, orari apertura e consigli per evitare le code. Guida pratica per frontalieri.',
   keywords: 'traffico dogana chiasso brogeda, tempi di attesa dogana chiasso, coda dogana chiasso, dogana chiasso centro, valico brogeda tempi, frontaliere ticino, code dogana chiasso',
   ogTitle: 'Traffico Dogana Chiasso Centro e Brogeda | Tempi di Attesa',
   ogDescription: 'Tempi di attesa dogana Chiasso Centro e Brogeda: coda in tempo reale, orari e consigli per frontalieri.',
   canonicalPath: '/guida-frontaliere/tempi-attesa-dogana/chiasso-centro/',
   structuredData: {
     '@context': 'https://schema.org',
     '@type': 'WebPage',
     name: 'Traffico dogana Chiasso Centro e Brogeda',
     url: `${BASE_URL}/guida-frontaliere/tempi-attesa-dogana/chiasso-centro/`,
     description: 'Tempi di attesa dogana Chiasso Centro e Brogeda: coda in tempo reale, orari e consigli per frontalieri.',
   },
 },
};

// ─── Core SEO entries (eagerly loaded) ───────────────────────────────
// Contains glossary + border-crossing entries (generated from data).
// Page, blog, and landing entries are lazy-loaded from services/seo/ chunks.
export const SEO_METADATA: Record<string, SEOMetadata> = withSpeakable(withNormalizedStructuredData({
 ...buildGlossarySeoMetadata(),
 ...buildBorderCrossingSeoMetadata(),
 ...BORDER_CROSSING_SEO_OVERRIDES,
}));

// ─── Lazy-loaded SEO chunks ──────────────────────────────────────────
// Page (~90 entries), blog (~270 entries), and landing (~23 entries)
// are code-split into separate chunks and loaded on demand.
let _pagesChunkCache: Record<string, SEOMetadata> | null = null;
let _blogChunkCache: Record<string, SEOMetadata> | null = null;
let _landingChunkCache: Record<string, SEOMetadata> | null = null;

async function loadPagesSeoChunk(): Promise<Record<string, SEOMetadata>> {
 if (_pagesChunkCache) return _pagesChunkCache;
 const { default: entries } = await retryImport(() => import('./seo/seo-pages'), 'pages');
 _pagesChunkCache = withSpeakable(entries);
 return _pagesChunkCache;
}

/**
 * Per-shard loaders for the blog SEO metadata.
 *
 * The specifiers must stay literal — that is what lets Rollup keep each shard a
 * separate lazy chunk. Keys and ORDER mirror `BLOG_SEO_SHARD_IDS`;
 * `tests/seo-blog-shard-index.test.ts` fails if the two drift, including when a new
 * `seo-blog-N.ts` lands on disk and nothing here loads it.
 */
const BLOG_SEO_SHARD_LOADERS: Record<BlogSeoShardId, () => Promise<{ default: Record<string, SEOMetadata> }>> = {
 'blog': () => retryImport(() => import('./seo/seo-blog'), 'blog'),
 'blog-2': () => retryImport(() => import('./seo/seo-blog-2'), 'blog-2'),
 'blog-3': () => retryImport(() => import('./seo/seo-blog-3'), 'blog-3'),
 'blog-4': () => retryImport(() => import('./seo/seo-blog-4'), 'blog-4'),
 'blog-5': () => retryImport(() => import('./seo/seo-blog-5'), 'blog-5'),
 'blog-6': () => retryImport(() => import('./seo/seo-blog-6'), 'blog-6'),
 'blog-7': () => retryImport(() => import('./seo/seo-blog-7'), 'blog-7'),
 'blog-ch': () => retryImport(() => import('./seo/seo-blog-ch'), 'blog-ch'),
};

const _blogShardPromises = new Map<BlogSeoShardId, Promise<Record<string, SEOMetadata>>>();

/** Load one shard, deduped across concurrent callers. */
function loadBlogSeoShard(id: BlogSeoShardId): Promise<Record<string, SEOMetadata>> {
 let promise = _blogShardPromises.get(id);
 if (!promise) {
 promise = BLOG_SEO_SHARD_LOADERS[id]().then((m) => m.default);
 // Drop a rejected shard so a transient chunk 404 can be retried instead of
 // poisoning every later lookup with the same cached rejection.
 promise.catch(() => { _blogShardPromises.delete(id); });
 _blogShardPromises.set(id, promise);
 }
 return promise;
}

/**
 * `blog-<id> → shard ordinal`, emitted by `build-plugins/seoBlogShardIndexPlugin.ts`.
 *
 * Resolves to `{}` whenever the virtual module is unavailable — under Vitest, where
 * `vitest.config.ts` aliases it to an empty stub because the build plugins are not
 * loaded, and on any load failure. An empty index simply routes every lookup down the
 * load-all fallback, i.e. the exact behaviour this replaced.
 */
let _blogShardIndexPromise: Promise<Record<string, number>> | null = null;
function loadBlogSeoShardIndex(): Promise<Record<string, number>> {
 if (!_blogShardIndexPromise) {
 _blogShardIndexPromise = import('virtual:seo-blog-shard-index')
 .then((m) => (m.default ?? {}) as Record<string, number>)
 .catch(() => ({}));
 }
 return _blogShardIndexPromise;
}

/**
 * Resolve ONE blog SEO entry, fetching only the shard that owns it.
 *
 * Falls back to loading every shard when the index has no answer or the answer does
 * not pan out — a new article whose build predates the index, a corrupt mapping, a
 * failed chunk. The fallback is the pre-existing code path, so the worst case is the
 * old cost, never a missing entry: this feeds the canonical/title/JSON-LD of the
 * site's main SEO surface.
 */
async function loadBlogSeoEntry(sectionKey: string): Promise<SEOMetadata | undefined> {
 const index = await loadBlogSeoShardIndex();
 const ordinal = index[sectionKey];
 const shardId = typeof ordinal === 'number' ? BLOG_SEO_SHARD_IDS[ordinal] : undefined;
 if (shardId) {
 try {
 const entry = (await loadBlogSeoShard(shardId))[sectionKey];
 if (entry) return entry;
 } catch { /* fall through to the load-all path */ }
 }
 return (await loadBlogSeoChunk())[sectionKey];
}

/**
 * Every shard, merged. Kept for `getAllSeoMetadata()` (tests + build tooling) and as
 * the fallback behind `loadBlogSeoEntry`. Merging in `BLOG_SEO_SHARD_IDS` order is
 * what preserves last-shard-wins for the ~983 keys defined in two shards.
 */
async function loadBlogSeoChunk(): Promise<Record<string, SEOMetadata>> {
 if (_blogChunkCache) return _blogChunkCache;
 const shards = await Promise.all(BLOG_SEO_SHARD_IDS.map((id) => loadBlogSeoShard(id)));
 _blogChunkCache = Object.assign({}, ...shards) as Record<string, SEOMetadata>;
 return _blogChunkCache;
}

async function loadLandingSeoChunk(): Promise<Record<string, SEOMetadata>> {
 if (_landingChunkCache) return _landingChunkCache;
 const { default: entries } = await retryImport(() => import('./seo/seo-landing'), 'landing');
 _landingChunkCache = withSpeakable(entries);
 return _landingChunkCache;
}

/**
 * Resolve SEO metadata for a given section key.
 * Core entries (glossary, border-crossing) are checked synchronously.
 * Page, blog, and landing entries are lazy-loaded from code-split chunks.
 */
async function getSeoEntry(sectionKey: string): Promise<SEOMetadata> {
 // 1. Check core entries (already in memory — glossary, border-crossing)
 if (SEO_METADATA[sectionKey]) return SEO_METADATA[sectionKey];

 // 2. Lazy-load ONLY the shard that owns this blog-* key (falls back to all)
 if (sectionKey.startsWith('blog-')) {
 try {
 const entry = await loadBlogSeoEntry(sectionKey);
 if (entry) return normalizeSeoEntry(entry);
 } catch { /* fall through to default */ }
 }

 // 3. Lazy-load landing chunk for landing-* keys
 if (sectionKey.startsWith('landing-')) {
 try {
 const landingEntries = await loadLandingSeoChunk();
 const entry = landingEntries[sectionKey];
 if (entry) return normalizeSeoEntry(entry);
 } catch { /* fall through to default */ }
 }

 // 4. Lazy-load pages chunk for all other keys (calculator, comparators, guide, etc.)
 try {
 const pagesEntries = await loadPagesSeoChunk();
 const entry = pagesEntries[sectionKey];
 if (entry) return normalizeSeoEntry(entry);
 } catch { /* fall through to default */ }

 // 5. Fallback to calculator from pages chunk
 try {
 const pagesEntries = await loadPagesSeoChunk();
 if (pagesEntries.calculator) return normalizeSeoEntry(pagesEntries.calculator);
 } catch { /* ignore */ }

 return SEO_METADATA.calculator ?? { title: 'Frontaliere Ticino', description: '', keywords: '', ogTitle: '', ogDescription: '', canonicalPath: '/' };
}

/**
 * Load ALL SEO metadata (core + blog + landing) for exhaustive iteration.
 * Used by tests and build-time tooling. NOT for runtime hot paths.
 */
export async function getAllSeoMetadata(): Promise<Record<string, SEOMetadata>> {
 const [pagesEntries, blogEntries, landingEntries] = await Promise.all([
 loadPagesSeoChunk(),
 loadBlogSeoChunk(),
 loadLandingSeoChunk(),
 ]);
 return {
 ...SEO_METADATA,
 ...withNormalizedStructuredData(pagesEntries),
 ...withNormalizedStructuredData(blogEntries),
 ...withNormalizedStructuredData(landingEntries),
 };
}

const SEO_SECTION_TITLE_KEY_MAP: Record<string, string> = {
 calculator: 'nav.simulator',
 whatif: 'simulator.whatif',
 payslip: 'payslip.title',
 ral: 'comparators.ral',
 bonus: 'comparators.bonus',
 'parental-leave': 'comparators.parentalLeave',
 residency: 'comparators.residency',
 salaryQuiz: 'salaryQuiz.navLabel',
 exchange: 'comparators.exchange',
 traffic: 'comparators.traffic',
 mobile: 'comparators.mobile',
 banks: 'comparators.banks',
 health: 'comparators.health',
 transport: 'comparators.transport',
 jobs: 'comparators.jobs',
 shopping: 'comparators.shopping',
 'cost-of-living': 'comparators.costOfLiving',
 'tax-return': 'comparators.taxReturn',
 'tax-return-italia': 'taxReturn.title.italia',
 'tax-return-svizzera': 'taxReturn.title.svizzera',
 nursery: 'comparators.nursery',
 renovation: 'comparators.renovation',
 fisco: 'nav.fisco',
 pension: 'pension.planner',
 pillar3: 'pension.pillar3',
 quiz: 'guide.tabs.quiz',
 taxCredit: 'taxCredit.title',
 withholdingRates: 'withholdingRates.title',
 guide: 'nav.guida',
 firstDay: 'guide.tabs.firstDay',
 permits: 'guide.tabs.permits',
 border: 'guide.tabs.border',
 unemployment: 'guide.tabs.unemployment',
 carTransfer: 'guide.tabs.carTransfer',
 'car-cost': 'carCost.title',
 'permit-compare': 'permitCompare.title',
 'border-map': 'comparators.borderMap',
 vita: 'nav.vita',
 livingCH: 'guide.tabs.livingCH',
 livingIT: 'guide.tabs.livingIT',
 companies: 'guide.tabs.companies',
 schools: 'guide.tabs.schools',
 places: 'guide.tabs.places',
 municipalities: 'guide.tabs.municipalities',
 calendar: 'guide.tabs.calendar',
 holidays: 'guide.tabs.holidays',
 morning: 'guide.tabs.morning',
 ristorni: 'guide.tabs.ristorni',
 stats: 'nav.stats',
 livability: 'livability.title',
 jobsObservatory: 'stats.tabJobsObservatory',
 salaryCompare: 'salaryCompare.title',
 trafficHistory: 'stats.trafficHistory',
 unemploymentStats: 'stats.tabUnemployment',
 mortgageComparison: 'stats.tabMortgage',
 fuelPrices: 'stats.tabFuelPrices',
 healthPremiums: 'stats.tabHealthPremiums',
 blog: 'nav.blog',
 glossario: 'glossary.title',
 faq: 'faq.title',
 dialetto: 'dialect.title',
 sitemap: 'sitemap.title',
 contracts: 'contracts.title',
 'tfr-calculator': 'tfr.title',
 'permit-quiz': 'permitQuiz.title',
 'frontaliere-wizard': 'frontaliereWizard.title',
 'tredicesima': 'tredicesima.title',
 'weekly-digest': 'weeklyDigest.title',
 'tool-of-week': 'toolOfWeek.title',
 feedback: 'footer.improveTitle',
 contact: 'contact.title',
 consulting: 'consulting.title',
 partners: 'partners.title',
 forum: 'forum.title',
 jobboard: 'jobBoard.seoTitle',
 dashboard: 'profile.title',
 gamification: 'gamification.title',
 privacy: 'consent.privacyLink',
};

const SEO_SECTION_DESCRIPTION_KEY_MAP: Record<string, string> = {
 calculator: 'app.subtitle',
 payslip: 'payslip.subtitle',
 'permit-compare': 'permitCompare.subtitle',
 residency: 'residency.subtitle',
 carTransfer: 'carTransfer.subtitle',
 'car-cost': 'carCost.subtitle',
 salaryCompare: 'salaryCompare.subtitle',
 livability: 'livability.subtitle',
 jobsObservatory: 'stats.jobsObservatory.subtitle',
 fuelPrices: 'fuelPrices.subtitle',
 healthPremiums: 'healthPremiums.subtitle',
 taxCredit: 'taxCredit.subtitle',
 withholdingRates: 'withholdingRates.subtitle',
 jobboard: 'jobBoard.seoDescription',
 contact: 'contact.subtitle',
 consulting: 'consulting.subtitle',
 partners: 'partners.subtitle',
 holidays: 'holidays.seoDescription',
 health: 'seo.health.description',
 exchange: 'seo.exchange.description',
 traffic: 'seo.traffic.description',
 pension: 'seo.pension.description',
 pillar3: 'seo.pillar3.description',
 permits: 'seo.permits.description',
 'cost-of-living': 'seo.costOfLiving.description',
 'tax-return': 'seo.taxReturn.description',
 banks: 'seo.banks.description',
 mobile: 'seo.mobile.description',
 transport: 'seo.transport.description',
 shopping: 'seo.shopping.description',
 guide: 'seo.guide.description',
 fisco: 'seo.fisco.description',
 stats: 'seo.stats.description',
 vita: 'seo.vita.description',
 blog: 'seo.blog.description',
 // SPA section landings that previously fell through to the generic
 // buildLocalizedSeoFallbackDescription() in en/de/fr, producing duplicate
 // meta descriptions (SearchAtlas non_unique_meta_desc). Each now resolves
 // a unique, section-specific description key in all 4 locales.
 whatif: 'seo.whatif.description',
 ral: 'seo.ral.description',
 bonus: 'seo.bonus.description',
 'parental-leave': 'seo.parentalLeave.description',
 salaryQuiz: 'seo.salaryQuiz.description',
 jobs: 'seo.jobs.description',
 'tax-return-italia': 'seo.taxReturnItalia.description',
 'tax-return-svizzera': 'seo.taxReturnSvizzera.description',
 nursery: 'seo.nursery.description',
 renovation: 'seo.renovation.description',
 quiz: 'seo.quiz.description',
 firstDay: 'seo.firstDay.description',
 border: 'seo.border.description',
 unemployment: 'seo.unemployment.description',
 'border-map': 'seo.borderMap.description',
 livingCH: 'seo.livingCH.description',
 livingIT: 'seo.livingIT.description',
 companies: 'seo.companies.description',
 schools: 'seo.schools.description',
 places: 'seo.places.description',
 municipalities: 'seo.municipalities.description',
 calendar: 'seo.calendar.description',
 morning: 'seo.morning.description',
 ristorni: 'seo.ristorni.description',
 trafficHistory: 'seo.trafficHistory.description',
 unemploymentStats: 'seo.unemploymentStats.description',
 mortgageComparison: 'seo.mortgageComparison.description',
 glossario: 'seo.glossario.description',
 faq: 'seo.faq.description',
 dialetto: 'seo.dialetto.description',
 sitemap: 'seo.sitemap.description',
 contracts: 'seo.contracts.description',
 'tfr-calculator': 'seo.tfrCalculator.description',
 'permit-quiz': 'seo.permitQuiz.description',
 'frontaliere-wizard': 'seo.frontaliereWizard.description',
 tredicesima: 'seo.tredicesima.description',
 'weekly-digest': 'seo.weeklyDigest.description',
 'tool-of-week': 'seo.toolOfWeek.description',
 feedback: 'seo.feedback.description',
 forum: 'seo.forum.description',
 dashboard: 'seo.dashboard.description',
 gamification: 'seo.gamification.description',
 privacy: 'seo.privacy.description',
};

function translateIfExists(key: string | undefined, cantonCode?: string): string | null {
 if (!key) return null;
 const value = t(key, getCantonI18nParams(cantonCode));
 return value && value !== key ? value : null;
}

function getLocalizedSeoKeywords(sectionTitle: string, locale: Locale, fallbackKeywords: string): string {
 if (locale === 'it') return fallbackKeywords;
 const normalizedTitle = sectionTitle.toLowerCase();
 if (locale === 'en') {
 return `${normalizedTitle}, cross-border workers ticino, swiss net salary, taxes switzerland italy, frontaliereticino`;
 }
 if (locale === 'de') {
 return `${normalizedTitle}, grenzgaenger tessin, nettolohn schweiz, steuern schweiz italien, frontaliereticino`;
 }
 if (locale === 'fr') {
 return `${normalizedTitle}, frontaliers tessin, salaire net suisse, impots suisse italie, frontaliereticino`;
 }
 return fallbackKeywords;
}

function buildLocalizedSeoFallbackDescription(sectionTitle: string, locale: Locale): string {
 const templates: Record<Locale, string> = {
 it: `${sectionTitle}. Strumenti pratici, dati aggiornati e guide affidabili per frontalieri tra Svizzera e Italia.`,
 en: `${sectionTitle}. Practical tools, updated data and reliable guides for cross-border workers between Switzerland and Italy.`,
 de: `${sectionTitle}. Praktische Tools, aktuelle Daten und verlässliche Ratgeber für Grenzgänger zwischen der Schweiz und Italien.`,
 fr: `${sectionTitle}. Outils pratiques, données à jour et guides fiables pour les frontaliers entre la Suisse et l'Italie.`,
 };
 return templates[locale];
}

function buildLocalizedUnknownSectionTitle(section: string, locale: Locale): string {
 const raw = section
 .replace(/^landing-/, '')
 .replace(/^blog-/, '')
 .replace(/^glossario-/, '')
 .replace(/^valico-/, '')
 .replace(/^jobboard-/, '')
 .replace(/[-_]+/g, ' ')
 .trim();
 const human = raw ? raw.replace(/\b\w/g, (c) => c.toUpperCase()) : section;
 const prefix: Record<Locale, string> = {
 it: 'Pagina',
 en: 'Page',
 de: 'Seite',
 fr: 'Page',
 };
 return `${prefix[locale]} ${human}`;
}

function resolveLocalizedSeoContent(section: string, metadata: SEOMetadata, locale: Locale, cantonCode?: string): {
 title: string;
 description: string;
 keywords: string;
} {
 if (locale === 'it') {
 return {
 title: metadata.title,
 description: metadata.description,
 keywords: metadata.keywords,
 };
 }

 const titleKey = SEO_SECTION_TITLE_KEY_MAP[section];
 const descriptionKey = SEO_SECTION_DESCRIPTION_KEY_MAP[section];
 const localizedTitle = translateIfExists(titleKey, cantonCode);
 const localizedDescription = translateIfExists(descriptionKey, cantonCode);

 if (!localizedTitle && !localizedDescription) {
 const fallbackTitle = buildLocalizedUnknownSectionTitle(section, locale);
 return {
 title: buildTitleWithBrand(fallbackTitle),
 description: buildLocalizedSeoFallbackDescription(fallbackTitle, locale),
 keywords: getLocalizedSeoKeywords(fallbackTitle, locale, metadata.keywords),
 };
 }

 const title = localizedTitle ? buildTitleWithBrand(localizedTitle) : metadata.title;
 const description = localizedDescription || buildLocalizedSeoFallbackDescription(localizedTitle || metadata.title, locale);
 return {
 title,
 description,
 keywords: getLocalizedSeoKeywords(localizedTitle || metadata.title, locale, metadata.keywords),
 };
}

function getLocalizedSectionLabel(section: string, fallback: string, cantonCode?: string): string {
 const key = SEO_SECTION_TITLE_KEY_MAP[section];
 const localized = translateIfExists(key, cantonCode);
 return localized || fallback;
}

/**
 * Build BreadcrumbList structured data for a given section
 */
function buildBreadcrumbs(section: string, route: AppRoute, locale: Locale, blogTitle?: string): Record<string, any> {
 const crumbs: { name: string; path: string }[] = [
 { name: ({ it: 'Home', en: 'Home', de: 'Startseite', fr: 'Accueil' } as Record<Locale, string>)[locale] ?? 'Home', path: '/' },
 ];

 if (route.activeTab === 'blog') {
 const blogLabel = ({ it: 'Articoli Frontaliere', en: 'Frontier Articles', de: 'Grenzgaenger Artikel', fr: 'Articles Frontaliers' } as Record<Locale, string>)[locale] ?? 'Articoli Frontaliere';
 const blogPath = buildPath({ activeTab: 'blog' }, locale);
 crumbs.push({ name: blogLabel, path: blogPath });

 if (route.blogArticle) {
 const currentPath = buildPath(route, locale);
 const fallbackTitle = route.blogArticle.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
 crumbs.push({ name: blogTitle || fallbackTitle, path: currentPath });
 }

 return {
 "@context": "https://schema.org",
 "@type": "BreadcrumbList",
 "itemListElement": crumbs.map((crumb, i) => ({
 "@type": "ListItem",
 "position": i + 1,
 "name": crumb.name,
 "item": `${BASE_URL}${crumb.path}`,
 })),
 };
 }

 const sectionNames: Record<string, { name: string; path: string; parent?: string }> = {
 calculator: { name: 'Simulatore Fiscale', path: '/' },
 comparatori: { name: 'Comparatori Servizi', path: '/compara-servizi' },
 'comparatori-cambio': { name: 'Cambio Valuta', path: '/compara-servizi/cambio-franco-euro', parent: 'comparatori' },
 'comparatori-assicurazioni': { name: 'Assicurazioni Sanitarie', path: '/compara-servizi/confronta-casse-malati', parent: 'comparatori' },
 'comparatori-trasporti': { name: 'Calcolo Trasporti', path: '/vivere-in-ticino/trasporti-frontalieri', parent: 'vita' },
 'comparatori-operatori': { name: 'Operatori Mobili', path: '/compara-servizi/confronta-operatori-mobili', parent: 'comparatori' },
 'comparatori-banche': { name: 'Confronto Banche', path: '/compara-servizi/confronta-banche', parent: 'comparatori' },
 'comparatori-traffico': { name: 'Traffico Valichi', path: '/statistiche/traffico-dogane', parent: 'comparatori' },
 'comparatori-costo-vita': { name: 'Costo della Vita', path: '/compara-servizi/costo-della-vita', parent: 'comparatori' },
 'comparatori-lavoro': { name: 'Comparatore Lavoro', path: '/compara-servizi/confronta-offerte-lavoro', parent: 'comparatori' },
 'comparatori-spesa': { name: 'Calcolatore Spesa', path: '/compara-servizi/confronta-prezzi-spesa', parent: 'comparatori' },
 exchange: { name: 'Cambio Valuta', path: '/compara-servizi/cambio-franco-euro', parent: 'comparatori' },
 mobile: { name: 'Operatori Mobili', path: '/compara-servizi/confronta-operatori-mobili', parent: 'comparatori' },
 transport: { name: 'Trasporti', path: '/vivere-in-ticino/trasporti-frontalieri', parent: 'vita' },
 health: { name: 'Assicurazioni Sanitarie', path: '/compara-servizi/confronta-casse-malati', parent: 'comparatori' },
 banks: { name: 'Banche', path: '/compara-servizi/confronta-banche', parent: 'comparatori' },
 calcolatore: { name: 'Calcolatore', path: '/calcola-stipendio' },
 traffic: { name: 'Traffico Valichi', path: '/statistiche/traffico-dogane', parent: 'stats' },
 jobs: { name: 'Offerte Lavoro', path: '/compara-servizi/confronta-offerte-lavoro', parent: 'comparatori' },
 shopping: { name: 'Spesa Transfrontaliera', path: '/compara-servizi/confronta-prezzi-spesa', parent: 'comparatori' },
 'cost-of-living': { name: 'Costo della Vita', path: '/compara-servizi/costo-della-vita', parent: 'comparatori' },
 ral: { name: 'Confronto RAL', path: '/calcola-stipendio/confronta-retribuzione-ral', parent: 'calcolatore' },
 'parental-leave': { name: 'Congedo Genitoriale', path: '/calcola-stipendio/verifica-congedo-parentale', parent: 'calcolatore' },
 'border-map': { name: 'Mappa Comuni', path: '/guida-frontaliere/mappa-confine', parent: 'guide' },
 residency: { name: 'Cambio Residenza', path: '/calcola-stipendio/simula-cambio-residenza', parent: 'calcolatore' },
 'tax-return': { name: 'Dichiarazione Redditi', path: '/tasse-e-pensione/dichiarazione-redditi', parent: 'fisco' },
 'tax-return-italia': { name: 'Dichiarazione Redditi Italia', path: '/tasse-e-pensione/dichiarazione-redditi-italia', parent: 'fisco' },
 'tax-return-svizzera': { name: 'Dichiarazione Fiscale Svizzera', path: '/tasse-e-pensione/dichiarazione-redditi-svizzera', parent: 'fisco' },
 nursery: { name: 'Asili Nido', path: '/vivere-in-ticino/confronta-asili-nido', parent: 'vita' },
 bonus: { name: 'Calcolo Bonus', path: '/calcola-stipendio/stima-bonus-frontaliere', parent: 'calcolatore' },
 renovation: { name: 'Bonus Ristrutturazione', path: '/compara-servizi/calcola-bonus-ristrutturazione', parent: 'comparatori' },
 fisco: { name: 'Fisco & Previdenza', path: '/tasse-e-pensione' },
 pension: { name: 'Pianificatore Pensione', path: '/tasse-e-pensione/calcola-previdenza', parent: 'fisco' },
 pillar3: { name: 'Terzo Pilastro', path: '/tasse-e-pensione/simula-terzo-pilastro', parent: 'fisco' },
 guide: { name: 'Guida Frontalieri', path: '/guida-frontaliere' },
 vita: { name: 'Vita in Ticino', path: '/vivere-in-ticino' },
 livingCH: { name: 'Vivere in Svizzera', path: '/vivere-in-ticino/vivere-in-svizzera', parent: 'vita' },
 livingIT: { name: 'Vivere in Italia', path: '/vivere-in-ticino/vivere-in-italia', parent: 'vita' },
 border: { name: 'Valichi Frontiera', path: '/guida-frontaliere/tempi-attesa-dogana', parent: 'guide' },
 calendar: { name: 'Calendario Fiscale', path: '/tasse-e-pensione/scadenze-fiscali', parent: 'fisco' },
 holidays: { name: 'Festività Ticino', path: '/tasse-e-pensione/festivita-ticino', parent: 'fisco' },
 permits: { name: 'Permessi Lavoro', path: '/guida-frontaliere/permessi-di-lavoro', parent: 'guide' },
 companies: { name: 'Aziende Ticino', path: '/vivere-in-ticino/aziende-svizzera-italiana', parent: 'vita' },
 places: { name: 'Posti da Visitare', path: '/vivere-in-ticino/attrazioni-svizzera-italiana', parent: 'vita' },
 schools: { name: 'Scuole Ticino', path: '/vivere-in-ticino/scuole-svizzera-italiana', parent: 'vita' },
 unemployment: { name: 'Disoccupazione', path: '/guida-frontaliere/disoccupazione-transfrontaliera', parent: 'guide' },
 firstDay: { name: 'Primo Giorno', path: '/guida-frontaliere/primo-giorno-lavoro', parent: 'guide' },
 carTransfer: { name: 'Trasferimento Auto', path: '/guida-frontaliere/trasferire-auto-svizzera', parent: 'guide' },
 quiz: { name: 'Quiz Fiscale', path: '/tasse-e-pensione/quiz-fiscale', parent: 'fisco' },
 taxCredit: { name: 'Credito d\'Imposta', path: '/tasse-e-pensione/credito-imposta', parent: 'fisco' },
 withholdingRates: { name: 'Aliquote imposta alla fonte', path: '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026', parent: 'fisco' },
 newFrontierTaxSim: { name: 'Simulazione Tasse Nuovi Frontalieri', path: '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri', parent: 'fisco' },
 stats: { name: 'Statistiche', path: '/statistiche' },
 salarySurvey: { name: 'Confronto Stipendi', path: '/statistiche/confronta-stipendi', parent: 'stats' },
 salaryCompare: { name: 'Confronto Stipendi', path: '/statistiche/confronta-stipendi', parent: 'stats' },
 jobsObservatory: { name: 'Osservatorio Stipendi e Lavori', path: '/statistiche/osservatorio-stipendi-lavori-ticino', parent: 'stats' },
 ristorni: { name: 'Ristorni Fiscali', path: '/tasse-e-pensione/ristorni-fiscali', parent: 'fisco' },
 feedback: { name: 'Feedback', path: '/supporto' },
 contact: { name: 'Contattaci', path: '/contattaci' },
 consulting: { name: 'Consulenza', path: '/consulenza' },
 partners: { name: 'Servizi Partner', path: '/servizi-partner' },
 morning: { name: 'Buongiorno Frontaliere', path: '/buongiorno-frontaliere' },
 forum: { name: 'Community', path: '/community' },
 jobboard: { name: 'Lavoro Ticino', path: '/cerca-lavoro-ticino' },
 whatif: { name: 'What If Simulator', path: '/calcola-stipendio/cosa-cambia-se', parent: 'calcolatore' },
 payslip: { name: 'Calcola Busta Paga', path: '/calcola-stipendio/simula-busta-paga', parent: 'calcolatore' },
 'permit-compare': { name: 'Confronto Permessi', path: '/guida-frontaliere/confronta-permesso-g-vs-b', parent: 'guide' },
 'car-cost': { name: 'Costi Auto', path: '/guida-frontaliere/costo-auto-pendolare', parent: 'guide' },
 livability: { name: 'Migliori Comuni', path: '/statistiche/migliori-comuni-frontiera', parent: 'stats' },
 trafficHistory: { name: 'Storico Traffico', path: '/statistiche/storico-traffico-dogane', parent: 'stats' },
 unemploymentStats: { name: 'Disoccupazione Svizzera', path: '/statistiche/disoccupazione-svizzera', parent: 'stats' },
 mortgageComparison: { name: 'Confronto Mutui', path: '/statistiche/confronto-mutui', parent: 'stats' },
 fuelPrices: { name: 'Prezzi Benzina Confine', path: '/statistiche/prezzi-benzina-confine', parent: 'stats' },
 healthPremiums: { name: 'Premi Malattia per Comune', path: '/statistiche/premi-malattia-comuni', parent: 'stats' },
 salaryQuiz: { name: 'Quiz Stipendio', path: '/calcola-stipendio/quanto-guadagneresti-in-svizzera', parent: 'calcolatore' },
 municipalities: { name: 'Comuni di Frontiera', path: '/vivere-in-ticino/comuni-di-frontiera', parent: 'vita' },
 dashboard: { name: 'Dashboard', path: '/profilo' },
 privacy: { name: 'Privacy', path: '/privacy' },
 gamification: { name: 'Gamification', path: '/gamificazione' },
 'api-status': { name: 'Stato API', path: '/stato-api' },
 'data-deletion': { name: 'Eliminazione Dati', path: '/eliminazione-dati' },
 blog: { name: 'Articoli Frontaliere', path: '/articoli-frontaliere' },
 glossario: { name: 'Glossario Frontaliere', path: '/glossario-frontaliere' },
 dialetto: {
 name: locale === 'en'
 ? 'Ticinese Dialect'
 : locale === 'de'
 ? 'Tessiner Dialekt'
 : locale === 'fr'
 ? 'Dialecte tessinois'
 : 'Dialetto Ticinese',
 path: '/dialetto-ticinese',
 },
 contracts: {
 name: locale === 'en'
 ? 'Employment Contracts'
 : locale === 'de'
 ? 'Arbeitsverträge'
 : locale === 'fr'
 ? 'Contrats de travail'
 : 'Contratti di Lavoro',
 path: '/contratti-lavoro-svizzera',
 },
 'tfr-calculator': {
 name: locale === 'en'
 ? 'TFR / Severance Calculator'
 : locale === 'de'
 ? 'TFR / Abfindungsrechner'
 : locale === 'fr'
 ? 'TFR / Calculateur indemnité'
 : 'TFR / Liquidazione',
 path: '/tfr-liquidazione-frontaliere',
 },
 'permit-quiz': {
 name: locale === 'en'
 ? 'Permit B or G Quiz'
 : locale === 'de'
 ? 'Quiz Bewilligung B oder G'
 : locale === 'fr'
 ? 'Quiz Permis B ou G'
 : 'Quiz Permesso B o G',
 path: '/quiz-permesso-b-o-g',
 },
 'frontaliere-wizard': {
 name: locale === 'en'
 ? 'Ready to become a cross-border worker?'
 : locale === 'de'
 ? 'Bereit, Grenzgänger zu werden?'
 : locale === 'fr'
 ? 'Prêt à devenir frontalier ?'
 : 'Sei pronto a diventare frontaliere?',
 path: '/sei-pronto-a-diventare-frontaliere',
 },
 'tredicesima': {
 name: locale === 'en'
 ? '13th Salary Calculator'
 : locale === 'de'
 ? '13. Monatslohn Rechner'
 : locale === 'fr'
 ? 'Calculateur 13ème salaire'
 : 'Calcolo Tredicesima',
 path: '/calcolo-tredicesima-frontaliere',
 },
 'weekly-digest': {
 name: locale === 'en'
 ? 'Weekly Digest'
 : locale === 'de'
 ? 'Wöchentlicher Bericht'
 : locale === 'fr'
 ? 'Digest Hebdomadaire'
 : 'Digest Settimanale',
 path: '/digest-settimanale',
 },
 'tool-of-week': {
 name: locale === 'en'
 ? 'Tool of the Week'
 : locale === 'de'
 ? 'Werkzeug der Woche'
 : locale === 'fr'
 ? 'Outil de la Semaine'
 : 'Strumento della Settimana',
 path: '/strumento-della-settimana',
 },
 // A.4 — 'blog-naspi-disoccupazione-frontalieri' retired (301 to naspi-ex-frontalieri-2026).





 };

 const info = sectionNames[section];
 if (info) {
 if (info.parent && sectionNames[info.parent]) {
 const parentInfo = sectionNames[info.parent];
 const { route: parentRoute } = parsePath(parentInfo.path);
 crumbs.push({
 name: getLocalizedSectionLabel(info.parent, parentInfo.name),
 path: buildPath(parentRoute, locale),
 });
 }
 if (info.path !== '/') {
 // job-board's sectionNames entry is a static TI fallback (`/cerca-lavoro-ticino`);
 // real canton pages must reflect the page's ACTUAL canton, not the fallback —
 // same class of bug as bridgeThinShell.ts's aggregate fallback (see relatedLinks.ts).
 const jobBoardCanton = section === 'jobboard' ? route.jobBoardCanton : undefined;
 const infoRoute = section === 'jobboard'
 ? ({ activeTab: 'job-board', jobBoardCanton } as AppRoute)
 : parsePath(info.path).route;
 crumbs.push({
 name: getLocalizedSectionLabel(section, info.name, jobBoardCanton),
 path: buildPath(infoRoute, locale),
 });
 }
 }

 return {
 "@context": "https://schema.org",
 "@type": "BreadcrumbList",
 "itemListElement": crumbs.map((crumb, i) => ({
 "@type": "ListItem",
 "position": i + 1,
 "name": crumb.name,
 "item": `${BASE_URL}${crumb.path}`,
 })),
 };
}

/**
 * Check if the non-IT locale translation chunk has been loaded.
 * IT is always available synchronously via it-critical.ts.
 * For other locales, we test a known core key — if it returns the
 * Italian fallback, the locale chunk hasn't loaded yet.
 */
function isLocaleChunkLoaded(locale: Locale): boolean {
 if (locale === 'it') return true;
 const testKey = 'nav.simulator';
 const value = t(testKey);
 const italianFallbacks = new Set(['Calcolatore', testKey]);
 return !italianFallbacks.has(value);
}

/**
 * Updates document meta tags dynamically.
 * Uses the i18n router to build locale-aware canonical and hreflang URLs.
 */
export async function updateMetaTags(section: string): Promise<void> {
 // If the non-IT locale chunk hasn't loaded yet, t() falls back to Italian.
 // Preserve the correct static HTML metadata until the chunk arrives.
 const currentLocale = getLocale();
 if (currentLocale !== 'it' && !isLocaleChunkLoaded(currentLocale)) {
 return;
 }

 loadSerpExperimentState();
 const sectionKey = section.startsWith('jobboard-') ? 'jobboard' : section;
 const metadata = await getSeoEntry(sectionKey);

 // Build locale-aware canonical path from current URL
 const { route, locale: pathLocale } = parsePath(window.location.pathname);
 if (getLocale() !== pathLocale) {
 setLocale(pathLocale);
 }
 const locale = pathLocale;
 // hreflang/<html lang> sync (Issue 204): force-sync the document language
 // attribute and og:locale even when getLocale() already matches pathLocale.
 // setLocale() short-circuits in that branch, so a stale `<html lang>` (e.g.
 // left over after a 404 redirect / sessionStorage bridge) would otherwise
 // mismatch the locale-specific hreflang alternates emitted below.
 if (typeof document !== 'undefined' && document.documentElement.lang !== locale) {
 document.documentElement.lang = locale;
 }
 // For static-overlay routes (recency landings, today landings, fuel-daily,
 // border-wait, etc.) `buildPath(route, locale)` would return the generic
 // tab root (e.g. `/cerca-lavoro-ticino/`) because the route only carries
 // `{ activeTab: 'job-board', staticOverlay: true }` — the specific landing
 // slug is not stored in AppRoute. Use `window.location.pathname` directly
 // so og:url and canonical reflect the actual page URL.
 const localePath = route.staticOverlay
 ? window.location.pathname
 : buildPath(route, locale);
 const canonicalLocalePath = withTrailingSlashPath(localePath);
 const pathnameSnapshot = window.location.pathname;
 const isJobDetailPage = section.startsWith('jobboard-') && Boolean(route.jobSlug);
 const isBlogArticle = section.startsWith('blog-');
 const blogArticleId = isBlogArticle ? section.slice(5) : '';
 const jobSeo = isJobDetailPage && route.jobSlug
 ? await resolveJobSeoBySlug(route.jobSlug, locale, canonicalLocalePath)
 : null;
 if (window.location.pathname !== pathnameSnapshot) return;
 // Awaited here, with the other pre-write loads, so the article:author derivation
 // below stays synchronous (see services/seo/articleAuthorUrl.ts).
 const articleAuthorRegistry: ArticleAuthorRegistry | undefined = isBlogArticle
 ? await loadArticleAuthorRegistry()
 : undefined;
 if (window.location.pathname !== pathnameSnapshot) return;

 // FRO: Expired job soft-landing pages — preserve static HTML metadata.
 // When the SPA loads on an expired job URL, the build plugin already injected
 // correct title, meta description, canonical, and JobPosting JSON-LD into the
 // static HTML. If the job is NOT in the active dataset (jobSeo === null) and
 // the build plugin seeded expired job data, skip all dynamic metadata updates
 // to prevent overwriting with generic listing-page defaults.
 if (isJobDetailPage && !jobSeo) {
 // MUST be slug-specific, not a presence check. `__EXPIRED_JOB_DATA__` is
 // baked into the static HTML of ONE expired job page and the SPA never
 // updates or clears it, so after a soft-navigation the global still
 // describes the page we came FROM. A presence-only check therefore fired
 // on an unrelated active job page whose resolve had raced or which is not
 // in the global dataset (the very case this branch exists for), returned
 // early, and left that page wearing the PREVIOUS job's canonical, title
 // and JobPosting JSON-LD — served to Google. Matching the slug (canonical,
 // per-locale, or historic) keeps the intended behaviour on real expired
 // pages while refusing a stale global. Same class as the
 // __BRIDGE_TARGET_SLUG__ staleness fixed in this PR.
 if (route.jobSlug && seededJobMatchesSlug(route.jobSlug)) {
 return; // Preserve static HTML metadata for expired job pages
 }
 // For active job detail pages where the job couldn't be resolved from
 // /data/jobs.json (async load race, or job not in the global dataset),
 // preserve whatever metadata JobBoard.tsx already set (title, OG tags,
 // canonical with job slug) instead of overwriting with generic listing
 // defaults like "Offerte di Lavoro per Frontalieri".
 return;
 }

 const localizedTitle = isBlogArticle ? t(`blog.article.${blogArticleId}.title`) : '';
 const localizedExcerpt = isBlogArticle ? t(`blog.article.${blogArticleId}.excerpt`) : '';
 const localizedImageAlt = isBlogArticle ? t(`blog.article.${blogArticleId}.imageAlt`) : '';

 const hasLocalizedTitle = isBlogArticle && localizedTitle !== `blog.article.${blogArticleId}.title`;
 const hasLocalizedExcerpt = isBlogArticle && localizedExcerpt !== `blog.article.${blogArticleId}.excerpt`;
 const hasLocalizedImageAlt = isBlogArticle && localizedImageAlt !== `blog.article.${blogArticleId}.imageAlt`;

 const isDialectPage = section === 'dialetto';
 const localizedSeoContent = resolveLocalizedSeoContent(sectionKey, metadata, locale, route.jobBoardCanton);
 const dialectTitleByLocale: Record<Locale, string> = {
 it: 'Dialetto Ticinese | 64 Espressioni e Proverbi | Frontaliere Ticino',
 en: 'Ticinese Dialect | 64 Expressions and Proverbs | Frontaliere Ticino',
 de: 'Tessiner Dialekt: 64 Ausdrücke, Redewendungen und Sprichwörter',
 fr: 'Dialecte tessinois | 64 expressions et proverbes | Frontaliere Ticino',
 };
 const dialectDescriptionByLocale: Record<Locale, string> = {
 it: 'Scopri 64 parole, espressioni e proverbi del dialetto ticinese. Saluti, cibo, lavoro, natura e proverbi per la vita da frontaliere.',
 en: 'Discover 64 words, expressions and proverbs from Ticinese dialect. Greetings, food, work and nature terms for cross-border life.',
 de: 'Tessiner Dialekt lernen: 64 Wörter, Ausdrücke und Sprichwörter aus dem Tessin. Grüsse, Essen, Arbeit und Natur — für Grenzgänger im Alltag.',
 fr: 'Découvrez 64 mots, expressions et proverbes du dialecte tessinois pour la vie quotidienne des frontaliers.',
 };

 // Dynamic job count for the main job board listing page title.
 // At runtime, replace the static "Offerte di Lavoro Ticino 2026" with
 // a count like "1500+ Offerte di Lavoro Ticino 2026" when data is available.
 const isJobboardListing = sectionKey === 'jobboard' && !isJobDetailPage;
 let jobCountLabel: string | null = null;
 if (isJobboardListing) {
 try { jobCountLabel = await getActiveJobCountLabel(locale); } catch { /* keep null */ }
 }

 const baseMetaTitle = jobSeo
 ? jobSeo.title
 : isDialectPage
 ? dialectTitleByLocale[locale]
 : isJobboardListing && jobCountLabel && locale === 'it'
 ? `${jobCountLabel} Offerte di Lavoro Ticino ${new Date().getFullYear()} | Aggiornate Ogni Giorno`
 : (hasLocalizedTitle ? localizedTitle : localizedSeoContent.title);
 const baseMetaDescription = jobSeo
 ? jobSeo.description
 : isDialectPage
 ? dialectDescriptionByLocale[locale]
 : isJobboardListing && jobCountLabel && locale === 'it'
 ? `Offerte di lavoro Ticino: ${jobCountLabel} posti vacanti aggiornati ogni giorno. Cerca lavoro in banche, tech, farmaceutica e sanità da 100+ aziende. Candidatura diretta.`
 : (hasLocalizedExcerpt ? localizedExcerpt : localizedSeoContent.description);
 // Never apply SERP experiment suffixes ("| simulazione | 2026") to individual
 // job detail pages — these have their own structured title pattern:
 // "{JobTitle} — {Company} | Frontaliere Ticino"
 const serpVariant = isJobDetailPage
 ? { title: baseMetaTitle, description: baseMetaDescription, variant: 'control' as const }
 : applySerpTitleDescriptionVariant(
 section,
 canonicalLocalePath,
 locale,
 baseMetaTitle,
 baseMetaDescription,
 );
 const metaTitle = serpVariant.title;
 const metaDescription = serpVariant.description;
 const metaOgTitle = metaTitle;
 // <meta name="description"> + og:description are clamped to the SERP snippet
 // budget (≤160 char, word-aware). The full `metaDescription` is kept for the
 // JSON-LD `description` clones below (schema has no length cap). Same clamp
 // runs in the static emit (build-plugins/htmlTemplate.ts) so the JS-rendered
 // DOM and the static HTML expose an identical, non-truncated snippet.
 // Closes SearchAtlas audit 141162 meta_desc_invalid_length (487 SSG pages).
 const clampedMetaDescription = clampMetaDescription(metaDescription);
 const metaOgDescription = clampedMetaDescription;
 const metaKeywords = jobSeo
 ? jobSeo.keywords
 : (isBlogArticle && locale !== 'it' && hasLocalizedTitle)
 ? `${metaOgTitle}, ${locale === 'fr' ? 'travailleurs frontaliers tessin, salaire net suisse, impots frontalier, cout de la vie lugano' : locale === 'de' ? 'grenzgaenger tessin, nettolohn schweiz, steuern grenzgaenger, lebenshaltungskosten lugano' : 'cross-border workers ticino, swiss net salary, cross-border taxes, cost of living lugano'}`
 : localizedSeoContent.keywords;

 lastSerpExposureContext = {
 section,
 path: canonicalLocalePath,
 variant: serpVariant.variant,
 };

 // Update title
 document.title = metaTitle;

 // Update or create meta tags
 updateOrCreateMetaTag('name', 'description', clampedMetaDescription);
 updateOrCreateMetaTag('name', 'keywords', metaKeywords);

 // Bing & AI-friendly directives: allow large snippets and image previews.
 //
 // Semrush 4xx (2026-04-23 / Cluster A): filter-style query variants like
 //   /fr/comparateurs/comparer-caisses-maladie/?canton=TI&age=26-30
 // are not emitted as static HTML and surface as 404s in Semrush audits.
 // Mark such variants as `noindex, follow` so Google consolidates signals
 // to the query-less canonical. The canonical link (set below) already
 // strips query params because it's built from `route` + `buildPath()`.
 //
 // Phase 1D (2026-04-26): Replaced robots.txt `Disallow: /*?canton=*` /
 // `Disallow: /*?age=*` (which Semrush flagged as 759 "blocked" pages, Issue 4)
 // with this softer runtime noindex+canonical approach. Also extended to
 // internal job search `?q=` strings (Issue 24, 531 hreflang conflicts on
 // /cerca-lavoro-ticino/?q=...). Google honours the canonical → consolidates;
 // Semrush stops surfacing the URLs as blocked or as hreflang conflicts.
 const filterQueryKeys = ['canton', 'age', 'q'] as const;
 const hasFilterQuery = (() => {
 try {
 const params = new URLSearchParams(window.location.search || '');
 return filterQueryKeys.some((key) => params.has(key));
 } catch {
 return false;
 }
 })();
 const robotsDirective = hasFilterQuery
 ? 'noindex, follow'
 : ROBOTS_INDEX_ENHANCED_CONTENT;
 updateOrCreateMetaTag('name', 'robots', robotsDirective);

 // Update Open Graph tags (used by Bing, Facebook, LinkedIn)
 updateOrCreateMetaTag('property', 'og:title', metaOgTitle);
 updateOrCreateMetaTag('property', 'og:description', metaOgDescription);
 updateOrCreateMetaTag('property', 'og:url', `${BASE_URL}${canonicalLocalePath}`);
 updateOrCreateMetaTag('property', 'og:locale', getOgLocale());
 updateOrCreateMetaTag('property', 'og:type', (isBlogArticle || isJobDetailPage) ? 'article' : 'website');
 updateOrCreateMetaTag('property', 'og:site_name', 'Frontaliere Ticino');

 // Use article-specific image for blog posts, generic OG image for other pages
 // Supports both single-object and array structuredData (array may contain NewsArticle + FAQPage)
 const blogArticleSd = isBlogArticle && metadata.structuredData
 ? (Array.isArray(metadata.structuredData)
 ? metadata.structuredData.find(item => item?.['@type'] === 'NewsArticle' || item?.['@type'] === 'Article')
 : metadata.structuredData) as Record<string, any> | undefined
 : undefined;
 if (isBlogArticle && blogArticleSd) {
 const sd = blogArticleSd;
 const imgUrl = typeof sd.image === 'string' ? sd.image : sd.image?.url;
 if (imgUrl) {
 // Full blog hero images are served from jsDelivr (CDN). cdnBlogImage maps
 // both relative and absolute-origin /images/blog/*.webp to the CDN URL and
 // passes non-blog paths (e.g. /images/places) through unchanged.
 const resolvedImgUrl = cdnBlogImage(imgUrl.startsWith('http') ? imgUrl : `${BASE_URL}${imgUrl}`);
 updateOrCreateMetaTag('property', 'og:image', resolvedImgUrl);
 const imgW = typeof sd.image === 'object' ? String(sd.image.width ?? '1344') : '1200';
 const imgH = typeof sd.image === 'object' ? String(sd.image.height ?? '756') : '630';
 updateOrCreateMetaTag('property', 'og:image:width', imgW);
 updateOrCreateMetaTag('property', 'og:image:height', imgH);
 const imgAlt = hasLocalizedImageAlt
 ? localizedImageAlt
 : typeof sd.image === 'object'
 ? (sd.image.caption || metaOgTitle)
 : metaOgTitle;
 updateOrCreateMetaTag('property', 'og:image:alt', imgAlt);
 } else {
 updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
 updateOrCreateMetaTag('property', 'og:image:width', '1200');
 updateOrCreateMetaTag('property', 'og:image:height', '630');
 }
 } else {
 if (jobSeo) {
 // Use branded og-image.png (1200×630) instead of tiny company logos (128px).
 // Google News/Discover require ≥1200px; social platforms recommend ≥600px.
 updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
 updateOrCreateMetaTag('property', 'og:image:width', '1200');
 updateOrCreateMetaTag('property', 'og:image:height', '630');
 updateOrCreateMetaTag('property', 'og:image:alt', metaOgTitle);
 } else {
 updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
 updateOrCreateMetaTag('property', 'og:image:width', '1200');
 updateOrCreateMetaTag('property', 'og:image:height', '630');
 updateOrCreateMetaTag('property', 'og:image:alt', metaOgTitle);
 }
 }

 // Article-specific OG tags for Google News & Bing News indexing
 if (isBlogArticle && blogArticleSd) {
 const sd = blogArticleSd;
 if (sd.datePublished) updateOrCreateMetaTag('property', 'article:published_time', sd.datePublished);
 if (sd.dateModified) updateOrCreateMetaTag('property', 'article:modified_time', sd.dateModified);
 if (sd.articleSection) updateOrCreateMetaTag('property', 'article:section', sd.articleSection);
 // Same Person the byline and the JSON-LD declare — see the twin tag in
 // packages/articles/engine/ogPagesPlugin.ts. Hardcoding the team page here
 // made every OG consumer attribute guest-authored articles to the Redazione
 // (#7227). Falls back to that page only when the article has no Person
 // author, which is the same URL the Organization JSON-LD branch emits.
 // Issue #7241 item 1: the blob is no longer a second source of truth for this
 // tag. `sd.author` is read from content/seo/**, which for 1712 of the 3692 articles
 // still holds the legacy `{"@id": …#organization}` node while the article carries
 // a real `authorSlug` — so this line used to overwrite the correct static tag
 // with the team page URL the moment the SPA hydrated, reproducing the
 // bug #7227 fixed on the client-rendered surface. resolveArticleAuthorUrl
 // derives from `authorSlug` + data/authors.ts (what ogPagesPlugin.ts uses) and
 // keeps `sd.author` only as the fallback for articles without a resolvable slug.
 const sdAuthor = sd.author as { '@type'?: string; url?: string } | undefined;
 const articleAuthorUrl = resolveArticleAuthorUrl(articleAuthorRegistry?.get(blogArticleId), sdAuthor);
 updateOrCreateMetaTag('property', 'article:author', articleAuthorUrl);
 } else {
 // Remove article OG tags for non-article pages
 ['article:published_time', 'article:modified_time', 'article:section', 'article:author'].forEach(prop => {
 const el = document.querySelector(`meta[property="${prop}"]`);
 if (el) el.remove();
 });
 }

 // Update canonical URL (uses current locale path)
 updateCanonicalLink(`${BASE_URL}${canonicalLocalePath}`);

 // Update hreflang tags with locale-specific paths
 updateHreflangTags(route);

 // Update structured data if provided, always include breadcrumbs
 const breadcrumbs = buildBreadcrumbs(sectionKey, route, locale, hasLocalizedTitle ? localizedTitle : undefined);
 if (jobSeo?.structuredData) {
 // jobSeo.structuredData is the JobPosting schema alone, or [JobPosting, FAQPage]
 // when resolveJobSeoBySlug built a job-specific FAQ (see jobPostingFaq.ts).
 const jobStructuredDataItems = Array.isArray(jobSeo.structuredData)
 ? jobSeo.structuredData
 : [jobSeo.structuredData];
 // updateStructuredData() below skips re-injecting an item whose @type is
 // already present as a STATIC (non-dynamic) script — correct for the
 // normal case (avoids duplicating the SSG-prerendered FAQPage on first
 // paint). But a client-side navigation straight from one job-detail page
 // to another (e.g. a "similar jobs" link) never reloads the document, so
 // a *different* job's static FAQPage can still be sitting in <head> when
 // this runs — that stale script would satisfy the skip-check and this
 // job's FAQ would never get injected. Explicitly drop any existing
 // FAQPage script first so the fresh one below always wins. Mirrors the
 // same remove-then-replace pattern JobBoard.tsx already applies to its
 // own JobPosting JSON-LD for the identical reason.
 if (jobStructuredDataItems.some((item) => item?.['@type'] === 'FAQPage')) {
 document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
 try {
 if (JSON.parse(el.textContent || '')?.['@type'] === 'FAQPage') el.remove();
 } catch { /* malformed JSON-LD — ignore */ }
 });
 }
 updateStructuredData([...jobStructuredDataItems, breadcrumbs]);
 } else if (metadata.structuredData) {
 const existingData = Array.isArray(metadata.structuredData)
 ? metadata.structuredData
 : [metadata.structuredData];
 const localizedData = existingData.map(item => {
 const clone = JSON.parse(JSON.stringify(item)) as Record<string, any>;
 if (clone && typeof clone === 'object') {
 // Only assign inLanguage on schema types that officially accept it.
 // BreadcrumbList, ItemList/CAROUSEL, SoftwareApplication/WebApplication,
 // Organization, Place, Offer, etc. do NOT support inLanguage — adding it
 // produces Semrush/Google structured-data errors.
 const rawType = clone['@type'];
 const type = Array.isArray(rawType) ? rawType[0] : rawType;
 if (typeof type === 'string' && TYPES_ACCEPT_IN_LANGUAGE.has(type)) {
 clone.inLanguage = locale;
 }
 if (typeof clone.url === 'string' && clone.url.startsWith(BASE_URL)) clone.url = `${BASE_URL}${canonicalLocalePath}`;
 if (typeof clone.mainEntityOfPage === 'string' && clone.mainEntityOfPage.startsWith(BASE_URL)) {
 clone.mainEntityOfPage = `${BASE_URL}${canonicalLocalePath}`;
 }
 if (isBlogArticle) {
 if (hasLocalizedTitle && typeof clone.headline === 'string') clone.headline = metaOgTitle;
 if (hasLocalizedExcerpt && typeof clone.description === 'string') clone.description = metaDescription;
 if (hasLocalizedImageAlt && clone.image && typeof clone.image === 'object') clone.image.caption = localizedImageAlt;
 }
 if (!isBlogArticle) {
 if (typeof clone.name === 'string') clone.name = metaOgTitle.replace(' | Frontaliere Ticino', '');
 if (typeof clone.headline === 'string') clone.headline = metaOgTitle;
 if (typeof clone.description === 'string') clone.description = metaDescription;
 }
 if (isDialectPage) {
 if (typeof clone.name === 'string') clone.name = metaOgTitle.replace(' | Frontaliere Ticino', '');
 if (typeof clone.description === 'string') clone.description = metaDescription;
 }
 if (locale !== 'it') {
 translateSchema(clone, locale as 'en' | 'de' | 'fr');
 }
 }
 return clone;
 });
 // Filter out redundant WebPage schemas when more specific types exist.
 // Bing flags "conflicting markups" when WebPage coexists with FAQPage,
 // WebApplication, Dataset, etc. on the same page.
 const SPECIFIC_SD_TYPES = new Set(['FAQPage', 'WebApplication', 'Dataset', 'ItemList', 'Organization', 'Article', 'NewsArticle', 'HowTo', 'Product', 'SoftwareApplication', 'CollectionPage']);
 const hasSpecificSdType = localizedData.some(item => SPECIFIC_SD_TYPES.has(String(item?.['@type'] || '')));
 const filteredData = hasSpecificSdType
 ? localizedData.filter(item => String(item?.['@type'] || '') !== 'WebPage')
 : localizedData;
 updateStructuredData([...filteredData, breadcrumbs]);
 } else {
 updateStructuredData(breadcrumbs);
 }
}

/**
 * Update document language attribute and OG locale based on current i18n locale
 */
export function updateDocumentLanguage(locale: string): void {
 document.documentElement.lang = locale;
 updateOrCreateMetaTag('property', 'og:locale', getOgLocale());
}

/**
 * Get OG locale format from current document lang
 */
function getOgLocale(): string {
 const lang = document.documentElement.lang || 'it';
 const localeMap: Record<string, string> = {
 'it': 'it_CH', 'en': 'en_US', 'de': 'de_CH', 'fr': 'fr_CH',
 };
 return localeMap[lang] || 'it_CH';
}

/**
 * Update hreflang link tags for multilingual SEO.
 * Now uses locale-specific paths from the i18n router
 * instead of ?lang= query parameters.
 */
function updateHreflangTags(route: import('./router').AppRoute): void {
 // Static-overlay landing pages (recency/today landings, fuel-daily,
 // border-wait, salary-stats, profession-canton, publisher ads, …) do NOT
 // carry their specific slug in AppRoute — `buildPath(route, locale)` would
 // collapse to the generic tab root (e.g. `/cerca-lavoro-ticino/` instead of
 // `/cerca-lavoro-ticino/oggi/`). Rebuilding hreflang from that root would
 // emit a self-reference that points away from the actual URL, which is
 // exactly the SearchAtlas `no_self_ref_hreflang` flag (612 pages).
 //
 // The build plugins already emit a correct, self-referential, 4-locale +
 // x-default hreflang block for these pages (via the shared
 // `renderHreflangTags()` helper). Leave that server-rendered block intact
 // rather than clobbering it with route-derived paths the route can't
 // reconstruct. Same rationale as the canonical/og:url path above, which
 // uses `window.location.pathname` for staticOverlay routes.
 if (route.staticOverlay) return;

 // Remove existing hreflang tags
 document.querySelectorAll('link[hreflang]').forEach(el => el.remove());

 // Get locale-specific paths from the router
 const paths = buildAllLocalePaths(route);

 // Build hreflang entries, filtering out any with empty lang or empty path.
 // Semrush flags empty hreflang codes as conflicts; this guard ensures we
 // never emit one even if `paths` ends up with a missing/empty locale.
 const hreflangEntries = (['it', 'en', 'de', 'fr'] as const)
 .map((lang) => ({ lang, url: paths[lang] ? `${BASE_URL}${withTrailingSlashPath(paths[lang])}` : '' }))
 .filter((h) => h.lang && h.lang.length > 0 && h.url && h.url.length > 0);

 hreflangEntries.forEach(({ lang, url }) => {
 const link = document.createElement('link');
 link.rel = 'alternate';
 link.hreflang = lang;
 link.href = url;
 document.head.appendChild(link);
 });

 // Add x-default (Italian as default)
 const xDefault = document.createElement('link');
 xDefault.rel = 'alternate';
 xDefault.setAttribute('hreflang', 'x-default');
 xDefault.href = `${BASE_URL}${withTrailingSlashPath(paths.it)}`;
 document.head.appendChild(xDefault);
}

function withTrailingSlashPath(path: string): string {
 if (!path || path === '/') return '/';
 const clean = path.replace(/\/+$/, '');
 return clean ? `${clean}/` : '/';
}

/**
 * Helper function to update or create meta tags
 */
function updateOrCreateMetaTag(attrName: string, attrValue: string, content: string): void {
 let element = document.querySelector(`meta[${attrName}="${attrValue}"]`);

 if (!element) {
 element = document.createElement('meta');
 element.setAttribute(attrName, attrValue);
 document.head.appendChild(element);
 }

 element.setAttribute('content', content);
}

/**
 * Update canonical link
 */
function updateCanonicalLink(url: string): void {
 let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement;

 if (!canonical) {
 canonical = document.createElement('link');
 canonical.rel = 'canonical';
 document.head.appendChild(canonical);
 }

 canonical.href = url;
}

/**
 * Update structured data (JSON-LD)
 */
function updateStructuredData(data: Record<string, any> | Record<string, any>[]): void {
 // Remove only dynamically-injected JSON-LD scripts (those with data-dynamic-ld attribute).
 // Preserve static JSON-LD from staticPagesPlugin/ogPagesPlugin so Google always sees
 // structured data even before JS executes.
 document.querySelectorAll('script[type="application/ld+json"][data-dynamic-ld]').forEach(el => el.remove());

 // Collect @type values already present in static JSON-LD (from build plugins).
 // Skip injecting dynamic JSON-LD for types already covered by static scripts
 // to avoid duplicate structured data that confuses Google Rich Results.
 const existingStaticTypes = new Set<string>();
 document.querySelectorAll('script[type="application/ld+json"]:not([data-dynamic-ld])').forEach((el) => {
 try {
 const parsed = JSON.parse(el.textContent || '');
 if (parsed?.['@type']) existingStaticTypes.add(parsed['@type']);
 } catch { /* malformed — ignore */ }
 });

 const items = Array.isArray(data) ? data : [data];
 items.forEach((item, i) => {
 // Skip if a static JSON-LD with the same @type already exists
 if (item?.['@type'] && existingStaticTypes.has(item['@type'])) return;
 const s = document.createElement('script') as HTMLScriptElement;
 s.type = 'application/ld+json';
 s.setAttribute('data-dynamic-ld', 'true');
 if (i === 0) s.id = 'dynamic-structured-data';
 s.textContent = JSON.stringify(item);
 document.head.appendChild(s);
 });
}

/**
 * Apply noindex SEO tags for 404 / not-found pages.
 * Called when the SPA detects an unrecognized route so Google doesn't
 * index the soft-404 as a real page with homepage content.
 *
 * Sets:
 * - robots = noindex
 * - 404-specific title
 * - canonical to self (the current unrecognized URL)
 * - removes hreflang tags (no alternate versions exist)
 * - removes dynamic structured data (no schema for 404 pages)
 */
export function applyNotFoundSeo(path: string): void {
 // Static overlay = authoritative build-emitted page (soft-landing for compat
 // slugs, renamed jobs, sector/city landings). If present, the static HTML
 // already carries real title/desc/canonical/JSON-LD — slapping noindex would
 // de-index a page that ships full content. Router falsely classified the
 // route as 404 only because the slug isn't in the live jobs index.
 if (typeof document !== 'undefined'
   && document.querySelector('main.seo-static-content')) {
   return;
 }

 const notFoundTitle = 'Pagina non trovata — Frontaliere Ticino';

 // Set noindex to prevent Google from indexing this soft-404
 updateOrCreateMetaTag('name', 'robots', 'noindex');

 // Set 404-specific title
 document.title = notFoundTitle;
 updateOrCreateMetaTag('property', 'og:title', notFoundTitle);
 updateOrCreateMetaTag('name', 'description', 'La pagina richiesta non esiste o è stata spostata.');
 updateOrCreateMetaTag('property', 'og:description', 'La pagina richiesta non esiste o è stata spostata.');

 // Set canonical to self (the current URL) so it doesn't point to homepage
 const selfCanonical = `${BASE_URL}${path.replace(/\/+$/, '') || '/'}`;
 updateCanonicalLink(selfCanonical);
 updateOrCreateMetaTag('property', 'og:url', selfCanonical);

 // Remove hreflang tags — no alternate locale versions for a 404 page
 document.querySelectorAll('link[hreflang]').forEach(el => el.remove());

 // Remove dynamically-injected structured data — no schema for 404 pages
 document.querySelectorAll('script[type="application/ld+json"][data-dynamic-ld]').forEach(el => el.remove());
}

/**
 * Track section view for analytics
 */
export function trackSectionView(_section: string): void {
 const context = lastSerpExposureContext;
 if (!context || context.variant === 'control') return;
 if (typeof window === 'undefined') return;

 const dedupeKey = `seo-serp-exp:${context.path}:${context.variant}`;
 try {
 if (window.sessionStorage.getItem(dedupeKey)) return;
 window.sessionStorage.setItem(dedupeKey, '1');
 } catch {
 // Continue without dedupe if storage is unavailable
 }

 const { fromSearch, host } = isSearchReferrer();
 import('./analytics')
 .then((m) => m.Analytics.trackSerpExperimentExposure(context.variant, context.section, context.path, fromSearch, host))
 .catch(() => undefined);
}
