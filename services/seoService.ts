/**
 * SEO Service - Dynamic Meta Tags Management
 * Manages SEO metadata for different sections of the app
 */

import { getLocale, setLocale, t, getCantonI18nParams, type Locale } from './i18n';
import { parsePath, buildPath, buildAllLocalePaths, type AppRoute } from './router';
import { ALL_GLOSSARY_TERM_IDS, ALL_BORDER_CROSSING_IDS } from './router';
import { resolveCompanyLogoUrl } from './jobDataNormalization';
import { reportCaughtError } from './errorReporter';
import { normalizeStructuredData } from './seo/schema-normalizers';
import { translateSchema } from './seo/schema-translators';
import { buildJobPostingSchema, type JobInput } from '../build-plugins/shared/jobPostingSchema';

/**
 * Retry a dynamic import once after clearing SW caches.
 * Mirrors the logic in lazyRetry.ts but for non-React imports.
 */
async function retryImport<T>(factory: () => Promise<T>, label: string): Promise<T> {
 try {
 return await factory();
 } catch (err) {
 const msg = err instanceof Error ? err.message : String(err);
 const isChunkError =
 msg.includes('Failed to fetch dynamically imported module') ||
 msg.includes('Loading chunk') ||
 msg.includes('Loading CSS chunk') ||
 msg.includes('error loading dynamically imported module');
 if (!isChunkError) throw err;

 // Clear SW caches and retry once
 if ('caches' in window) {
 const names = await caches.keys();
 await Promise.all(names.map(n => caches.delete(n)));
 }
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
 "url": `${BASE_URL}/chi-siamo`,
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

export const SCHEMA_PUBLISHER = {
 "@id": `${BASE_URL}/#organization`,
} as const;

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
 "url": `${BASE_URL}/chi-siamo`,
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
let jobsBySlugCache: Map<string, any> | null = null;
let jobsBySlugPromise: Promise<Map<string, any>> | null = null;
let totalActiveJobCount: number | null = null;

function normalizeSeoText(input: string): string {
 return String(input || '').replace(/\s+/g, ' ').trim();
}

function compactSeoDescription(input: string, maxChars = 320): string {
 const cleaned = normalizeSeoText(input).replace(/<[^>]+>/g, ' ');
 if (cleaned.length <= maxChars) return cleaned;
 return `${cleaned.slice(0, maxChars - 1).trim()}…`;
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
 if (v.includes('intern') || v.includes('stage') || v.includes('tirocin')) return 'INTERN';
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

async function loadJobsBySlug(): Promise<Map<string, any>> {
 if (jobsBySlugCache) return jobsBySlugCache;
 if (jobsBySlugPromise) return jobsBySlugPromise;
 jobsBySlugPromise = (async () => {
 const out = new Map<string, any>();
 try {
 const res = await fetch('/data/jobs.json');
 if (!res.ok) return out;
 const list = await res.json();
 if (!Array.isArray(list)) return out;
 for (const item of list) {
 const slugCandidates = new Set<string>();
 const canonicalSlug = normalizeSeoText(String(item?.slug || ''));
 if (canonicalSlug) slugCandidates.add(canonicalSlug);
 const slugByLocale = item?.slugByLocale && typeof item.slugByLocale === 'object'
 ? Object.values(item.slugByLocale)
 : [];
 for (const localizedSlug of slugByLocale) {
 const normalized = normalizeSeoText(String(localizedSlug || ''));
 if (normalized) slugCandidates.add(normalized);
 }
 for (const slug of slugCandidates) {
 if (!out.has(slug)) out.set(slug, item);
 }
 }
 } catch {
 // Ignore runtime fetch failures; keep SEO fallback.
 }
 jobsBySlugCache = out;
 return out;
 })();
 return jobsBySlugPromise;
}

/**
 * Get the total number of unique active jobs from the loaded dataset.
 * Returns a rounded-down label like "1500+" for SEO titles, or null if
 * data hasn't loaded yet (fallback to static title).
 */
async function getActiveJobCountLabel(): Promise<string | null> {
 if (totalActiveJobCount !== null) {
 const rounded = Math.floor(totalActiveJobCount / 100) * 100;
 return `${rounded}+`;
 }
 try {
 const map = await loadJobsBySlug();
 // Count distinct job objects (map contains multiple slugs per job)
 const uniqueJobs = new Set<any>();
 for (const job of map.values()) uniqueJobs.add(job);
 totalActiveJobCount = uniqueJobs.size;
 const rounded = Math.floor(totalActiveJobCount / 100) * 100;
 return rounded > 0 ? `${rounded}+` : null;
 } catch {
 return null;
 }
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
 structuredData: Record<string, any>;
} | null> {
 const cleanSlug = normalizeSeoText(slug);
 if (!cleanSlug) return null;
 const map = await loadJobsBySlug();
 const job = map.get(cleanSlug);
 if (!job) return null;
 const localizedTitle = normalizeSeoText(String(job?.titleByLocale?.[locale] || job?.title || ''));
 const localizedDescription = compactSeoDescription(String(job?.descriptionByLocale?.[locale] || job?.description || ''), 360);
 if (!localizedTitle || !localizedDescription) return null;
 const logoUrl = companyLogoFromJob(job);
 const canonicalUrl = `${BASE_URL}${canonicalLocalePath}`;
 const address = resolveJobAddress(job);
 const salary = resolveJobSalary(job);
 // Delegate to the canonical builder — see
 // build-plugins/shared/jobPostingSchema.ts. This guarantees all 9
 // mandatory JobPosting fields (CLAUDE.md rule #3) with realistic defaults.
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
 };
 const canonicalSchema = buildJobPostingSchema(canonicalInput, {
 locale,
 url: canonicalUrl,
 baseUrl: BASE_URL,
 });
 return {
 title: `${localizedTitle} — ${job.company} | Frontaliere Ticino`,
 description: localizedDescription,
 keywords: localizedJobKeywords(locale, localizedTitle, String(job?.company || ''), String(job?.location || '')),
 logoUrl,
 structuredData: canonicalSchema,
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

function getSerpIntentLabel(path: string, locale: Locale): string {
 const map = {
 it: {
 over20: 'oltre 20km',
 within20: 'entro 20km',
 exchange: 'cambio CHF EUR',
 pension: 'pensione frontalieri',
 simulation: 'simulazione',
 },
 en: {
 over20: 'over 20km',
 within20: 'within 20km',
 exchange: 'CHF EUR exchange',
 pension: 'cross-border pension',
 simulation: 'simulation',
 },
 de: {
 over20: 'ueber 20km',
 within20: 'innerhalb 20km',
 exchange: 'CHF EUR wechsel',
 pension: 'grenzgaenger rente',
 simulation: 'simulation',
 },
 fr: {
 over20: 'au-dela de 20km',
 within20: 'dans 20km',
 exchange: 'change CHF EUR',
 pension: 'retraite frontalier',
 simulation: 'simulation',
 },
 }[locale];

 if (path.includes('oltre-20km')) return map.over20;
 if (path.includes('entro-20km')) return map.within20;
 if (path.includes('cambio-franco-euro')) return map.exchange;
 if (path.includes('calcola-previdenza') || path.includes('tasse-e-pensione')) return map.pension;
 return map.simulation;
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

 const MAX_TITLE_LENGTH = 60;
 const MAX_DESCRIPTION_LENGTH = 160;
 const year = serpExperimentState.year;
 const intent = getSerpIntentLabel(path, locale);
 const cleanTitle = title.replace(/\s+\|\s+Frontaliere Ticino$/i, '').trim();

 /**
  * Truncate a title segment to `maxLen` characters, stripping any dangling
  * ` | X` pipe separator that would produce a malformed title like
  * "2200+ Offerte di Lavoro Ticino 2026 | A | simulazione | 2026".
  * The `| A |` arises when the cut lands mid-way through a ` | Foo` part.
  */
 function safeTruncate(s: string, maxLen: number): string {
   const truncated = s.slice(0, maxLen).trimEnd();
   // Strip any trailing incomplete ` | <partial>` segment (e.g. "| A" or "| Ag")
   return truncated.replace(/\s*\|\s*[^|]*$/, '').trimEnd();
 }

 if (serpExperimentState.variant === 'year_intent') {
 const suffix = ` ${year} | ${intent}`;
 let experimentTitle: string;
 if (cleanTitle.length + suffix.length <= MAX_TITLE_LENGTH) {
 experimentTitle = `${cleanTitle}${suffix}`;
 } else {
 const maxClean = MAX_TITLE_LENGTH - suffix.length;
 const truncatedClean = maxClean >= 10 ? safeTruncate(cleanTitle, maxClean) : '';
 experimentTitle = truncatedClean.length >= 10 ? `${truncatedClean}${suffix}` : title;
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
 const truncatedClean = maxClean >= 10 ? safeTruncate(cleanTitle, maxClean) : '';
 experimentTitle = truncatedClean.length >= 10 ? `${truncatedClean}${suffix}` : title;
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
 const title = `${label} (Glossario) | Frontaliere Ticino`;
 const description = `Definizione e spiegazione di ${label} per frontalieri (Svizzera–Italia): significato, contesto e impatto pratico.`;
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
 description,
 },
 } satisfies SEOMetadata,
 ];
 })
 ) as Record<string, SEOMetadata>;
}

function titleizeBorderCrossingId(crossingId: string): string {
 // Rough human-readable label from slug id
 return crossingId
 .replace(/-/g, ' ')
 .replace(/\b\w/g, (m) => m.toUpperCase());
}

function buildBorderCrossingSeoMetadata(): Record<string, SEOMetadata> {
 return Object.fromEntries(
 ALL_BORDER_CROSSING_IDS.map((crossingId) => {
 const route = { activeTab: 'guida' as const, guidaSubTab: 'border' as const, borderCrossing: crossingId as any };
 const canonicalPath = buildPath(route, 'it');
 const label = titleizeBorderCrossingId(crossingId);
 const title = `Traffico dogana ${label} | Tempi attesa valico`;
 const description = `Traffico dogana ${label} in tempo reale: tempi di attesa, orari apertura e consigli pratici per frontalieri al valico.`;
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
 name: `Traffico dogana ${label}`,
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
   canonicalPath: '/guida-frontaliere/tempi-attesa-dogana/chiasso-centro',
   structuredData: {
     '@context': 'https://schema.org',
     '@type': 'WebPage',
     name: 'Traffico dogana Chiasso Centro e Brogeda',
     url: `${BASE_URL}/guida-frontaliere/tempi-attesa-dogana/chiasso-centro`,
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

async function loadBlogSeoChunk(): Promise<Record<string, SEOMetadata>> {
 if (_blogChunkCache) return _blogChunkCache;
 const [
 { default: entries1 },
 { default: entries2 },
 { default: entries3 },
 { default: entries4 },
 { default: entries5 },
 { default: entries6 },
 { default: entries7 },
 ] = await Promise.all([
 retryImport(() => import('./seo/seo-blog'), 'blog'),
 retryImport(() => import('./seo/seo-blog-2'), 'blog-2'),
 retryImport(() => import('./seo/seo-blog-3'), 'blog-3'),
 retryImport(() => import('./seo/seo-blog-4'), 'blog-4'),
 retryImport(() => import('./seo/seo-blog-5'), 'blog-5'),
 retryImport(() => import('./seo/seo-blog-6'), 'blog-6'),
 retryImport(() => import('./seo/seo-blog-7'), 'blog-7'),
 ]);
 _blogChunkCache = { ...entries1, ...entries2, ...entries3, ...entries4, ...entries5, ...entries6, ...entries7 };
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

 // 2. Lazy-load blog chunk for blog-* keys
 if (sectionKey.startsWith('blog-')) {
 try {
 const blogEntries = await loadBlogSeoChunk();
 const entry = blogEntries[sectionKey];
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
};

function translateIfExists(key: string | undefined): string | null {
 if (!key) return null;
 const value = t(key, getCantonI18nParams());
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

function resolveLocalizedSeoContent(section: string, metadata: SEOMetadata, locale: Locale): {
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
 const localizedTitle = translateIfExists(titleKey);
 const localizedDescription = translateIfExists(descriptionKey);

 if (!localizedTitle && !localizedDescription) {
 const fallbackTitle = buildLocalizedUnknownSectionTitle(section, locale);
 return {
 title: `${fallbackTitle} | Frontaliere Ticino`,
 description: buildLocalizedSeoFallbackDescription(fallbackTitle, locale),
 keywords: getLocalizedSeoKeywords(fallbackTitle, locale, metadata.keywords),
 };
 }

 const title = localizedTitle ? `${localizedTitle} | Frontaliere Ticino` : metadata.title;
 const description = localizedDescription || buildLocalizedSeoFallbackDescription(localizedTitle || metadata.title, locale);
 return {
 title,
 description,
 keywords: getLocalizedSeoKeywords(localizedTitle || metadata.title, locale, metadata.keywords),
 };
}

function getLocalizedSectionLabel(section: string, fallback: string): string {
 const key = SEO_SECTION_TITLE_KEY_MAP[section];
 const localized = translateIfExists(key);
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
 'blog-stipendio-netto-2026': { name: 'Stipendio Netto 2026', path: '/articoli-frontaliere/stipendio-netto-frontaliere-2026', parent: 'blog' },
 'blog-lamal-vs-cmi': { name: 'LAMal vs CMI', path: '/articoli-frontaliere/lamal-vs-cmi-frontaliere', parent: 'blog' },
 'blog-primo-giorno-frontaliere': { name: 'Primo Giorno', path: '/articoli-frontaliere/primo-giorno-lavoro-svizzera', parent: 'blog' },
 'blog-tredicesima-frontaliere': { name: 'Tredicesima Netta', path: '/articoli-frontaliere/tredicesima-netta-frontaliere', parent: 'blog' },
 'blog-pilastro-3a-frontaliere': { name: 'Terzo Pilastro 3a', path: '/articoli-frontaliere/terzo-pilastro-3a-frontaliere', parent: 'blog' },
 'blog-comuni-migliori-frontalieri': { name: 'Migliori Comuni', path: '/articoli-frontaliere/migliori-comuni-frontalieri', parent: 'blog' },
 'blog-costo-vita-ticino-vs-lombardia': { name: 'Costo Vita', path: '/articoli-frontaliere/costo-vita-ticino-vs-lombardia', parent: 'blog' },
 'blog-tassa-salute-tensioni-ticino': { name: 'Tassa Salute', path: '/articoli-frontaliere/tassa-salute-aumentano-tensioni-ticino', parent: 'blog' },
 'blog-casa-oltre-confine-ticino': { name: 'Casa oltre Confine', path: '/articoli-frontaliere/comprare-casa-italia-confine-ticino', parent: 'blog' },
 'blog-franco-forte-stipendio-frontalieri': { name: 'Franco Forte Stipendio', path: '/articoli-frontaliere/franco-forte-effetti-stipendio-frontalieri', parent: 'blog' },
 'blog-cu-2026-novita-frontalieri': { name: 'CU 2026', path: '/articoli-frontaliere/cu-2026-scadenze-telelavoro-frontalieri', parent: 'blog' },
 'blog-telelavoro-italia-svizzera-ratifica': { name: 'Telelavoro Italia-Svizzera', path: '/articoli-frontaliere/telelavoro-italia-svizzera-ratifica', parent: 'blog' },
 'blog-telelavoro-accordo-definitivo-italia': { name: 'Accordo Telelavoro', path: '/articoli-frontaliere/telelavoro-frontalieri-accordo-italia-svizzera-ratifica-definitiva', parent: 'blog' },
 'blog-stop-ristorni-tassa-salute': { name: 'Stop Ristorni Tassa Salute', path: '/articoli-frontaliere/tassa-salute-ticino-chiede-stop-ristorni-italia', parent: 'blog' },
 'blog-cu-telelavoro-regole-frontalieri': { name: 'Regole Telelavoro e CU', path: '/articoli-frontaliere/frontalieri-cu-2026-telelavoro-45-giorni-regole-definitive', parent: 'blog' },
 'blog-smood-chiusura-impatto-lavoro': { name: 'Chiusura Smood', path: '/articoli-frontaliere/smood-chiude-attivita-ticino-impatto-lavoro-frontalieri', parent: 'blog' },
 'blog-disoccupazione-svizzera-ticino-gennaio': { name: 'Dati Disoccupazione Gennaio', path: '/articoli-frontaliere/disoccupazione-svizzera-gennaio-2026-dati-ticino-frontalieri', parent: 'blog' },
 'blog-riscaldamento-casa-ticino-norme': { name: 'Casa e Risparmio', path: '/articoli-frontaliere/riscaldamento-casa-ticino-norme-energetiche-risparmio', parent: 'blog' },
 'blog-sostituzione-caldaia-ticino-2026': { name: 'Norme Riscaldamento 2026', path: '/articoli-frontaliere/sostituzione-caldaia-ticino-norme-2026-risparmio', parent: 'blog' },
 'blog-hic-sunt-leones-confini-ticino': { name: 'Mostra Confini Svizzeri', path: '/articoli-frontaliere/mostra-hic-sunt-leones-confini-svizzera-frontalieri', parent: 'blog' },
 'blog-carnevale-bambini-lugano-2026': { name: 'Carnevale Bambini Lugano', path: '/articoli-frontaliere/carnevale-2026-lugano-laboratori-creativi-figli-frontalieri', parent: 'blog' },
 'blog-arte-anima-ticino-frontalieri': { name: 'Arte e Cultura Ticino', path: '/articoli-frontaliere/mostra-arte-ticino-sentimento-osservazione-lac-lugano', parent: 'blog' },
 'blog-arca-russa-chiasso-cultura-frontaliere': { name: 'Cultura a Chiasso', path: '/articoli-frontaliere/arca-russa-chiasso-evento-culturale-frontalieri', parent: 'blog' },
 'blog-rsi-mostra-storia-ticino': { name: 'Mostra RSI Ticino', path: '/articoli-frontaliere/mostra-rsi-storia-ticino-frontalieri', parent: 'blog' },
 'blog-carnevale-bambini-lugano-tinguely': { name: 'Carnevale Bambini Lugano', path: '/articoli-frontaliere/vacanze-carnevale-bambini-ticino-laboratori-museo-erba-lugano', parent: 'blog' },
 'blog-daniela-rebuzzi-mostra-caslano': { name: 'Mostra Rebuzzi Caslano', path: '/articoli-frontaliere/mostra-daniela-rebuzzi-caslano-arte-ticino', parent: 'blog' },
 'blog-corpi-in-prestito-arte-agno': { name: 'Mostra "Corpi in Prestito"', path: '/articoli-frontaliere/mostra-arte-corpi-in-prestito-agno-ticino', parent: 'blog' },
 'blog-rsi-storia-svizzera-italiana-mostra': { name: 'Mostra RSI Airolo', path: '/articoli-frontaliere/rsi-mostra-storia-svizzera-italiana-foto-archivio-airolo', parent: 'blog' },
 'blog-rauschenberg-arte-mendrisiotto': { name: 'Mostra Rauschenberg Bruzella', path: '/articoli-frontaliere/mostra-rauschenberg-bruzella-mendrisiotto-arte-gratuita-frontalieri', parent: 'blog' },
 'blog-nakba-mostra-giubiasco-ticino': { name: 'Mostra Nakba Giubiasco', path: '/articoli-frontaliere/mostra-nakba-giubiasco-riflessione-culturale-ticino', parent: 'blog' },
 'blog-de-andre-anime-salve-locarno': { name: 'De André a Locarno', path: '/articoli-frontaliere/de-andre-a-locarno-conferenza-anime-salve-per-frontalieri', parent: 'blog' },
 'blog-sentimento-osservazione-masi-lugano': { name: 'Mostra MASI Lugano', path: '/articoli-frontaliere/masi-lugano-mostra-sentimento-osservazione-identita-ticino', parent: 'blog' },
 'blog-rsi-archivio-gottardo-2026': { name: 'Mostra RSI Airolo', path: '/articoli-frontaliere/rsi-mostra-una-storia-ticino-archivio-fotografico-airolo', parent: 'blog' },
 'blog-carnevale-blenio-chiescia-bosc': { name: 'Carnevale Chièscia Bòsc', path: '/articoli-frontaliere/carnevale-chiescia-bosc-2026-ludiano-valle-blenio', parent: 'blog' },
 'blog-tf-permesso-integrazione-ticino': { name: 'Permesso B e Integrazione', path: '/articoli-frontaliere/permesso-b-integrazione-tribunale-federale-ticino', parent: 'blog' },
 'blog-tassazione-individuale-lavoro-ticino': { name: 'Tassazione e Lavoro', path: '/articoli-frontaliere/tassazione-individuale-svizzera-impatto-lavoro-ticino-frontalieri', parent: 'blog' },
 'blog-ristorni-scontro-gobbi-berna': { name: 'Scontro Ristorni Ticino-Berna', path: '/articoli-frontaliere/ristorni-frontalieri-scontro-ticino-berna-tassa-salute', parent: 'blog' },
 'blog-pendolarismo-affitto-tempo-ticino': { name: 'Affitto e Pendolarismo', path: '/articoli-frontaliere/pendolarismo-affitto-tempo-dilemma-frontalieri-ticino', parent: 'blog' },
 'blog-centrodestra-stop-ristorni-2026': { name: 'Stop Ristorni Tassa Salute', path: '/articoli-frontaliere/centrodestra-ticino-stop-ristorni-frontalieri-tassa-salute', parent: 'blog' },
 'blog-frontalieri-ticino-dati-q4-2025': { name: 'Dati Lavoro Q4 2025', path: '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025', parent: 'blog' },
 'blog-calo-entrate-irregolari-chiasso': { name: 'Ingressi Irregolari Chiasso', path: '/articoli-frontaliere/calo-entrate-irregolari-migranti-chiasso-ticino', parent: 'blog' },
 'blog-frontalieri-salari-polemica-ticino': { name: 'Polemica Salari Ticino', path: '/articoli-frontaliere/frontalieri-stipendi-ticino-polemica-crescente', parent: 'blog' },
 'blog-ristorni-frontalieri-scontro-ticino-lombardia': { name: 'Scontro Ristorni', path: '/articoli-frontaliere/ristorni-frontalieri-scontro-ticino-lombardia-tassa-salute', parent: 'blog' },
 'blog-tredicesima-avs-iva-contributi': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-aumento-iva-contributi-salariali-frontaliere', parent: 'blog' },
 'blog-tredicesima-avs-finanziamento-misto': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-misto-contributi-iva', parent: 'blog' },
 'blog-tredicesima-avs-finanziamento-scontro': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-scontro-iva-contributi', parent: 'blog' },
 'blog-ristorni-imprese-allarme-ticino': { name: 'Allarme Imprese Ristorni', path: '/articoli-frontaliere/blocco-ristorni-imprese-ticino-allarme-calo-frontalieri', parent: 'blog' },
 'blog-denaro-non-dichiarato-dogana-brogeda': { name: 'Contanti in Dogana', path: '/articoli-frontaliere/denaro-non-dichiarato-dogana-cosa-rischi-frontaliere', parent: 'blog' },
 'blog-frontalieri-salari-dibattito-ticino': { name: 'Salari e Dibattito', path: '/articoli-frontaliere/frontalieri-salari-dibattito-ticino-il-cane-che-si-morde-la-coda', parent: 'blog' },
 'blog-tredicesima-avs-stipendio-iva': { name: 'Finanziamento 13esima AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-misto-stipendio-iva', parent: 'blog' },
 'blog-stop-ristorni-mozione-partiti': { name: 'Stop Ristorni Mozione', path: '/articoli-frontaliere/tassa-salute-partiti-ticino-chiedono-stop-ristorni', parent: 'blog' },
 'blog-partiti-ticino-stop-ristorni': { name: 'Stop Ristorni Mozione', path: '/articoli-frontaliere/stop-ristorni-tassa-salute-mozione-politica-ticino', parent: 'blog' },
 'blog-conti-federali-aumento-iva-ticino': { name: 'Conti Federali e IVA', path: '/articoli-frontaliere/conti-federali-2025-aumento-iva-impatto-frontalieri-ticino', parent: 'blog' },
 'blog-tredicesima-avs-stipendi-iva': { name: 'Finanziamento 13esima AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-impatto-stipendio-frontalieri-ticino', parent: 'blog' },
 'blog-ristorni-lombardia-reazione': { name: 'Ristorni e Tassa Salute', path: '/articoli-frontaliere/ristorni-frontalieri-reazione-lombardia-tassa-salute', parent: 'blog' },
 'blog-truffa-falso-bancario-ticino': { name: 'Truffa Falso Bancario', path: '/articoli-frontaliere/truffa-falso-bancario-ticino-allarme-polizia', parent: 'blog' },
 'blog-dazi-usa-impatto-ticino': { name: 'Dazi USA e Ticino', path: '/articoli-frontaliere/dazi-usa-10-percento-conseguenze-economia-ticino', parent: 'blog' },
 'blog-sanita-ticino-tagli-orselina': { name: 'Sanità Ticino: posti a rischio', path: '/articoli-frontaliere/sanita-ticino-accordo-varini-hildebrand-8-posti-a-rischio', parent: 'blog' },
 'blog-dumping-salari-architetti-ticino': { name: 'Dumping Salariale Architetti', path: '/articoli-frontaliere/dumping-salariale-ticino-architetti-part-time-fittizi', parent: 'blog' },
 'blog-tredicesima-avs-finanziamento-contributi': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-aumento-contributi-2026', parent: 'blog' },
 'blog-tredicesima-avs-stipendio-trattenute': { name: '13a AVS e Stipendio', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-impatto-stipendio-frontalieri', parent: 'blog' },
 'blog-scambio-dati-polizia-ticino': { name: 'Scambio Dati Polizia', path: '/articoli-frontaliere/scambio-dati-polizia-svizzera-impatto-ticino', parent: 'blog' },
 'blog-tredicesima-avs-finanziamento-misto-proposta': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-misto-stipendi-iva', parent: 'blog' },
 'blog-frontalieri-ticino-dati-ingannevoli': { name: 'Dati frontalieri', path: '/articoli-frontaliere/frontalieri-ticino-calo-dati-settori-qualificati', parent: 'blog' },
 'blog-tredicesima-avs-finanziamento-busta-paga': { name: 'Finanziamento 13esima AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-aumento-contributi-iva-impatto-stipendio', parent: 'blog' },
 'blog-permesso-s-salari-bassi-ticino': { name: 'Permesso S e Salari', path: '/articoli-frontaliere/permesso-s-stipendi-bassi-impatto-lavoro-ticino', parent: 'blog' },
 'blog-ristorni-reazione-lombardia': { name: 'Ristorni: Reazione Lombardia', path: '/articoli-frontaliere/ristorni-frontalieri-reazione-lombardia-mozione-ticino', parent: 'blog' },
 'blog-tredicesima-avs-busta-paga-frontaliere': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-contributi-iva-impatto-frontalieri', parent: 'blog' },
 'blog-acqua-mendrisiotto-prezzi-2026': { name: 'Costo Acqua Mendrisiotto', path: '/articoli-frontaliere/costo-acqua-mendrisiotto-aumento-tariffe-2026', parent: 'blog' },
 'blog-cooperazione-giudiziaria-svizzera-italia': { name: 'Cooperazione Giudiziaria', path: '/articoli-frontaliere/cooperazione-giudiziaria-svizzera-italia-impatto-frontalieri-ticino', parent: 'blog' },
 'blog-sanita-locarnese-licenziamenti': { name: 'Licenziamenti Sanità Locarno', path: '/articoli-frontaliere/sanita-locarnese-collaborazione-varini-hildebrand-licenziamenti', parent: 'blog' },
 'blog-legionellosi-ticino-allarme': { name: 'Allarme Legionellosi', path: '/articoli-frontaliere/legionellosi-ticino-tasso-piu-alto-svizzera', parent: 'blog' },
 'blog-prezzi-dinamici-ticino-futuro': { name: 'Prezzi Dinamici', path: '/articoli-frontaliere/prezzi-dinamici-ticino-rivoluzione-o-trappola-per-frontalieri', parent: 'blog' },
 'blog-lugano-manifestazioni-regole-polemica': { name: 'Polemica Manifestazioni Lugano', path: '/articoli-frontaliere/lugano-manifestazioni-polemica-regole-uguali-per-tutti', parent: 'blog' },
 'blog-addizionale-irpef-mappa-comuni': { name: 'Tasse Comunali Frontalieri', path: '/articoli-frontaliere/mappa-addizionale-irpef-comuni-confine-frontalieri-tasse', parent: 'blog' },
 'blog-mappa-fiscale-comuni-frontiera': { name: 'Mappa Addizionale IRPEF', path: '/articoli-frontaliere/addizionale-irpef-comuni-confine-mappa-tasse-frontalieri-2026', parent: 'blog' },
 'blog-maternita-paternita-frontaliere-guida': { name: 'Congedo Genitori', path: '/articoli-frontaliere/maternita-paternita-frontaliere-svizzera-italia-guida-2026', parent: 'blog' },
 'blog-guida-contributi-sociali-svizzera': { name: 'Guida Busta Paga', path: '/articoli-frontaliere/guida-contributi-sociali-svizzeri-busta-paga-frontaliere', parent: 'blog' },
 'blog-costo-vivere-lugano-trasferirsi': { name: 'Costo Vita Lugano 2026', path: '/articoli-frontaliere/quanto-costa-vivere-a-lugano-da-frontaliere-analisi-costi-2026', parent: 'blog' },
 'blog-calcolo-pensione-avs-inps': { name: 'Pensione Frontalieri AVS/INPS', path: '/articoli-frontaliere/calcolo-pensione-frontaliere-avs-inps-guida-completa', parent: 'blog' },
 'blog-simulazione-fiscale-frontaliere-2026': { name: 'Simulazione Fiscale 2026', path: '/articoli-frontaliere/frontaliere-nuovo-accordo-fiscale-2026-simulazione', parent: 'blog' },
 'blog-lamal-cmi-scelta-frontaliere-2026': { name: 'LAMal vs CMI 2026', path: '/articoli-frontaliere/lamal-o-cmi-frontaliere-quale-conviene-2026', parent: 'blog' },
 'blog-credito-imposta-doppia-tassazione': { name: 'Credito Imposta Frontalieri', path: '/articoli-frontaliere/frontaliere-doppia-imposizione-credito-imposta-come-funziona', parent: 'blog' },
 'blog-costo-reale-auto-frontaliere': { name: 'Costo Auto Pendolare', path: '/articoli-frontaliere/costo-auto-pendolare-frontaliere-ticino-2026', parent: 'blog' },
 'blog-congedo-genitori-frontaliere-ticino': { name: 'Congedo Genitori', path: '/articoli-frontaliere/congedo-parentale-frontaliere-svizzera-italia-guida-2026', parent: 'blog' },
 'blog-costo-pendolare-auto-ticino-2026': { name: 'Costo Auto Frontaliere', path: '/articoli-frontaliere/costo-auto-frontaliere-ticino-guida-completa-2026', parent: 'blog' },
 'blog-guida-dichiarazione-redditi-frontalieri': { name: 'Guida Fiscale 730', path: '/articoli-frontaliere/guida-dichiarazione-redditi-730-frontalieri-ticino', parent: 'blog' },
 'blog-checklist-documenti-lavoro-svizzera': { name: 'Documenti Lavoro Svizzera', path: '/articoli-frontaliere/documenti-necessari-lavoro-svizzera-frontaliere-ticino', parent: 'blog' },
 'blog-asilo-nido-frontaliere-ticino': { name: 'Guida Asili Nido', path: '/articoli-frontaliere/asilo-nido-svizzera-frontaliere-ticino-costi-guida', parent: 'blog' },
 'blog-locarno-stop-residenze-secondarie': { name: 'Stop Seconde Case Locarno', path: '/articoli-frontaliere/locarno-stop-nuove-residenze-secondarie-quota-20', parent: 'blog' },
 'blog-costo-vita-svizzera-mappa': { name: 'Costo Vita Svizzera', path: '/articoli-frontaliere/costo-vita-svizzera-classifica-comuni-ticino', parent: 'blog' },
 'blog-sicurezza-lavoro-audit-suva': { name: 'Sicurezza Lavoro Audit', path: '/articoli-frontaliere/sicurezza-lavoro-svizzera-audit-federale-falle-conflitti-suva', parent: 'blog' },
 'blog-costo-vivere-mappa-comuni': { name: 'Costo Vita Comuni', path: '/articoli-frontaliere/costo-vita-svizzera-classifica-comuni-cari-economici', parent: 'blog' },
 'blog-architetti-sottopagati-ticino': { name: 'Dumping Salari Architetti', path: '/articoli-frontaliere/architetti-sottopagati-ticino-mendrisio-testimonianza', parent: 'blog' },
 'blog-calo-frontalieri-non-tassa-salute': { name: 'Calo Frontalieri Economia', path: '/articoli-frontaliere/calo-frontalieri-ticino-economia-non-tassa-salute', parent: 'blog' },
 'blog-maternita-cassazione-diritti-frontalieri': { name: 'Maternità Frontalieri Cassazione', path: '/articoli-frontaliere/maternita-frontaliere-cassazione-riconosce-indennita-inps', parent: 'blog' },
 'blog-galenica-bichsel-ristrutturazione-lavoro': { name: 'Ristrutturazione Galenica', path: '/articoli-frontaliere/galenica-chiude-bichsel-170-posti-a-rischio-impatto-ticino', parent: 'blog' },
 'blog-dazi-trump-export-ticinese': { name: 'Dazi USA e Impatto Ticino', path: '/articoli-frontaliere/dazi-trump-usa-impatto-export-ticino-lavoro', parent: 'blog' },
 'blog-campione-italia-fine-dissesto': { name: 'Fine dissesto Campione', path: '/articoli-frontaliere/campione-italia-fuori-dissesto-finanziario-nuove-assunzioni', parent: 'blog' },
 'blog-gavetta-tossica-architetti-ticino': { name: 'Sfruttamento Architetti', path: '/articoli-frontaliere/gavetta-tossica-architetti-ticino-denuncia', parent: 'blog' },
 'blog-eurocity-bloccato-caos-pendolari': { name: 'Disagi Treno Eurocity', path: '/articoli-frontaliere/odissea-eurocity-milano-treno-bloccato-galleria-pendolari', parent: 'blog' },
 'blog-sicurezza-lavoro-controlli-svizzera': { name: 'Sicurezza Lavoro', path: '/articoli-frontaliere/sicurezza-lavoro-svizzera-controlli-insufficienti-suva', parent: 'blog' },
 'blog-startup-investimenti-boom-ticino': { name: 'Boom Investimenti Startup', path: '/articoli-frontaliere/startup-svizzera-boom-investimenti-ia-opportunita-ticino', parent: 'blog' },
 'blog-long-covid-malattia-professionale': { name: 'Long Covid Professionale', path: '/articoli-frontaliere/long-covid-malattia-professionale-sentenza-tribunale-federale', parent: 'blog' },
 'blog-accordo-ue-svizzera-mercato-interno': { name: 'Accordo UE-Svizzera', path: '/articoli-frontaliere/accordo-ue-svizzera-mercato-interno-impatto-frontalieri', parent: 'blog' },
 'blog-fonderie-svizzere-crisi-2025': { name: 'Crisi Fonderie 2025', path: '/articoli-frontaliere/fonderie-svizzere-crisi-produzione-2025-impatto-ticino', parent: 'blog' },
 'blog-salario-minimo-ticino-accordo': { name: 'Accordo Salario Minimo', path: '/articoli-frontaliere/salario-minimo-ticino-accordo-aumento-22-franchi', parent: 'blog' },
 'blog-trasporti-pubblici-crescita-svizzera': { name: 'Trasporti Pubblici Record', path: '/articoli-frontaliere/trasporti-pubblici-svizzera-crescita-fatturato-impatto-frontalieri', parent: 'blog' },
 'blog-cantieri-notturni-lugano-marzo-2026': { name: 'Lavori Notturni Lugano', path: '/articoli-frontaliere/lavori-notturni-lugano-marzo-2026-strade-chiuse', parent: 'blog' },
 'blog-supsi-nuova-direttrice-formazione': { name: 'Nomina SUPSI DFA', path: '/articoli-frontaliere/supsi-daniela-willi-piezzi-direttrice-dipartimento-formazione', parent: 'blog' },
 'blog-bps-suisse-risultati-bper': { name: 'BPS Suisse Risultati 2025', path: '/articoli-frontaliere/bps-suisse-risultati-solidi-2025-impatto-bper-frontalieri', parent: 'blog' },
 'blog-aiuti-energia-proroga-taglio': { name: 'Aiuti Energia Ridotti', path: '/articoli-frontaliere/aiuti-imprese-energetiche-proroga-taglio-fondi', parent: 'blog' },
 'blog-salario-minimo-sociale-ticino-dibattito': { name: 'Salario Minimo Sociale', path: '/articoli-frontaliere/salario-minimo-sociale-ticino-dibattito-frontalieri', parent: 'blog' },
 'blog-bps-suisse-utili-consigli-crisi': { name: 'BPS Suisse Risultati e Consigli', path: '/articoli-frontaliere/bps-suisse-utili-record-consigli-frontalieri', parent: 'blog' },
 'blog-accordo-ue-voto-obbligatorio-ticino': { name: 'Accordo UE Referendum', path: '/articoli-frontaliere/accordo-ue-svizzera-ticino-chiede-referendum-obbligatorio', parent: 'blog' },
 'blog-accordo-ue-svizzera-impatto-frontalieri': { name: 'Accordo Svizzera-UE', path: '/articoli-frontaliere/accordo-svizzera-ue-cosa-cambia-frontalieri-ticino', parent: 'blog' },
 'blog-locarno-stop-case-vacanza': { name: 'Stop Case Secondarie Locarno', path: '/articoli-frontaliere/locarno-stop-licenze-case-secondarie', parent: 'blog' },
 'blog-bilaterali-ue-svizzera-firma': { name: 'Accordi Svizzera-UE', path: '/articoli-frontaliere/accordi-ue-svizzera-firma-vicina-cosa-cambia-frontalieri', parent: 'blog' },
 'blog-aumento-iva-esercito-impatto-spesa': { name: 'Aumento IVA Esercito', path: '/articoli-frontaliere/aumento-iva-svizzera-esercito-impatto-stipendio-frontalieri', parent: 'blog' },
 'blog-maternita-paternita-ticino': { name: 'Congedo parentale', path: '/articoli-frontaliere/maternita-paternita-ticino', parent: 'blog' },
 'blog-valposchiavo-turismo-2025': { name: 'Valposchiavo turismo', path: '/articoli-frontaliere/turismo-valposchiavo-2025', parent: 'blog' },
 'blog-frontalieri-economia-ticino': { name: 'Frontalieri in calo', path: '/articoli-frontaliere/frontalieri-economia-ticino', parent: 'blog' },
 'blog-inflazione-frontalieri-ticino': { name: 'Inflazione frontalieri', path: '/articoli-frontaliere/inflazione-frontalieri-ticino', parent: 'blog' },
 'blog-aprire-conto-bancario-frontaliere': { name: 'Conto bancario frontaliere', path: '/articoli-frontaliere/aprire-conto-bancario-frontalieri', parent: 'blog' },
 'blog-ristorni-fiscali-ticino': { name: 'Ristorni fiscali', path: '/articoli-frontaliere/ristorni-fiscali-frontaliere', parent: 'blog' },
 'blog-contributi-sociali-busta-paga': { name: 'Contributi sociali', path: '/articoli-frontaliere/contributi-sociali-busta-paga', parent: 'blog' },
 'blog-strada-incidenti-vezia-cureglia': { name: 'Strada Vezia-Cureglia', path: '/articoli-frontaliere/strada-incidenti-vezia-cureglia', parent: 'blog' },
 'blog-assicurazione-malattia-famiglia': { name: 'Assicurazione malattia', path: '/articoli-frontaliere/assicurazione-malattia-famiglia', parent: 'blog' },
 'blog-frontalieri-calo-economia-ticinese': { name: 'Frontalieri in calo', path: '/articoli-frontaliere/frontalieri-calo-economia-ticinese', parent: 'blog' },
 'blog-usi-startup-centre-ranking': { name: 'USI Startup Centre', path: '/articoli-frontaliere/usi-centro-startup-classifica', parent: 'blog' },
 'blog-sciopero-treni-tilo-febbraio-2026': { name: 'Sciopero in Italia', path: '/articoli-frontaliere/sciopero-treni-tilo-febbraio-2026', parent: 'blog' },
 'blog-piscina-chiasso-copertura-2026': { name: 'Piscina Chiasso', path: '/articoli-frontaliere/piscina-chiasso-copertura', parent: 'blog' },
 'blog-centrale-elettrica-grono-attiva': { name: 'Centrale Grono', path: '/articoli-frontaliere/centrale-elettrica-grono-attiva', parent: 'blog' },
 'blog-naspi-frontaliere-italia-requisiti': { name: 'NASpI frontalieri', path: '/articoli-frontaliere/naspi-frontaliere-italia-requisiti', parent: 'blog' },
 'blog-prelievo-secondo-pilastro-frontaliere': { name: 'Prelievo del secondo pilastro LPP per fr', path: '/articoli-frontaliere/prelievo-secondo-pilastro-frontaliere', parent: 'blog' },
 'blog-accordo-ue-frontalieri-ticino': { name: 'Accordo Svizzera-UE, firma in arrivo per', path: '/articoli-frontaliere/accordo-ue-frontalieri-ticino', parent: 'blog' },
 'blog-ristorni-congelati-ticino-italia': { name: 'Ristorni fiscali', path: '/articoli-frontaliere/ristorni-congelati-ticino-italia', parent: 'blog' },
 'blog-naspi-ex-frontalieri-2026': { name: 'Indennità di disoccupazione NASpI per ex', path: '/articoli-frontaliere/naspi-ex-frontalieri-2026', parent: 'blog' },
 'blog-mutuo-casa-frontalieri-italia': { name: 'Mutuo casa Italia', path: '/articoli-frontaliere/mutuo-casa-frontalieri-italia', parent: 'blog' },
 'blog-piscina-chiasso-investimento': { name: 'Piscina Chiasso', path: '/articoli-frontaliere/piscina-chiasso-investimento', parent: 'blog' },
 'blog-ristorni-congelati-gobbi-2026': { name: 'Ristorni congelati', path: '/articoli-frontaliere/ristorni-congelati-gobbi-2026', parent: 'blog' },
 'blog-asilo-nido-ticino-guida-2026': { name: 'Asili nido Ticino', path: '/articoli-frontaliere/asilo-nido-ticino-guida-2026', parent: 'blog' },
 'blog-ristorni-salute-2026-ticino': { name: 'Ristorni salute', path: '/articoli-frontaliere/ristorni-salute-2026-ticino', parent: 'blog' },
 'blog-tassa-salute-scontro-ticino-berna': { name: 'Crisi Ristorni Ticino', path: '/articoli-frontaliere/tassa-salute-scontro-ticino-berna', parent: 'blog' },
 'blog-piscina-chiasso-rinnovo-sicurezza': { name: 'Piscina Chiasso Sicurezza', path: '/articoli-frontaliere/piscina-chiasso-rinnovo-copertura-sicurezza', parent: 'blog' },
 'blog-disagi-tilo-sciopero-italia': { name: 'Sciopero Tilo', path: '/articoli-frontaliere/sciopero-tilo-italia-disagi-frontalieri', parent: 'blog' },
 'blog-abbonamenti-sconti-treni-ticino': { name: 'Sconti trasporti', path: '/articoli-frontaliere/abbonamenti-sconti-treni-ticino', parent: 'blog' },
 'blog-bonus-famiglia-frontalieri-2026': { name: 'Bonus famiglia', path: '/articoli-frontaliere/bonus-famiglia-frontalieri-2026', parent: 'blog' },
 'blog-smart-working-frontalieri-2026': { name: 'Smart Working 2026', path: '/articoli-frontaliere/smart-working-frontalieri-regole', parent: 'blog' },
 'blog-confronto-assicurazioni-auto': { name: 'Assicurazioni auto', path: '/articoli-frontaliere/confronto-assicurazioni-auto', parent: 'blog' },
 'blog-permesso-b-vs-g-differenze': { name: 'Permesso B e G', path: '/articoli-frontaliere/permesso-b-vs-g-differenze', parent: 'blog' },
 'blog-spese-sanitarie-frontalieri': { name: 'Spese sanitarie', path: '/articoli-frontaliere/spese-sanitarie-frontalieri', parent: 'blog' },
 // A.4 — 'blog-naspi-disoccupazione-frontalieri' retired (301 to naspi-ex-frontalieri-2026).
 'blog-dichiarazione-redditi-ticino-2026': { name: 'Dichiarazione Redditi', path: '/articoli-frontaliere/dichiarazione-redditi-ticino-2026', parent: 'blog' },
 'blog-migranti-seghezzone-risparmi': { name: 'Migranti Seghezzone', path: '/articoli-frontaliere/migranti-seghezzone-risparmi', parent: 'blog' },
 'blog-cantieri-traffico-frontiera': { name: 'Traffico frontalieri', path: '/articoli-frontaliere/cantieri-traffico-frontiera', parent: 'blog' },
 'blog-salario-minimo-ps-compromesso': { name: 'Salario minimo PS', path: '/articoli-frontaliere/salario-minimo-ps-compromesso', parent: 'blog' },
 'blog-cocaina-lusso-perquisizioni-ticino': { name: 'Traffico Cocaina', path: '/articoli-frontaliere/traffico-cocaina-ticino-lusso', parent: 'blog' },
 'blog-calcolo-tasse-entro-confine': { name: 'Calcolo tasse frontalieri', path: '/articoli-frontaliere/calcolo-tasse-frontalieri-entro-20-km', parent: 'blog' },
 'blog-riforma-giustizia-pace-ticino': { name: 'Riforma Giustizia', path: '/articoli-frontaliere/riforma-giustizia-pace-ticino', parent: 'blog' },
 'blog-cantieri-a9-disagi-frontiera': { name: 'Cantieri A9 e disagi', path: '/articoli-frontaliere/cantieri-a9-disagi-frontiera', parent: 'blog' },
 'blog-revoca-uso-acqua-magliaso': { name: 'Magliaso acqua potabile', path: '/articoli-frontaliere/revoca-uso-acqua-magliaso', parent: 'blog' },
 'blog-malattie-rare-ticino-2026': { name: 'Malattie rare', path: '/articoli-frontaliere/malattie-rare-ticino', parent: 'blog' },
 'blog-frontaliers-sabotage-varese': { name: 'Frontaliers Sabotage', path: '/articoli-frontaliere/frontaliers-sabotage-varese', parent: 'blog' },
 'blog-ristorni-congelati-scontro-ticino': { name: 'Ristorni congelati', path: '/articoli-frontaliere/ristorni-congelati-scontro-ticino', parent: 'blog' },
 'blog-tassazione-individuale-lavoro-donne': { name: 'Tassazione individuale', path: '/articoli-frontaliere/tassazione-individuale-donne-lavoro', parent: 'blog' },
 'blog-diversita-religiosa-ticino-2026': { name: 'Pluralismo religioso', path: '/articoli-frontaliere/diversita-religiosa-ticino', parent: 'blog' },
 'blog-voto-corrispondenza-ticino-2026': { name: 'Voto corrispondenza Ticino', path: '/articoli-frontaliere/voto-corrispondenza-ticino-2026', parent: 'blog' },
 'blog-cantiere-viale-geno-como': { name: 'Lavori a Viale Geno', path: '/articoli-frontaliere/cantiere-viale-geno-rischi', parent: 'blog' },
 'blog-controlli-velocita-ticino-2026': { name: 'Controlli velocità', path: '/articoli-frontaliere/controlli-velocita-ticino-2026', parent: 'blog' },
 'blog-sanremo-2026-aiello-gassmann': { name: 'Sanremo 2026', path: '/articoli-frontaliere/sanremo-2026-aiello-gassmann', parent: 'blog' },
 'blog-violenza-adolescenti-ticino': { name: 'Violenza giovanile', path: '/articoli-frontaliere/violenza-adolescenti-ticino', parent: 'blog' },
 'blog-comuni-frontalieri-distanza': { name: 'Comuni frontalieri', path: '/articoli-frontaliere/comuni-frontalieri-distanza', parent: 'blog' },
 'blog-elezioni-comunali-ticino': { name: 'Elezioni Comunali', path: '/articoli-frontaliere/elezioni-comunali-ticino', parent: 'blog' },
 'blog-eroina-auto-chiasso-brogeda': { name: 'Eroina a Brogeda', path: '/articoli-frontaliere/eroina-auto-chiasso-brogeda', parent: 'blog' },
 'blog-olio-chimica-produzione': { name: 'Olio e chimica', path: '/articoli-frontaliere/olio-chimica-produzione-ticino', parent: 'blog' },
 'blog-incidente-mortale-frontaliere': { name: 'Incidente Porlezza', path: '/articoli-frontaliere/incidente-mortale-frontaliere', parent: 'blog' },
 'blog-svizzera-mediazione-iran-2026': { name: 'Svizzera e Iran', path: '/articoli-frontaliere/svizzera-dovrebbe-rinunciare-mediazione', parent: 'blog' },
 'blog-sanremo-frontalieri-impatti': { name: 'Sanremo e frontalieri', path: '/articoli-frontaliere/sanremo-frontalieri-impatti', parent: 'blog' },
 'blog-lavorare-germania-educatori': { name: 'Educatori Germania', path: '/articoli-frontaliere/lavorare-germania-educatori', parent: 'blog' },
 'blog-porto-ceresio-lungolago-lavori': { name: 'Porto Ceresio lavori', path: '/articoli-frontaliere/porto-ceresio-lungolago-lavori', parent: 'blog' },
 'blog-casa-hockey-ticino-2026': { name: 'Casa dell\'Hockey', path: '/articoli-frontaliere/casa-hockey-ticino', parent: 'blog' },
 'blog-tassazione-individuale-svizzera': { name: 'Tassazione individuale', path: '/articoli-frontaliere/tassazione-individuale-svizzera', parent: 'blog' },
 'blog-cinema-frontaliers-ticino-varese': { name: 'Frontaliers Sabotage', path: '/articoli-frontaliere/film-frontaliers-sabotage-varese', parent: 'blog' },
 'blog-minimo-salariale-ticino-accordo-ps': { name: 'Salario Minimo Ticino', path: '/articoli-frontaliere/salario-minimo-ticino-accordo-ps', parent: 'blog' },
 'blog-chiasso-fede-adulti-integrazione': { name: 'Fede a Chiasso', path: '/articoli-frontaliere/chiasso-fede-adulti-integrazione', parent: 'blog' },
 'blog-sicurezza-confine-ticino-brogeda': { name: 'Controlli al Confine', path: '/articoli-frontaliere/sicurezza-confine-ticino-brogeda', parent: 'blog' },
 'blog-stipendi-manager-energia-ticino': { name: 'Salari Energia Ticino', path: '/articoli-frontaliere/stipendi-manager-energia-ticino', parent: 'blog' },
 'blog-lavoro-educatori-germania-alternativa': { name: 'Educatori Germania', path: '/articoli-frontaliere/lavoro-educatori-germania-alternativa-frontalieri', parent: 'blog' },
 'blog-gandria-lusso-immobiliare-ticino': { name: 'Gandria Lusso Immobiliare', path: '/articoli-frontaliere/gandria-lusso-immobiliare-ticino', parent: 'blog' },
 'blog-vandalismo-bus-frontalieri-ticino': { name: 'Vandalismo sui bus', path: '/articoli-frontaliere/vandalismo-bus-ticino-frontalieri', parent: 'blog' },
 'blog-ticino-voto-anti-dumping': { name: 'Voto Anti-Dumping', path: '/articoli-frontaliere/ticino-voto-anti-dumping-salariale', parent: 'blog' },
 'blog-controlli-stradali-ticino-frontalieri': { name: 'Controlli Velocità', path: '/articoli-frontaliere/controlli-stradali-ticino-frontalieri-marzo-2026', parent: 'blog' },
 'blog-comuni-confine-nuove-regole': { name: 'Comuni di Confine', path: '/articoli-frontaliere/comuni-confine-nuove-regole-fiscali', parent: 'blog' },
 'blog-tragedia-stradale-frontaliere': { name: 'Tragedia sul confine', path: '/articoli-frontaliere/tragedia-stradale-frontaliere-porlezza', parent: 'blog' },
 'blog-chiasso-como-cantieri-a9-disagi': { name: 'Chiusure A9 Confine', path: '/articoli-frontaliere/chiasso-como-autostrada-a9-chiusure-notturne-cantieri', parent: 'blog' },
 'blog-chiasso-comunita-evoluzione-sociale': { name: 'Fede a Chiasso', path: '/articoli-frontaliere/chiasso-comunita-evoluzione-sociale', parent: 'blog' },
 'blog-tragedia-pendolare-ticino': { name: 'Tragedia Porletta', path: '/articoli-frontaliere/tragedia-pendolare-frontaliere-porletta', parent: 'blog' },
 'blog-a9-como-chiasso-disagi-notturni': { name: 'Disagi A9 Confine', path: '/articoli-frontaliere/a9-como-chiasso-disagi-notturni-frontiera', parent: 'blog' },
 'blog-economia-svizzera-ripresa-2026': { name: 'Economia Svizzera', path: '/articoli-frontaliere/economia-svizzera-ripresa-2026', parent: 'blog' },
 'blog-confine-fiscale-nuovi-comuni': { name: 'Comuni di Confine', path: '/articoli-frontaliere/frontalieri-nuova-mappa-fiscale-comuni-confine', parent: 'blog' },
 'blog-confine-a9-disagi-marzo': { name: 'Chiusure A9 Marzo', path: '/articoli-frontaliere/chiusure-notturne-a9-chiasso-como-marzo-frontalieri', parent: 'blog' },
 'blog-autostrada-a9-disagi-frontalieri': { name: 'A9 Chiasso-Como', path: '/articoli-frontaliere/chiusura-notturna-a9-chiasso-como-frontalieri', parent: 'blog' },
 'blog-chiusure-a9-trasporti-speciali': { name: 'Chiusure A9', path: '/articoli-frontaliere/chiusure-a9-trasporti-speciali-como-chiasso', parent: 'blog' },
 'blog-salari-ticino-voto-frontalieri': { name: 'Voto Anti-Dumping Ticino', path: '/articoli-frontaliere/dumping-salariale-ticino-voto-frontalieri', parent: 'blog' },
 'blog-lutto-porlezza-frontaliere': { name: 'Incidente Porlezza', path: '/articoli-frontaliere/scontro-fatale-porlezza-frontaliere', parent: 'blog' },
 'blog-frontalieri-confine-disparita-fiscale': { name: 'Comuni Confine', path: '/articoli-frontaliere/frontalieri-confine-disparita-fiscale', parent: 'blog' },
 'blog-iniziativa-anti-dumping-voto': { name: 'Voto Anti-dumping', path: '/articoli-frontaliere/iniziativa-anti-dumping-salari-ticino-voto', parent: 'blog' },
 'blog-nestle-bonus-lombardia-welfare': { name: 'Bonus Nestlé', path: '/articoli-frontaliere/nestle-bonus-lombardia-welfare-frontalieri', parent: 'blog' },
 'blog-frontiera-a9-disagi-marzo-2026': { name: 'Disagi A9 Frontiera', path: '/articoli-frontaliere/a9-chiasso-como-chiusure-notturne-cantieri', parent: 'blog' },
 'blog-mercato-lavoro-ticino-frena-2025': { name: 'Lavoro Ticino 2025', path: '/articoli-frontaliere/mercato-lavoro-ticino-rallenta-2025', parent: 'blog' },
 'blog-confini-comunali-impatto-fiscale': { name: 'Comuni Confine', path: '/articoli-frontaliere/comuni-frontiera-nuove-regole-fiscali', parent: 'blog' },
 'blog-franco-forte-impatto-frontalieri': { name: 'Franco Forte', path: '/articoli-frontaliere/franco-forte-impatto-frontalieri', parent: 'blog' },
 'blog-incidente-giovane-frontaliere': { name: 'Incidente Porletta', path: '/articoli-frontaliere/tragedia-frontaliere-porlezza-via-ceresio', parent: 'blog' },
 'blog-a9-chiasso-como-cantieri-frontalieri': { name: 'Cantieri A9', path: '/articoli-frontaliere/chiusure-notturne-a9-frontalieri', parent: 'blog' },
 'blog-salario-minimo-compromesso-ticino': { name: 'Salario Minimo Ticino', path: '/articoli-frontaliere/salario-minimo-compromesso-ps-ticino', parent: 'blog' },
 'blog-compromesso-salario-minimo-condizioni': { name: 'Salario Minimo Compromesso', path: '/articoli-frontaliere/compromesso-salario-minimo-condizioni', parent: 'blog' },
 'blog-chiasso-comunita-cambiamento-valori': { name: 'Chiasso: Nuovi Valori', path: '/articoli-frontaliere/chiasso-comunita-cambiamento-valori', parent: 'blog' },
 'blog-pendolarismo-fatale-frontaliere-porlezza': { name: 'Incidente Porlezza', path: '/articoli-frontaliere/pendolarismo-fatale-frontaliere-porlezza', parent: 'blog' },
 'blog-salario-minimo-ticino-trattative': { name: 'Salario Minimo', path: '/articoli-frontaliere/salario-minimo-ticino-trattative-compromesso', parent: 'blog' },
 'blog-trevano-campus-riqualifica': { name: 'Trevano Riqualifica', path: '/articoli-frontaliere/trevano-campus-riqualifica-12-milioni-lavori', parent: 'blog' },
 'blog-lavena-sagrato-nuovo-investimento': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-nuovo-sagrato-chiesa', parent: 'blog' },
 'blog-sportello-lavoro-varese-frontalieri-ticino': { name: 'Sportello Lavoro Varese', path: '/articoli-frontaliere/sportello-lavoro-varese-frontalieri-ticino', parent: 'blog' },
 'blog-controlli-stradali-intensivi-frontiera': { name: 'Radar confine', path: '/articoli-frontaliere/controlli-stradali-intensivi-frontiera-ticino', parent: 'blog' },
 'blog-radar-confine-ticino-marzo': { name: 'Radar al Confine', path: '/articoli-frontaliere/settimana-di-controlli-radar-intensivi-confine-ticino-marzo', parent: 'blog' },
 'blog-controlli-frontiera-ticino-rafforzati': { name: 'Controlli Frontiera', path: '/articoli-frontaliere/controlli-frontiera-ticino-rafforzati', parent: 'blog' },
 'blog-lavori-risanamento-a13-cadenazzo-2026': { name: 'Lavori A13', path: '/articoli-frontaliere/lavori-risanamento-a13-cadenazzo-2026', parent: 'blog' },
 'blog-salario-minimo-ticino-intesa-storica': { name: 'Salario Minimo Accordo', path: '/articoli-frontaliere/salario-minimo-ticino-intesa-storica', parent: 'blog' },
 'blog-sicurezza-stradale-ticino-marzo': { name: 'Radar Mobili Ticino', path: '/articoli-frontaliere/sicurezza-stradale-ticino-marzo', parent: 'blog' },
 'blog-a13-cantieri-frontalieri-ticino': { name: 'Cantieri A13', path: '/articoli-frontaliere/a13-cantieri-frontalieri-ticino', parent: 'blog' },
 'blog-bns-utile-calo-2025-impatto-ticino': { name: 'BNS utile 2025', path: '/articoli-frontaliere/bns-utile-calo-2025-impatto-ticino', parent: 'blog' },
 'blog-polizia-cantonale-nuovi-gendarmi': { name: 'Nuovi Gendarmi', path: '/articoli-frontaliere/polizia-cantonale-nuovi-gendarmi', parent: 'blog' },
 'blog-competenze-tecniche-frontalieri-ticino': { name: 'Competenze Tecniche', path: '/articoli-frontaliere/competenze-tecniche-frontalieri-ticino', parent: 'blog' },
 'blog-polizia-cantonale-reclutamento-2026': { name: 'Scuola Polizia Ticino', path: '/articoli-frontaliere/polizia-cantonale-reclutamento-2026', parent: 'blog' },
 'blog-mercato-auto-febbraio-2026': { name: 'Mercato Auto', path: '/articoli-frontaliere/mercato-auto-febbraio-2026', parent: 'blog' },
 'blog-como-nuovi-poliziotti-2026': { name: 'Nuovi poliziotti Como', path: '/articoli-frontaliere/como-nuovi-poliziotti-2026', parent: 'blog' },
 'blog-sesto-calende-sicurezza-frontalieri': { name: 'Sicurezza Sesto Calende', path: '/articoli-frontaliere/sesto-calende-sicurezza-frontalieri', parent: 'blog' },
 'blog-nessun-prelievo-avs-sulle-mance': { name: 'Novità Mance', path: '/articoli-frontaliere/nessun-prelievo-avs-sulle-mance', parent: 'blog' },
 'blog-imposizione-individuale-donne-ticino': { name: 'Imposizione Individuale', path: '/articoli-frontaliere/imposizione-individuale-donne-ticino', parent: 'blog' },
 'blog-docenti-frontalieri-permesso-lavoro': { name: 'Docenti frontalieri', path: '/articoli-frontaliere/docenti-frontalieri-permesso-lavoro', parent: 'blog' },
 'blog-iniziativa-anti-dumping-ticino-2026': { name: 'Iniziativa Anti-Dumping', path: '/articoli-frontaliere/iniziativa-anti-dumping-ticino-2026', parent: 'blog' },
 'blog-comuni-confine-fiscalita-disparita': { name: 'Fiscalità Frontalieri', path: '/articoli-frontaliere/comuni-confine-fiscalita-disparita', parent: 'blog' },
 'blog-tassa-salute-berna-ticino': { name: 'Tassa Salute Ticino', path: '/articoli-frontaliere/tassa-salute-berna-ticino', parent: 'blog' },
 'blog-ai-lombardia-impatto-ticino': { name: 'AI e Frontalieri', path: '/articoli-frontaliere/ai-lombardia-impatto-ticino', parent: 'blog' },
 'blog-crisi-golfo-carburanti-ticino': { name: 'Crisi Golfo Ticino', path: '/articoli-frontaliere/crisi-golfo-carburanti-ticino', parent: 'blog' },
 'blog-rincari-benzina-frontalieri-ticino': { name: 'Rincari benzina Ticino', path: '/articoli-frontaliere/rincari-benzina-frontalieri-ticino', parent: 'blog' },

 'blog-crisi-olio-prezzi-benzina-ticino': { name: 'Crisi benzina Ticino', path: '/articoli-frontaliere/crisi-olio-prezzi-benzina-ticino', parent: 'blog' },

 'blog-benzina-ticino-oriente': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/benzina-ticino-oriente', parent: 'blog' },

 'blog-ai-lombardia-ticino-frontaliere-2026': { name: 'AI Lombardia-Ticino', path: '/articoli-frontaliere/ai-lombardia-ticino-frontaliere-2026', parent: 'blog' },
 'blog-kuhne-nagel-tagli-posti-ticino-2026': { name: 'Tagli Kühne+Nagel', path: '/articoli-frontaliere/kuhne-nagel-tagli-posti-ticino-2026', parent: 'blog' },
 'blog-vini-ticinesi-collaborazione': { name: 'Vini ticinesi', path: '/articoli-frontaliere/vini-ticinesi-collaborazione', parent: 'blog' },
 'blog-hockey-chiasso-wild-boars-bis': { name: 'Hockey Chiasso', path: '/articoli-frontaliere/hockey-chiasso-wild-boars-bis', parent: 'blog' },
 'blog-svincolo-a2-biasca-rischi-frontaliere': { name: 'Sicurezza viaria Ticino', path: '/articoli-frontaliere/svincolo-a2-biasca-rischi-frontaliere', parent: 'blog' },
 'blog-accordi-svizzera-ue-parmelin-bruxelles': { name: 'Accordi Svizzera-UE', path: '/articoli-frontaliere/accordi-svizzera-ue-parmelin-bruxelles', parent: 'blog' },
 'blog-lavori-linea-locarno-cadenazzo-2026': { name: 'Lavori ferrovia Ticino', path: '/articoli-frontaliere/lavori-linea-locarno-cadenazzo-2026', parent: 'blog' },
 'blog-spirit-varesini-valico-tassa-2026': { name: 'Novità Tassazione', path: '/articoli-frontaliere/spirit-varesini-valico-tassa-2026', parent: 'blog' },
 'blog-borse-in-rosso-prezzo-petrolio-ticino': { name: 'Economia Borse Petrolio', path: '/articoli-frontaliere/borse-in-rosso-prezzo-petrolio-ticino', parent: 'blog' },
 'blog-frontaliers-sabotage-varese-successo': { name: 'Cinema frontalieri', path: '/articoli-frontaliere/frontaliers-sabotage-varese-successo', parent: 'blog' },
 'blog-disoccupazione-svizzera-2026': { name: 'Disoccupazione in Svizzera', path: '/articoli-frontaliere/disoccupazione-svizzera-2026', parent: 'blog' },
 'blog-infermieri-svizzera-frontalieri-ticino': { name: 'Lavoro frontaliero Ticino', path: '/articoli-frontaliere/infermieri-svizzera-frontalieri-ticino', parent: 'blog' },
 'blog-successo-farmaceutica-ticino': { name: 'Novità economiche', path: '/articoli-frontaliere/successo-farmaceutica-ticino', parent: 'blog' },
 'blog-utile-bns-2025-ticino': { name: 'Utile BNS 2025', path: '/articoli-frontaliere/utile-bns-2025-ticino', parent: 'blog' },
 'blog-banche-ticino-disoccupazione': { name: 'Novità lavoro', path: '/articoli-frontaliere/banche-ticino-disoccupazione', parent: 'blog' },
 'blog-medio-vedeggio-gruppo-lavoro-aggregazione': { name: 'Medio Vedeggio', path: '/articoli-frontaliere/medio-vedeggio-gruppo-lavoro-aggregazione', parent: 'blog' },
 'blog-lugano-airport-fondi-salvati-2026': { name: 'Lugano Airport', path: '/articoli-frontaliere/lugano-airport-fondi-salvati-2026', parent: 'blog' },
 'blog-made-in-italy-doganali-ticino-2026': { name: 'Made in Italy Dogane', path: '/articoli-frontaliere/made-in-italy-doganali-ticino-2026', parent: 'blog' },
 'blog-mercato-lavoro-ticino-q4-2025': { name: 'Mercato lavoro', path: '/articoli-frontaliere/mercato-lavoro-ticino-q4-2025', parent: 'blog' },
 'blog-dichiarazione-imposta-digitale-ticino-26': { name: 'Imposte Ticino', path: '/articoli-frontaliere/dichiarazione-imposta-digitale-ticino-26', parent: 'blog' },
 'blog-tilo-25-milioni-passeggeri-2025': { name: 'TILO 2025', path: '/articoli-frontaliere/tilo-25-milioni-passeggeri-2025', parent: 'blog' },
 'blog-tassa-salute-lombardia-rinvio': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-lombardia-rinvio', parent: 'blog' },
 'blog-tilo-record-passeggeri-2025': { name: 'Notizie TILO', path: '/articoli-frontaliere/tilo-record-passeggeri-2025', parent: 'blog' },
 'blog-trasporti-lombardia-ticino-record-tilo': { name: 'Trasporti', path: '/articoli-frontaliere/trasporti-lombardia-ticino-record-tilo', parent: 'blog' },
 'blog-confusione-tassa-salute-frontalieri': { name: 'Frontalieri e tassa salute', path: '/articoli-frontaliere/confusione-tassa-salute-frontalieri', parent: 'blog' },
 'blog-carburante-ticino-costo-aumenti': { name: 'Il costo del carburante in Ticino si imp', path: '/articoli-frontaliere/carburante-ticino-costo-aumenti', parent: 'blog' },
 'blog-cpi-caso-hospita-rivalutazione-periti': { name: 'CPI e Caso Hospita', path: '/articoli-frontaliere/cpi-caso-hospita-rivalutazione-periti', parent: 'blog' },
 'blog-casellario-giudiziale-ue-ticino': { name: 'Canton Grigioni', path: '/articoli-frontaliere/casellario-giudiziale-ue-ticino', parent: 'blog' },
 'blog-salario-minimo-per-il-controprogetto-la-strada-e-in-discesa': { name: 'Salario minimo', path: '/articoli-frontaliere/salario-minimo-per-il-controprogetto-la-strada-e-in-discesa', parent: 'blog' },
 'blog-tassa-salute-lombardia-frontalieri': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-lombardia-frontalieri', parent: 'blog' },
 'blog-franco-forte-problemi-economici': { name: 'Il franco forte', path: '/articoli-frontaliere/franco-forte-problemi-economici', parent: 'blog' },
 'blog-carburante-prezzo-salito-opportunismo': { name: 'Prezzo Benzina', path: '/articoli-frontaliere/carburante-prezzo-salito-opportunismo', parent: 'blog' },
 'blog-frontalieri-tassa-salute-teatro': { name: 'Frontalieri e tassa salute', path: '/articoli-frontaliere/frontalieri-tassa-salute-teatro', parent: 'blog' },
 'blog-disoccupazione-stabile-svizzera-2026': { name: 'Disoccupazione Svizzera', path: '/articoli-frontaliere/disoccupazione-stabile-svizzera-2026', parent: 'blog' },
 'blog-dazi-usa-rimborsi-ritardi': { name: 'Dazi USA', path: '/articoli-frontaliere/dazi-usa-rimborsi-ritardi', parent: 'blog' },
 'blog-votazioni-8-marzo-iniziativa-ssr-aperto': { name: 'Votazioni del 8 marzo', path: '/articoli-frontaliere/votazioni-8-marzo-iniziativa-ssr-aperto', parent: 'blog' },
 'blog-ticino-spitex-contributo-pressione': { name: 'Ticino Spitex', path: '/articoli-frontaliere/ticino-spitex-contributo-pressione', parent: 'blog' },
 'blog-stalking-swiss-2026-ticino': { name: 'Dal 2026', path: '/articoli-frontaliere/stalking-swiss-2026-ticino', parent: 'blog' },
 'blog-pirati-strada-ticino-italiani-2026': { name: 'Ticino', path: '/articoli-frontaliere/pirati-strada-ticino-italiani-2026', parent: 'blog' },
 'blog-comuni-locarno-futuro-aggregazione': { name: 'Sette Comuni del Locarnese sul Futuro', path: '/articoli-frontaliere/comuni-locarno-futuro-aggregazione', parent: 'blog' },
 'blog-costi-cure-domicilio-ticino-2026': { name: 'Ticino', path: '/articoli-frontaliere/costi-cure-domicilio-ticino-2026', parent: 'blog' },
 'blog-lugano-park-ride-bus-sovvenzioni-2026': { name: 'Lugano', path: '/articoli-frontaliere/lugano-park-ride-bus-sovvenzioni-2026', parent: 'blog' },
 'blog-crisi-turismo-golfo-persico': { name: 'Crisi Turismo', path: '/articoli-frontaliere/crisi-turismo-golfo-persico', parent: 'blog' },
 'blog-turisti-ticinesi-bloccati-medio-oriente': { name: 'Turisti bloccati', path: '/articoli-frontaliere/turisti-ticinesi-bloccati-medio-oriente', parent: 'blog' },
 'blog-svizzeri-bloccati-medio-oriente': { name: 'Svizzeri bloccati', path: '/articoli-frontaliere/svizzeri-bloccati-medio-oriente', parent: 'blog' },
 'blog-ticino-prevenzione-incendi-scuole-2026': { name: 'Sicurezza Scuole Ticino', path: '/articoli-frontaliere/ticino-prevenzione-incendi-scuole-2026', parent: 'blog' },
 'blog-varese-india-export-2026': { name: 'Varese India Export', path: '/articoli-frontaliere/varese-india-export-2026', parent: 'blog' },
 'blog-autotrasporto-rincari-confine-2026': { name: 'Carburante & Trasporti', path: '/articoli-frontaliere/autotrasporto-rincari-confine-2026', parent: 'blog' },
 'blog-carburanti-rincari-confine-ticino': { name: 'Carburanti Ticino', path: '/articoli-frontaliere/carburanti-rincari-confine-ticino', parent: 'blog' },
 'blog-votazioni-imposizione-ticino-2026': { name: 'Votazioni marzo 2026', path: '/articoli-frontaliere/votazioni-imposizione-ticino-2026', parent: 'blog' },
 'blog-imposizione-individuale-ticino-2026': { name: 'Imposizione 2026', path: '/articoli-frontaliere/imposizione-individuale-ticino-2026', parent: 'blog' },
 'blog-no-iniziativa-antidumping-ticino': { name: 'Ticino Iniziativa', path: '/articoli-frontaliere/no-iniziativa-antidumping-ticino', parent: 'blog' },
 'blog-dumping-salariale-ticino-no-iniziativa': { name: 'Il Ticino boccia l’iniziativa contro il', path: '/articoli-frontaliere/dumping-salariale-ticino-no-iniziativa', parent: 'blog' },
 'blog-incidente-viadotto-brogeda-como': { name: 'Incidente Viadotto Brogeda', path: '/articoli-frontaliere/incidente-viadotto-brogeda-como', parent: 'blog' },
 'blog-iniziativa-contro-dumping-ticino': { name: 'Iniziativa contro dumping', path: '/articoli-frontaliere/iniziativa-contro-dumping-ticino', parent: 'blog' },
 'blog-dumping-salariale-iniziativa-mps': { name: 'Dumping salariale', path: '/articoli-frontaliere/dumping-salariale-iniziativa-mps', parent: 'blog' },
 'blog-imposizione-individuale-rivoluzione-fiscale': { name: 'Imposizione Fiscale', path: '/articoli-frontaliere/imposizione-individuale-rivoluzione-fiscale', parent: 'blog' },
 'blog-votazioni-federali-tassazione-individuale': { name: 'Votazioni federali', path: '/articoli-frontaliere/votazioni-federali-tassazione-individuale', parent: 'blog' },
 'blog-universita-ticino-frontalieri': { name: 'Università Ticino', path: '/articoli-frontaliere/universita-ticino-frontalieri', parent: 'blog' },
 'blog-franco-svizzero-frontalieri-ricchi-2026': { name: 'Frontalieri e cambio', path: '/articoli-frontaliere/franco-svizzero-frontalieri-ricchi-2026', parent: 'blog' },
 'blog-energia-costi-ticino-rincari-2026': { name: 'Energia Ticino', path: '/articoli-frontaliere/energia-costi-ticino-rincari-2026', parent: 'blog' },
 'blog-ticino-carburante-alle-stelle-quadri-berna-riduca-tasse': { name: 'Carburante', path: '/articoli-frontaliere/ticino-carburante-alle-stelle-quadri-berna-riduca-tasse', parent: 'blog' },
 'blog-un-test-per-dare-un-nome-al-dolore': { name: 'Endometriosi', path: '/articoli-frontaliere/un-test-per-dare-un-nome-al-dolore', parent: 'blog' },
 'blog-aumentare-gia-il-prezzo-della-benzina': { name: 'Aumenti Benzina', path: '/articoli-frontaliere/aumentare-gia-il-prezzo-della-benzina', parent: 'blog' },
 'blog-furti-supermercati-ponte-tresa': { name: 'Sicurezza', path: '/articoli-frontaliere/furti-supermercati-ponte-tresa', parent: 'blog' },
 'blog-ladri-intercettati-lavena-ponte-tresa': { name: 'Ladri intercettati', path: '/articoli-frontaliere/ladri-intercettati-lavena-ponte-tresa', parent: 'blog' },
 'blog-dumping-salariale-ticino-no': { name: 'Dumping salariale', path: '/articoli-frontaliere/dumping-salariale-ticino-no', parent: 'blog' },
 'blog-sospensione-costi-utenti-ticino': { name: 'Governo Ticino', path: '/articoli-frontaliere/sospensione-costi-utenti-ticino', parent: 'blog' },
 'blog-investimento-pedone-bioggio': { name: 'Incidenti stradali', path: '/articoli-frontaliere/investimento-pedone-bioggio', parent: 'blog' },
 'blog-tir-colonna-disagi-valico-brogeda': { name: 'Disagi Brogeda', path: '/articoli-frontaliere/tir-colonna-disagi-valico-brogeda', parent: 'blog' },
 'blog-iniziative-cassa-malati-costituzionalista-ticino': { name: 'Iniziative cassa malati, Gestione interp', path: '/articoli-frontaliere/iniziative-cassa-malati-costituzionalista-ticino', parent: 'blog' },
 'blog-investimenti-sicurezza-turismo-valsolda-26': { name: 'Investimenti Valsolda', path: '/articoli-frontaliere/investimenti-sicurezza-turismo-valsolda-26', parent: 'blog' },
 'blog-premio-la-rondine-2026-ticino': { name: 'Premio La Rondine', path: '/articoli-frontaliere/premio-la-rondine-2026-ticino', parent: 'blog' },
 'blog-tassi-ipotecari-ticino-medio-oriente-2026': { name: 'Tassi ipotecari', path: '/articoli-frontaliere/tassi-ipotecari-ticino-medio-oriente-2026', parent: 'blog' },
 'blog-aumento-export-bellico-svizzero-ticino': { name: 'Export Bellico Svizzero', path: '/articoli-frontaliere/aumento-export-bellico-svizzero-ticino', parent: 'blog' },
 'blog-assicurazione-auto-rincari-2026': { name: 'Assicurazione auto', path: '/articoli-frontaliere/assicurazione-auto-rincari-2026', parent: 'blog' },
 'blog-ticino-biglietti-senza-contanti': { name: 'Ticino', path: '/articoli-frontaliere/ticino-biglietti-senza-contanti', parent: 'blog' },
 'blog-aziende-como-assumono-lavoratori': { name: 'Lavoro e occupazione', path: '/articoli-frontaliere/aziende-como-assumono-lavoratori', parent: 'blog' },
 'blog-a2-giornico-cantiere-disagi-frontalieri': { name: 'Cantiere A2 Giornico', path: '/articoli-frontaliere/a2-giornico-cantiere-disagi-frontalieri', parent: 'blog' },
 'blog-tassa-traffico-pesante-camion-elettrici': { name: 'Fiscale', path: '/articoli-frontaliere/tassa-traffico-pesante-camion-elettrici', parent: 'blog' },
 'blog-logistica-sostenibile-a22': { name: 'Mobilità sostenibile', path: '/articoli-frontaliere/logistica-sostenibile-a22', parent: 'blog' },
 'blog-problemi-rotaia-bellinzona-lugano': { name: 'Trasporti', path: '/articoli-frontaliere/problemi-rotaia-bellinzona-lugano', parent: 'blog' },
 'blog-carpooling-aziendale-ticino': { name: 'Ticino e frontalieri', path: '/articoli-frontaliere/carpooling-aziendale-ticino', parent: 'blog' },
 'blog-energia-ets-von-der-leyen': { name: 'Novità', path: '/articoli-frontaliere/energia-ets-von-der-leyen', parent: 'blog' },
 'blog-permesso-g-apprendisti-frontali': { name: 'Permessi frontalieri', path: '/articoli-frontaliere/permesso-g-apprendisti-frontali', parent: 'blog' },
 'blog-assegni-familiari-frontalieri-ticino': { name: 'Assegni familiari ai frontalieri', path: '/articoli-frontaliere/assegni-familiari-frontalieri-ticino', parent: 'blog' },
 'blog-dagatra-incontro-migranti-chiasso': { name: 'A Chiasso apre ‘Dagatrà’', path: '/articoli-frontaliere/dagatra-incontro-migranti-chiasso', parent: 'blog' },
 'blog-ufficio-postale-chiasso-trasloco': { name: 'Trasloco ufficio postale', path: '/articoli-frontaliere/ufficio-postale-chiasso-trasloco', parent: 'blog' },
 'blog-confine-tesissimo-assegni-familiari': { name: 'Assegni familiari', path: '/articoli-frontaliere/confine-tesissimo-assegni-familiari', parent: 'blog' },
 'blog-chiasso-jazz-festival-2026': { name: 'Festival Jazz', path: '/articoli-frontaliere/chiasso-jazz-festival-2026', parent: 'blog' },
 'blog-apprendisti-frontalieri-riforma-permesso-g': { name: 'Riforma permesso G', path: '/articoli-frontaliere/apprendisti-frontalieri-riforma-permesso-g', parent: 'blog' },
 'blog-chiasso-piano-regolatore-telefonia': { name: 'Telefonia', path: '/articoli-frontaliere/chiasso-piano-regolatore-telefonia', parent: 'blog' },
 'blog-pensione-et-ticino-sentiero': { name: 'Aumentare l\'età di pensionamento in Tici', path: '/articoli-frontaliere/pensione-et-ticino-sentiero', parent: 'blog' },
 'blog-paradosso-ticino-lavoro': { name: 'Lavoro in Ticino', path: '/articoli-frontaliere/paradosso-ticino-lavoro', parent: 'blog' },
 'blog-lavena-ponte-tresa-giro-spaccio': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-giro-spaccio', parent: 'blog' },
 'blog-apertura-pesca-ticino': { name: 'Pesca in Ticino', path: '/articoli-frontaliere/apertura-pesca-ticino', parent: 'blog' },
 'blog-cassa-malati-franchigia-minima-ticino': { name: 'La franchigia minima dell\'assicurazione', path: '/articoli-frontaliere/cassa-malati-franchigia-minima-ticino', parent: 'blog' },
 'blog-trin-tunnel-grave-frontalieri': { name: 'Incidente stradale nel tunnel di Trin', path: '/articoli-frontaliere/trin-tunnel-grave-frontalieri', parent: 'blog' },
 'blog-chiasso-verde-sufficiente': { name: 'Chiasso', path: '/articoli-frontaliere/chiasso-verde-sufficiente', parent: 'blog' },
 'blog-comitati-malpensa-cuv-2026': { name: 'Malpensa', path: '/articoli-frontaliere/comitati-malpensa-cuv-2026', parent: 'blog' },
 'blog-borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta': { name: 'Borsa di Zurigo', path: '/articoli-frontaliere/borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta', parent: 'blog' },
 'blog-iran-tajani-non-tratta-navi': { name: 'Iran, Tajani assicura', path: '/articoli-frontaliere/iran-tajani-non-tratta-navi', parent: 'blog' },
 'blog-accordi-bilaterali-3-parlamento': { name: 'Accordi Bilaterali III, ora tocca al Par', path: '/articoli-frontaliere/accordi-bilaterali-3-parlamento', parent: 'blog' },
 'blog-viaggio-delle-batterie-verso-seconda-vita': { name: 'Riciclaggio batterie', path: '/articoli-frontaliere/viaggio-delle-batterie-verso-seconda-vita', parent: 'blog' },
 'blog-bilaterali-iii-parlamento-ticino-2026': { name: 'Bilaterali III, ora la palla passa al Pa', path: '/articoli-frontaliere/bilaterali-iii-parlamento-ticino-2026', parent: 'blog' },
 'blog-affitti-rialzo-crisi-ticino-2026': { name: 'Affitti Ticino', path: '/articoli-frontaliere/affitti-rialzo-crisi-ticino-2026', parent: 'blog' },
 'blog-bilaterali-iii-ticino-parlamento-2026': { name: 'Bilaterali III', path: '/articoli-frontaliere/bilaterali-iii-ticino-parlamento-2026', parent: 'blog' },
 'blog-truffa-lavoro-svizzera-anticipo-2026': { name: 'truffa lavoro svizzera', path: '/articoli-frontaliere/truffa-lavoro-svizzera-anticipo-2026', parent: 'blog' },
 'blog-ticino-carburanti-prezzo-potere-acquisto': { name: 'Carburanti Ticino', path: '/articoli-frontaliere/ticino-carburanti-prezzo-potere-acquisto', parent: 'blog' },
 'blog-aumento-franchigia-minima': { name: 'Ticino', path: '/articoli-frontaliere/aumento-franchigia-minima', parent: 'blog' },
 'blog-ticino-swissminiatur-inaugura-miniera-doro-sessa': { name: 'Ticino, Swissminiatur, Miniera d\'Oro', path: '/articoli-frontaliere/ticino-swissminiatur-inaugura-miniera-doro-sessa', parent: 'blog' },
 'blog-lavena-ponte-tresa-addio-antonio-cannavale': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-addio-antonio-cannavale', parent: 'blog' },
 'blog-gravincidente-stradale-regina-feriti': { name: 'Incidente stradale', path: '/articoli-frontaliere/gravincidente-stradale-regina-feriti', parent: 'blog' },
 'blog-scende-limite-nevicate-ticino': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/scende-limite-nevicate-ticino', parent: 'blog' },
 'blog-ticino-no-anti-dumping': { name: 'Di più In Ticino il \'no\' all\'iniziativa', path: '/articoli-frontaliere/ticino-no-anti-dumping', parent: 'blog' },
 'blog-chiusa-val-bedretto': { name: 'Notizie', path: '/articoli-frontaliere/chiusa-val-bedretto', parent: 'blog' },
 'blog-un-passaporto-di-fedelt': { name: 'Un passaporto di fedeltà', path: '/articoli-frontaliere/un-passaporto-di-fedelt', parent: 'blog' },
 'blog-chiusure-autostrada-confine-ticino-2026': { name: 'Chiusure A9 Ticino', path: '/articoli-frontaliere/chiusure-autostrada-confine-ticino-2026', parent: 'blog' },
 'blog-swissminiatur-miniera-doro-sessa': { name: 'Ticino Economia', path: '/articoli-frontaliere/swissminiatur-miniera-doro-sessa', parent: 'blog' },
 'blog-sondaggio-tamedia-iva-esercito-avs': { name: 'Gli svizzeri contrari all\'aumento dell\'I', path: '/articoli-frontaliere/sondaggio-tamedia-iva-esercito-avs', parent: 'blog' },
 'blog-inverno-ticino-nevicate-2026': { name: 'Inverno in Ticino', path: '/articoli-frontaliere/inverno-ticino-nevicate-2026', parent: 'blog' },
 'blog-franchigia-minima-sanitario-ticino': { name: 'Franchigia Sanitaria', path: '/articoli-frontaliere/franchigia-minima-sanitario-ticino', parent: 'blog' },
 'blog-svizzera-recessione-cieslakiewicz': { name: 'Economia e Geopolitica', path: '/articoli-frontaliere/svizzera-recessione-cieslakiewicz', parent: 'blog' },
 'blog-nevicate-strade-bloccate-ticino': { name: 'Nevicate in Ticino', path: '/articoli-frontaliere/nevicate-strade-bloccate-ticino', parent: 'blog' },
 'blog-bilaterali-terza-fase-parlamento-ticino': { name: 'Bilaterali III Ticino', path: '/articoli-frontaliere/bilaterali-terza-fase-parlamento-ticino', parent: 'blog' },
 'blog-cane-morto-binarie-campo-calcio': { name: 'Cane morto Como', path: '/articoli-frontaliere/cane-morto-binarie-campo-calcio', parent: 'blog' },
 'blog-swissminiatur-miniera-sessa-2026': { name: 'Swissminiatur 2026', path: '/articoli-frontaliere/swissminiatur-miniera-sessa-2026', parent: 'blog' },
 'blog-crescita-misera-libera-circolazione': { name: 'Crescita svizzera', path: '/articoli-frontaliere/crescita-misera-libera-circolazione', parent: 'blog' },
 'blog-treni-varese-milano-ceresio-express': { name: 'Ceresio Express', path: '/articoli-frontaliere/treni-varese-milano-ceresio-express', parent: 'blog' },
 'blog-caro-carburante-benzina-ticino': { name: 'Caro-carburante', path: '/articoli-frontaliere/caro-carburante-benzina-ticino', parent: 'blog' },
 'blog-bilaterali-iii-cassis-ticino': { name: 'Bilaterali III', path: '/articoli-frontaliere/bilaterali-iii-cassis-ticino', parent: 'blog' },
 'blog-fermato-brogeda-cocaina': { name: 'Fermato a Brogeda con oltre 15 chili di', path: '/articoli-frontaliere/fermato-brogeda-cocaina', parent: 'blog' },
 'blog-dominicano-auto-svizzera-arresto': { name: 'Arresto a Chiasso', path: '/articoli-frontaliere/dominicano-auto-svizzera-arresto', parent: 'blog' },
 'blog-salari-bassi-rischio-povert': { name: 'Economia', path: '/articoli-frontaliere/salari-bassi-rischio-povert', parent: 'blog' },
 'blog-ticino-svolta-per-apprendisti': { name: 'Novità', path: '/articoli-frontaliere/ticino-svolta-per-apprendisti', parent: 'blog' },
 'blog-bellinzona-crescita-qualita-vita': { name: 'Economia', path: '/articoli-frontaliere/bellinzona-crescita-qualita-vita', parent: 'blog' },
 'blog-crisi-spermatozoi-svizzera-ticino': { name: 'Salute', path: '/articoli-frontaliere/crisi-spermatozoi-svizzera-ticino', parent: 'blog' },
 'blog-droga-brogeda-sequestro-cocaina': { name: 'Brogeda: Droga Sequestrata', path: '/articoli-frontaliere/droga-brogeda-sequestro-cocaina', parent: 'blog' },
 'blog-bellinzona-auscultazione-2026': { name: 'Bellinzona', path: '/articoli-frontaliere/bellinzona-auscultazione-2026', parent: 'blog' },
 'blog-lombardia-affitto-famiglie-varesine': { name: 'Fondo affitti Lombardia', path: '/articoli-frontaliere/lombardia-affitto-famiglie-varesine', parent: 'blog' },
 'blog-malcantone-fai-di-primavera-2026': { name: 'Malcantone Fai di Primavera 2026', path: '/articoli-frontaliere/malcantone-fai-di-primavera-2026', parent: 'blog' },
 'blog-sicurezza-privata-chiasso-nebiopoli': { name: 'Sicurezza privata', path: '/articoli-frontaliere/sicurezza-privata-chiasso-nebiopoli', parent: 'blog' },
 'blog-sfruttamento-corsieri-ticino-2026': { name: 'Sfruttamento corrieri', path: '/articoli-frontaliere/sfruttamento-corsieri-ticino-2026', parent: 'blog' },
 'blog-lavoro-economia-2026': { name: 'La fuga di talenti a Zurigo', path: '/articoli-frontaliere/lavoro-economia-2026', parent: 'blog' },
 'blog-sequestro-cocaina-brogeda-2026': { name: 'Sequestro cocaina', path: '/articoli-frontaliere/sequestro-cocaina-brogeda-2026', parent: 'blog' },
 'blog-infiltrazioni-criminali-ticino-grigioni': { name: 'Cultura, soldi, infiltrazioni criminali', path: '/articoli-frontaliere/infiltrazioni-criminali-ticino-grigioni', parent: 'blog' },
 'blog-turismo-luganese-formazione': { name: 'Turismo e formazione', path: '/articoli-frontaliere/turismo-luganese-formazione', parent: 'blog' },
 'blog-walter-bonatti-in-capo-al-mondo': { name: 'Walter Bonatti, Montegrino Valtravaglia', path: '/articoli-frontaliere/walter-bonatti-in-capo-al-mondo', parent: 'blog' },
 'blog-sargans-teenage-robbery-catch': { name: 'Notizie sicurezza frontiera', path: '/articoli-frontaliere/sargans-teenage-robbery-catch', parent: 'blog' },
 'blog-com-aziende-lavoro-como': { name: 'Provincia di Como', path: '/articoli-frontaliere/com-aziende-lavoro-como', parent: 'blog' },
 'blog-cabov-precipita-forte-vento': { name: 'Cabinovia precipita a Engelberg', path: '/articoli-frontaliere/cabov-precipita-forte-vento', parent: 'blog' },
 'blog-gadda-incalza-governo-frontalieri': { name: 'Frontalieri', path: '/articoli-frontaliere/gadda-incalza-governo-frontalieri', parent: 'blog' },
 'blog-centovallina-riapertura-treni': { name: 'Trasporti', path: '/articoli-frontaliere/centovallina-riapertura-treni', parent: 'blog' },
 'blog-truffe-chiamate-shock-ticino': { name: 'Truffe', path: '/articoli-frontaliere/truffe-chiamate-shock-ticino', parent: 'blog' },
 'blog-spazi-verdi-in-citta-rilassamento': { name: 'Ambiente', path: '/articoli-frontaliere/spazi-verdi-in-citta-rilassamento', parent: 'blog' },
 'blog-camedo-buffet-eventi-ticino': { name: 'Eventi Ticino', path: '/articoli-frontaliere/camedo-buffet-eventi-ticino', parent: 'blog' },
 'blog-berna-discute-approvvigionamento-economico-e-13esima-avs': { name: 'Economia', path: '/articoli-frontaliere/berna-discute-approvvigionamento-economico-e-13esima-avs', parent: 'blog' },
 'blog-visita-ticinese-coira-criminalita-organizzata': { name: 'Economia', path: '/articoli-frontaliere/visita-ticinese-coira-criminalita-organizzata', parent: 'blog' },
 'blog-annunci-lavoro-dumping-ticino-governo': { name: 'Novità Lavoro', path: '/articoli-frontaliere/annunci-lavoro-dumping-ticino-governo', parent: 'blog' },
 'blog-controlli-cantieri-mendrisio': { name: 'Controlli cantieri', path: '/articoli-frontaliere/controlli-cantieri-mendrisio', parent: 'blog' },
 'blog-catastrofi-ticino-prontezza-2026': { name: 'Punti di raccolta d\'urgenza in Ticino', path: '/articoli-frontaliere/catastrofi-ticino-prontezza-2026', parent: 'blog' },
 'blog-tredicesima-avs-soluzione-mista-stati': { name: 'Tredicesima AVS', path: '/articoli-frontaliere/tredicesima-avs-soluzione-mista-stati', parent: 'blog' },
 'blog-lo-statuto-s-non-deve-trasformarsi-in-permesso-b': { name: 'Statuto S e permesso B', path: '/articoli-frontaliere/lo-statuto-s-non-deve-trasformarsi-in-permesso-b', parent: 'blog' },
 'blog-consiglio-stati-soluzione-mista-13esima-avs': { name: '13esima AVS', path: '/articoli-frontaliere/consiglio-stati-soluzione-mista-13esima-avs', parent: 'blog' },
 'blog-frode-cassa-compensazione-avs-ticino': { name: 'Frode AVS', path: '/articoli-frontaliere/frode-cassa-compensazione-avs-ticino', parent: 'blog' },
 'blog-deputazione-ticinese-italofoni-2024': { name: 'La deputazione ticinese', path: '/articoli-frontaliere/deputazione-ticinese-italofoni-2024', parent: 'blog' },
 'blog-kebab-case-turismo-ticino': { name: 'Turismo in Ticino', path: '/articoli-frontaliere/kebab-case-turismo-ticino', parent: 'blog' },
 'blog-droga-al-confine-ticino-2025': { name: 'Confine italo-svizzero', path: '/articoli-frontaliere/droga-al-confine-ticino-2025', parent: 'blog' },
 'blog-incidente-stradale-laghi': { name: 'Varese', path: '/articoli-frontaliere/incidente-stradale-laghi', parent: 'blog' },
 'blog-vivere-piu-lungo-ticino': { name: 'Vivere più a lungo in Ticino', path: '/articoli-frontaliere/vivere-piu-lungo-ticino', parent: 'blog' },
 'blog-giustizia-in-bilico-2026': { name: 'Giustizia in Ticino', path: '/articoli-frontaliere/giustizia-in-bilico-2026', parent: 'blog' },
 'blog-ampliamento-parco-eolico-san-gottardo-digital-2026': { name: 'Ampliamento del Parco eolico del San', path: '/articoli-frontaliere/ampliamento-parco-eolico-san-gottardo-digital-2026', parent: 'blog' },
 'blog-eolico-gottardo-ampliamento-2026': { name: 'Energia eolica', path: '/articoli-frontaliere/eolico-gottardo-ampliamento-2026', parent: 'blog' },
 'blog-contrabbando-ai-confine-aumentano-droga-e-sigarette': { name: 'Contrabbando ai confini', path: '/articoli-frontaliere/contrabbando-ai-confine-aumentano-droga-e-sigarette', parent: 'blog' },
 'blog-salute-prevenzione-burocrazia-svizzera': { name: 'Salute Ticino', path: '/articoli-frontaliere/salute-prevenzione-burocrazia-svizzera', parent: 'blog' },
 'blog-telefonate-choc-truffa-anziani-ticino': { name: 'Telefonate choc', path: '/articoli-frontaliere/telefonate-choc-truffa-anziani-ticino', parent: 'blog' },
 'blog-ubs-fusione-credit-suisse-ticino': { name: 'Il cantiere di UBS a tre anni dal salvat', path: '/articoli-frontaliere/ubs-fusione-credit-suisse-ticino', parent: 'blog' },
 'blog-salari-minimi-ccl-ticino-2026': { name: 'Salari Minimi e CCL in Ticino', path: '/articoli-frontaliere/salari-minimi-ccl-ticino-2026', parent: 'blog' },
 'blog-strutture-dedicate-migranti-ticino': { name: 'Migranti in Ticino', path: '/articoli-frontaliere/strutture-dedicate-migranti-ticino', parent: 'blog' },
 'blog-contratti-collettivi-salari-ticino': { name: 'Contratti collettivi di lavoro in Ticino', path: '/articoli-frontaliere/contratti-collettivi-salari-ticino', parent: 'blog' },
 'blog-tutela-sovranita-dati-sanitari': { name: 'Sanità in Ticino', path: '/articoli-frontaliere/tutela-sovranita-dati-sanitari', parent: 'blog' },
 'blog-nomine-annullate-sims-tram': { name: 'Nomine alla SIMS annullate', path: '/articoli-frontaliere/nomine-annullate-sims-tram', parent: 'blog' },
 'blog-tassa-automobilisti-svizzera': { name: 'Mobilità transfrontaliera', path: '/articoli-frontaliere/tassa-automobilisti-svizzera', parent: 'blog' },
 'blog-lavoro-richiedenti-asilo-ucraini-ticino': { name: 'Richiedenti asilo e ucraini', path: '/articoli-frontaliere/lavoro-richiedenti-asilo-ucraini-ticino', parent: 'blog' },
 'blog-riforma-scolastica-ticino-difficolta': { name: 'Riforma scolastica in Ticino', path: '/articoli-frontaliere/riforma-scolastica-ticino-difficolta', parent: 'blog' },
 'blog-tassa-transito-parlamento-ticino': { name: 'La tassa di transito in Ticino tra appro', path: '/articoli-frontaliere/tassa-transito-parlamento-ticino', parent: 'blog' },
 'blog-inclusione-migranti-ticino': { name: 'Alis e Cir', path: '/articoli-frontaliere/inclusione-migranti-ticino', parent: 'blog' },
 'blog-franco-svizzero-impatti-ticino': { name: 'Economia Ticino', path: '/articoli-frontaliere/franco-svizzero-impatti-ticino', parent: 'blog' },
 'blog-tassa-transito-automobilisti-ticino': { name: 'Tassa di transito in Ticino', path: '/articoli-frontaliere/tassa-transito-automobilisti-ticino', parent: 'blog' },
 'blog-nubifragio-coira-mesolcina-ristoro': { name: 'Nubifragio Giugno 2024', path: '/articoli-frontaliere/nubifragio-coira-mesolcina-ristoro', parent: 'blog' },
 'blog-lotta-violenza-di-genere-ticino': { name: 'Ticino e Svizzera sotto l\'attenzione del', path: '/articoli-frontaliere/lotta-violenza-di-genere-ticino', parent: 'blog' },
 'blog-tassa-transito-svizzera-2023': { name: 'Tassa di transito Svizzera 2026', path: '/articoli-frontaliere/tassa-transito-svizzera-2026', parent: 'blog' },
 'blog-controlli-cantieri-mendrisiotto': { name: 'Operazione di controllo nei cantieri del', path: '/articoli-frontaliere/controlli-cantieri-mendrisiotto', parent: 'blog' },
 'blog-acinque-lancia-piano-genitorialita': { name: 'Lavoro', path: '/articoli-frontaliere/acinque-lancia-piano-genitorialita', parent: 'blog' },
 'blog-danni-riparati-centovallina': { name: 'Danni riparati, riapre la Centovallina-V', path: '/articoli-frontaliere/danni-riparati-centovallina', parent: 'blog' },
 'blog-porrentruy-piscina-comunale-divieto': { name: 'Novità', path: '/articoli-frontaliere/porrentruy-piscina-comunale-divieto', parent: 'blog' },
 'blog-sanita-fontana-fedriga': { name: 'Sanità', path: '/articoli-frontaliere/sanita-fontana-fedriga', parent: 'blog' },
 'blog-ampliamento-parco-eolico-san-gottardo': { name: 'San Gottardo', path: '/articoli-frontaliere/ampliamento-parco-eolico-san-gottardo', parent: 'blog' },
 'blog-cure-a-domicilio-tassa-ticino': { name: 'Tassa sulle cure a domicilio', path: '/articoli-frontaliere/cure-a-domicilio-tassa-ticino', parent: 'blog' },
 'blog-kebab-case-ticino-nubifragio-grigioni': { name: 'Ticino: contributo cantonale per', path: '/articoli-frontaliere/kebab-case-ticino-nubifragio-grigioni', parent: 'blog' },
 'blog-kebab-case-rossi-bruxelles-ticino': { name: 'Tassa di transito, Bruxelles', path: '/articoli-frontaliere/kebab-case-rossi-bruxelles-ticino', parent: 'blog' },
 'blog-rinnovo-concessioni-snl-2026': { name: 'Rinnovo delle concessioni e ampliamento', path: '/articoli-frontaliere/rinnovo-concessioni-snl-2026', parent: 'blog' },
 'blog-globalisti-fuga-medio-oriente-ticino': { name: 'Fuga dei Globalisti dal Medio Oriente', path: '/articoli-frontaliere/globalisti-fuga-medio-oriente-ticino', parent: 'blog' },
 'blog-guasto-tra-parabiago-e-rho': { name: 'Ritardi ferroviari e cancellazioni', path: '/articoli-frontaliere/guasto-tra-parabiago-e-rho', parent: 'blog' },
 'blog-tassa-transito-ticino-pedemontana': { name: 'Tassa di transito in Svizzera', path: '/articoli-frontaliere/tassa-transito-ticino-pedemontana', parent: 'blog' },
 'blog-franco-svizzero-a-valori-record-2026': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/franco-svizzero-a-valori-record-2026', parent: 'blog' },
 'blog-taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi': { name: 'Tessin', path: '/articoli-frontaliere/taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi', parent: 'blog' },
 'blog-farmaci-competitiva-europa': { name: 'Industria farmaceutica', path: '/articoli-frontaliere/farmaci-competitiva-europa', parent: 'blog' },
 'blog-controlli-cantieri-mendrisiotto-2026': { name: 'Controlli Cantieri', path: '/articoli-frontaliere/controlli-cantieri-mendrisiotto-2026', parent: 'blog' },
 'blog-byd-expansion-ticino-2026': { name: 'BYD si espande in Ticino', path: '/articoli-frontaliere/byd-expansion-ticino-2026', parent: 'blog' },
 'blog-controllo-affitti-nazionale-ticino': { name: 'Caro affitti', path: '/articoli-frontaliere/controllo-affitti-nazionale-ticino', parent: 'blog' },
 'blog-cioccolato-meno-ma-pagato-di-piu': { name: 'Cioccolato in Svizzera', path: '/articoli-frontaliere/cioccolato-meno-ma-pagato-di-piu', parent: 'blog' },
 'blog-diesel-aumento-prezzi-svizzera-2026': { name: 'Prezzi Diesel', path: '/articoli-frontaliere/diesel-aumento-prezzi-svizzera-2026', parent: 'blog' },
 'blog-sanita-manifesto-varese-2026': { name: 'A Varese nasce il Manifesto per il welfa', path: '/articoli-frontaliere/sanita-manifesto-varese-2026', parent: 'blog' },
 'blog-iva-bassa-svizzera-immagine-ingannevole': { name: 'IVA Svizzera', path: '/articoli-frontaliere/iva-bassa-svizzera-immagine-ingannevole', parent: 'blog' },
 'blog-divieto-smartphone-scuola-ticino': { name: 'Divieto di smartphone nelle scuole del T', path: '/articoli-frontaliere/divieto-smartphone-scuola-ticino', parent: 'blog' },
 'blog-la-navigazione-rafforza-offerta-2026': { name: 'Navigazione Ticino', path: '/articoli-frontaliere/la-navigazione-rafforza-offerta-2026', parent: 'blog' },
 'blog-sanita-integrativa-lombardia-ticino': { name: 'Sanità Integrativa', path: '/articoli-frontaliere/sanita-integrativa-lombardia-ticino', parent: 'blog' },
 'blog-fatture-mediche-gonfiate-ticino': { name: 'Fatture Mediche', path: '/articoli-frontaliere/fatture-mediche-gonfiate-ticino', parent: 'blog' },
 'blog-divieto-cellulari-scuola-ticino': { name: 'Divieto Cellulari', path: '/articoli-frontaliere/divieto-cellulari-scuola-ticino', parent: 'blog' },
 'blog-violenza-donne-consiglio-europa-ticino': { name: 'Violenza Donne', path: '/articoli-frontaliere/violenza-donne-consiglio-europa-ticino', parent: 'blog' },
 'blog-trojani-capo-servizi-esercito-ticino': { name: 'Esercito', path: '/articoli-frontaliere/trojani-capo-servizi-esercito-ticino', parent: 'blog' },
 'blog-funivia-monteviasco-orari-corsi': { name: 'Funivia Monteviasco', path: '/articoli-frontaliere/funivia-monteviasco-orari-corsi', parent: 'blog' },
 'blog-ricchi-fuga-medio-oriente-ticino': { name: 'Ricchi in fuga', path: '/articoli-frontaliere/ricchi-fuga-medio-oriente-ticino', parent: 'blog' },
 'blog-divieto-cellulari-scuola-ticino-2024': { name: 'No Natel Ticino', path: '/articoli-frontaliere/divieto-cellulari-scuola-ticino-2024', parent: 'blog' },
 'blog-sindacati-contro-snl-ticino-2026': { name: 'Sindacati e SNL', path: '/articoli-frontaliere/sindacati-contro-snl-ticino-2026', parent: 'blog' },
 'blog-aumento-iva-costo-ticino-2026': { name: 'Quanto costerà l’aumento dell’IVA per le', path: '/articoli-frontaliere/aumento-iva-costo-ticino-2026', parent: 'blog' },
 'blog-acquarossa-nuovo-polo-filovia-2026': { name: 'Acquarossa investimenti', path: '/articoli-frontaliere/acquarossa-nuovo-polo-filovia-2026', parent: 'blog' },
 'blog-ritardo-sconto-carburante-ticino-2026': { name: 'Sconto carburante', path: '/articoli-frontaliere/ritardo-sconto-carburante-ticino-2026', parent: 'blog' },
 'blog-lavori-a8-castellanza-notturni-2026': { name: 'Lavori A8 Castellanza', path: '/articoli-frontaliere/lavori-a8-castellanza-notturni-2026', parent: 'blog' },
 'blog-quanto-costa-la-discriminazione': { name: 'Discriminazione', path: '/articoli-frontaliere/quanto-costa-la-discriminazione', parent: 'blog' },
 'blog-divieto-smartphone-scuola-ticino-2026': { name: 'Divieto smartphone', path: '/articoli-frontaliere/divieto-smartphone-scuola-ticino-2026', parent: 'blog' },
 'blog-carenza-farmaci-ticino': { name: 'Carenza farmaci', path: '/articoli-frontaliere/carenza-farmaci-ticino', parent: 'blog' },
 'blog-lago-maggiore-accesso-tutto-l-anno': { name: 'Lago Maggiore', path: '/articoli-frontaliere/lago-maggiore-accesso-tutto-l-anno', parent: 'blog' },
 'blog-spiagge-libere-sul-lago-maggiore': { name: 'Spiagge libere', path: '/articoli-frontaliere/spiagge-libere-sul-lago-maggiore', parent: 'blog' },
 'blog-snl-stagione-green-concessione': { name: 'Stagione SNL', path: '/articoli-frontaliere/snl-stagione-green-concessione', parent: 'blog' },
 'blog-smartphone-a-scuola-e-nuove-direttive': { name: 'Smartphone a scuola', path: '/articoli-frontaliere/smartphone-a-scuola-e-nuove-direttive', parent: 'blog' },
 'blog-infortuni-sul-lavoro-protesi-hi-tech': { name: 'Infortuni sul lavoro', path: '/articoli-frontaliere/infortuni-sul-lavoro-protesi-hi-tech', parent: 'blog' },
 'blog-bellinzona-scomparsa-ricerche-ticino-piemonte': { name: 'Bellinzona', path: '/articoli-frontaliere/bellinzona-scomparsa-ricerche-ticino-piemonte', parent: 'blog' },
 'blog-cure-domicilio-ticino-politica': { name: 'Cure a domicilio in Ticino', path: '/articoli-frontaliere/cure-domicilio-ticino-politica', parent: 'blog' },
 'blog-navigazione-lago-lugano-2026': { name: 'Navigazione Lago', path: '/articoli-frontaliere/navigazione-lago-lugano-2026', parent: 'blog' },
 'blog-parco-vedeggio-comuni-firman': { name: 'Firmata la nascita del Parco del Vedeggi', path: '/articoli-frontaliere/parco-vedeggio-comuni-firman', parent: 'blog' },
 'blog-stop-export-materiale-bellico': { name: 'Ticino sospende esportazioni di material', path: '/articoli-frontaliere/stop-export-materiale-bellico', parent: 'blog' },
 'blog-gestione-scontri-frontali-ticino': { name: 'Scontri violenti tra uomini nel Ticino', path: '/articoli-frontaliere/gestione-scontri-frontali-ticino', parent: 'blog' },
 'blog-auto-intrusione-frontalieri-ticino': { name: 'Controlli frontiera', path: '/articoli-frontaliere/auto-intrusione-frontalieri-ticino', parent: 'blog' },
 'blog-rischio-lugano-young-boys': { name: 'Rischio-Lugano in casa dello Young Boys', path: '/articoli-frontaliere/rischio-lugano-young-boys', parent: 'blog' },
 'blog-bossi-morto-ticino-frontalieri': { name: 'Morte Bossi', path: '/articoli-frontaliere/bossi-morto-ticino-frontalieri', parent: 'blog' },
 'blog-ogm-fallimento-ticino': { name: 'Fallimento dell’iniziativa contro gli OG', path: '/articoli-frontaliere/ogm-fallimento-ticino', parent: 'blog' },
 'blog-passaggio-statuto-s-permesso-b': { name: 'Dallo statuto S al permesso B in Ticino', path: '/articoli-frontaliere/passaggio-statuto-s-permesso-b', parent: 'blog' },
 'blog-chiusure-notturne-autostrada': { name: 'Chiusure notturne autostrada', path: '/articoli-frontaliere/chiusure-notturne-autostrada', parent: 'blog' },
 'blog-morte-bimbo-efamilia-ticino': { name: 'Morte figlio', path: '/articoli-frontaliere/morte-bimbo-efamilia-ticino', parent: 'blog' },
 'blog-fondi-hcap-restituiti': { name: 'Economia', path: '/articoli-frontaliere/fondi-hcap-restituiti', parent: 'blog' },
 'blog-bellinzona-paese-dormitorio': { name: 'Economia', path: '/articoli-frontaliere/bellinzona-paese-dormitorio', parent: 'blog' },
 'blog-ticino-attenti-ai-radar-2026': { name: 'Ticino, attenti ai radar', path: '/articoli-frontaliere/ticino-attenti-ai-radar-2026', parent: 'blog' },
 'blog-sequestro-stupefacenti-ecuador': { name: 'Sequestro di sostanze stupefacenti', path: '/articoli-frontaliere/sequestro-stupefacenti-ecuador', parent: 'blog' },
 'blog-nuovi-radar-ticino-multe': { name: 'Radar Ticino', path: '/articoli-frontaliere/nuovi-radar-ticino-multe', parent: 'blog' },
 'blog-rifugiati-ucraini-assistenza-2027': { name: 'Rifugiati', path: '/articoli-frontaliere/rifugiati-ucraini-assistenza-2027', parent: 'blog' },
 'blog-cannabis-sequestro-ticino': { name: 'Sequestro record di cannabis in Argovia', path: '/articoli-frontaliere/cannabis-sequestro-ticino', parent: 'blog' },
 'blog-pfaffikon-kanton-schwyz-franzosi-einbrecher': { name: 'Notizie', path: '/articoli-frontaliere/pfaffikon-kanton-schwyz-franzosi-einbrecher', parent: 'blog' },
 'blog-riapertura-casetta-chiosco-davesco': { name: 'Riapre la Casetta a Davesco-Soragno', path: '/articoli-frontaliere/riapertura-casetta-chiosco-davesco', parent: 'blog' },
 'blog-giovani-ticino-comuni-innovazioni': { name: 'I giovani non tornano', path: '/articoli-frontaliere/giovani-ticino-comuni-innovazioni', parent: 'blog' },
 'blog-domeniche-senza-auto-ticino-2026': { name: 'Domeniche senza auto in Svizzera', path: '/articoli-frontaliere/domeniche-senza-auto-ticino-2026', parent: 'blog' },
 'blog-chiusure-notturne-a4-ticino': { name: 'Lavori autostradali A4 Milano-Brescia', path: '/articoli-frontaliere/chiusure-notturne-a4-ticino', parent: 'blog' },
 'blog-svizzera-frontalieri-franco-lavoro': { name: 'Novità', path: '/articoli-frontaliere/svizzera-frontalieri-franco-lavoro', parent: 'blog' },
 'blog-svizzera-cern-ricerca-chip': { name: 'Ricerca sui chip', path: '/articoli-frontaliere/svizzera-cern-ricerca-chip', parent: 'blog' },
 'blog-cannabis-sequestro-ticino-2026': { name: 'Sequestro Cannabis', path: '/articoli-frontaliere/cannabis-sequestro-ticino-2026', parent: 'blog' },
 'blog-svizzeri-dubitano-difesa-paese': { name: 'Difesa Svizzera', path: '/articoli-frontaliere/svizzeri-dubitano-difesa-paese', parent: 'blog' },
 'blog-controlli-radar-ticino': { name: 'Controlli radar in Ticino', path: '/articoli-frontaliere/controlli-radar-ticino', parent: 'blog' },
 'blog-frontalieri-casa-zurigo': { name: 'Frontalieri', path: '/articoli-frontaliere/frontalieri-casa-zurigo', parent: 'blog' },
 'blog-lugano-sicurezza-2025': { name: 'Sicurezza a Lugano', path: '/articoli-frontaliere/lugano-sicurezza-2025', parent: 'blog' },
 'blog-chiasso-ora-terra-2026': { name: 'Ora della Terra Chiasso', path: '/articoli-frontaliere/chiasso-ora-terra-2026', parent: 'blog' },
 'blog-radar-ticino-riduzione': { name: 'Riduzione radar', path: '/articoli-frontaliere/radar-ticino-riduzione', parent: 'blog' },
 'blog-nomine-sims-illegittime': { name: 'Nomine SIMS', path: '/articoli-frontaliere/nomine-sims-illegittime', parent: 'blog' },
 'blog-funivia-monte-lema-stagione-2026': { name: 'Funivia Monte Lema', path: '/articoli-frontaliere/funivia-monte-lema-stagione-2026', parent: 'blog' },
 'blog-crescita-economica-ticino-2026': { name: 'Crescita economica', path: '/articoli-frontaliere/crescita-economica-ticino-2026', parent: 'blog' },
 'blog-giustizia-referendum-ticino': { name: 'Referendum sulla giustizia in Italia', path: '/articoli-frontaliere/giustizia-referendum-ticino', parent: 'blog' },
 'blog-ora-legale-permanente-ticino': { name: 'Ora legale permanente in Ticino', path: '/articoli-frontaliere/ora-legale-permanente-ticino', parent: 'blog' },
 'blog-como-asfaltature-war-costs': { name: 'Como, Rapinese', path: '/articoli-frontaliere/como-asfaltature-war-costs', parent: 'blog' },
 'blog-apprendisti-frontalieri-permessi-g': { name: 'Frontalieri: permesso G per tutta la', path: '/articoli-frontaliere/apprendisti-frontalieri-permessi-g', parent: 'blog' },
 'blog-crescita-sicurezza-ticino-2025': { name: 'Sicurezza', path: '/articoli-frontaliere/crescita-sicurezza-ticino-2025', parent: 'blog' },
 'blog-sesto-calende-centro-sportivo': { name: 'Sesto Calende centro sportivo', path: '/articoli-frontaliere/sesto-calende-centro-sportivo', parent: 'blog' },
 'blog-chiasso-missione-emergenza': { name: 'Chiasso', path: '/articoli-frontaliere/chiasso-missione-emergenza', parent: 'blog' },
 'blog-ticinesi-e-frontalieri-comprano-case-su-laghi-verbano-e-ceresio': { name: 'Ticinesi e frontalieri', path: '/articoli-frontaliere/ticinesi-e-frontalieri-comprano-case-su-laghi-verbano-e-ceresio', parent: 'blog' },
 'blog-lavena-ponte-tresa-verde': { name: 'Annaffiatoi e aiuole, il centro si cura', path: '/articoli-frontaliere/lavena-ponte-tresa-verde', parent: 'blog' },
 'blog-chiasso-missione-emergenza-luci-blu': { name: 'Chiasso Missione emergenza', path: '/articoli-frontaliere/chiasso-missione-emergenza-luci-blu', parent: 'blog' },
 'blog-aggregazione-basso-mendrisiotto-rizza-chiasso-autocritica': { name: 'Aggregazione Basso Mendrisiotto', path: '/articoli-frontaliere/aggregazione-basso-mendrisiotto-rizza-chiasso-autocritica', parent: 'blog' },
 'blog-carburanti-prezzo-rialzo-ticino': { name: 'Prezzo carburanti', path: '/articoli-frontaliere/carburanti-prezzo-rialzo-ticino', parent: 'blog' },
 'blog-guida-michelin-ticino': { name: 'Guida Michelin Ticino', path: '/articoli-frontaliere/guida-michelin-ticino', parent: 'blog' },
 'blog-eurospin-luino-occhio-al-cambio': { name: 'Colpo di stiletto / "Eurospin" di Luino,', path: '/articoli-frontaliere/eurospin-luino-occhio-al-cambio', parent: 'blog' },
 'blog-lavena-ponte-tresa-territorio-poroso': { name: 'territorio poroso', path: '/articoli-frontaliere/lavena-ponte-tresa-territorio-poroso', parent: 'blog' },
 'blog-fusione-valle-calanca-comuni': { name: 'Val Calanca, quattro Comuni studiano una', path: '/articoli-frontaliere/fusione-valle-calanca-comuni', parent: 'blog' },
 'blog-lavoro-carceri-ticino': { name: 'Lavoro in carcere', path: '/articoli-frontaliere/lavoro-carceri-ticino', parent: 'blog' },
 'blog-lavena-ponte-tresa-annaffiatoi': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-annaffiatoi', parent: 'blog' },
 'blog-bossi-commemorazione-bagarrata': { name: 'Ticino', path: '/articoli-frontaliere/bossi-commemorazione-bagarrata', parent: 'blog' },
 'blog-corsi-a-b-scuola-media-ticino': { name: 'Scuola media Ticino', path: '/articoli-frontaliere/corsi-a-b-scuola-media-ticino', parent: 'blog' },
 'blog-ticino-confine-droga': { name: 'Spaccio di droga', path: '/articoli-frontaliere/ticino-confine-droga', parent: 'blog' },
 'blog-franco-svizzero-minimi-euro': { name: 'Innovazioni economiche', path: '/articoli-frontaliere/franco-svizzero-minimi-euro', parent: 'blog' },
 'blog-benzina-conveniente': { name: 'Benzina conveniente', path: '/articoli-frontaliere/benzina-conveniente', parent: 'blog' },
 'blog-piu-interventi-soccorso-meno-vittime-montagna-ticino-2025': { name: 'Più interventi di soccorso, ma meno', path: '/articoli-frontaliere/piu-interventi-soccorso-meno-vittime-montagna-ticino-2025', parent: 'blog' },
 'blog-nei-test-neonati-ticinesi': { name: 'Test neonati', path: '/articoli-frontaliere/nei-test-neonati-ticinesi', parent: 'blog' },
 'blog-aggregazione-rischio-basso-mendrisiotto': { name: 'Aggregazione a rischio', path: '/articoli-frontaliere/aggregazione-rischio-basso-mendrisiotto', parent: 'blog' },
 'blog-congresso-svizzera-italia-varese-2026': { name: 'Congresso 2026', path: '/articoli-frontaliere/congresso-svizzera-italia-varese-2026', parent: 'blog' },
 'blog-processo-mendrisio-19-capit': { name: 'Processo Mendrisio', path: '/articoli-frontaliere/processo-mendrisio-19-capit', parent: 'blog' },
 'blog-prezzi-carburanti-ticino-marzo-2026': { name: 'Prezzi del carburante in Europa', path: '/articoli-frontaliere/prezzi-carburanti-ticino-marzo-2026', parent: 'blog' },
 'blog-via-francisca-cammino': { name: 'Via Francisca del Lucomagno', path: '/articoli-frontaliere/via-francisca-cammino', parent: 'blog' },
 'blog-lavoro-sommerso-varesotto': { name: 'Lavoro ‘sommerso’', path: '/articoli-frontaliere/lavoro-sommerso-varesotto', parent: 'blog' },
 'blog-rissa-lavena-ponte-tres': { name: 'Sicurezza', path: '/articoli-frontaliere/rissa-lavena-ponte-tres', parent: 'blog' },
 'blog-magliaso-zona-educativa-ripresa': { name: 'Scuola elementare Magliaso', path: '/articoli-frontaliere/magliaso-zona-educativa-ripresa', parent: 'blog' },
 'blog-cassa-malati-leghista-applicata-subito': { name: 'Cassa malati', path: '/articoli-frontaliere/cassa-malati-leghista-applicata-subito', parent: 'blog' },
 'blog-ronte-tresa-rissa': { name: 'Ponte Tresa', path: '/articoli-frontaliere/ronte-tresa-rissa', parent: 'blog' },
 'blog-a9-chiasso-como-chiusure-frontalieri': { name: 'Chiusure A9', path: '/articoli-frontaliere/a9-chiasso-como-chiusure-frontalieri', parent: 'blog' },
 'blog-code-nord-san-gottardo': { name: 'Code al San Gottardo', path: '/articoli-frontaliere/code-nord-san-gottardo', parent: 'blog' },
 'blog-trattative-acordo-usa-oltre-31-marzo': { name: 'Trattative commercio Usa Svizzera', path: '/articoli-frontaliere/trattative-acordo-usa-oltre-31-marzo', parent: 'blog' },
 'blog-occhiali-intelligenti-ticino-innovazione': { name: 'Innovazione Ticino', path: '/articoli-frontaliere/occhiali-intelligenti-ticino-innovazione', parent: 'blog' },
 'blog-trattative-dazi-non-valido-31-marzo': { name: 'Trattative sui dazi', path: '/articoli-frontaliere/trattative-dazi-non-valido-31-marzo', parent: 'blog' },
 'blog-trippa-dogana-novazzano': { name: 'Dogana e Frontiere', path: '/articoli-frontaliere/trippa-dogana-novazzano', parent: 'blog' },
 'blog-lavori-rete-ferroviaria-tilo': { name: 'Lavori sulla rete ferroviaria italiana,', path: '/articoli-frontaliere/lavori-rete-ferroviaria-tilo', parent: 'blog' },
 'blog-tassa-mensa-asilo-chiasso': { name: 'Tasse scolastiche', path: '/articoli-frontaliere/tassa-mensa-asilo-chiasso', parent: 'blog' },
 'blog-sindacati-ticino-leonardo-cascina-costa': { name: 'Sindacati in Ticino', path: '/articoli-frontaliere/sindacati-ticino-leonardo-cascina-costa', parent: 'blog' },
 'blog-chiasso-tassa-refezione-scuola-infanzia': { name: 'Notizie Ticino', path: '/articoli-frontaliere/chiasso-tassa-refezione-scuola-infanzia', parent: 'blog' },
 'blog-ict-reatto-commissione-tri': { name: 'Lavoro TIC in Ticino', path: '/articoli-frontaliere/ict-reatto-commissione-tri', parent: 'blog' },
 'blog-furbata-dogana-argento': { name: 'Tenta la furbata in dogana tra Como e Sv', path: '/articoli-frontaliere/furbata-dogana-argento', parent: 'blog' },
 'blog-ambasciatore-italiano-ritorno-berna': { name: 'Rientro dell\'ambasciatore italiano a Ber', path: '/articoli-frontaliere/ambasciatore-italiano-ritorno-berna', parent: 'blog' },
 'blog-aumento-contingente-uova-svizzera': { name: 'Economia', path: '/articoli-frontaliere/aumento-contingente-uova-svizzera', parent: 'blog' },
 'blog-lavori-notturni-via-lavizzari': { name: 'Viabilità', path: '/articoli-frontaliere/lavori-notturni-via-lavizzari', parent: 'blog' },
 'blog-limite-popolazione-10-milioni-ticino': { name: 'Limitare la popolazione in Ticino a 10 m', path: '/articoli-frontaliere/limite-popolazione-10-milioni-ticino', parent: 'blog' },
 'blog-settanta-chili-di-mozzarella': { name: 'Novita in Ticino', path: '/articoli-frontaliere/settanta-chili-di-mozzarella', parent: 'blog' },
 'blog-contrabbando-ticino-2026': { name: 'Contrabbando in Ticino', path: '/articoli-frontaliere/contrabbando-ticino-2026', parent: 'blog' },
 'blog-mobilita-infermieri-ticino': { name: 'Mobilità internazionale', path: '/articoli-frontaliere/mobilita-infermieri-ticino', parent: 'blog' },
 'blog-san-gottardo-code-giovedi-santo': { name: 'San Gottardo, code da Giovedì Santo', path: '/articoli-frontaliere/san-gottardo-code-giovedi-santo', parent: 'blog' },
 'blog-como-lago-pasqua-boom-prenotazioni': { name: 'Como e il Lago', path: '/articoli-frontaliere/como-lago-pasqua-boom-prenotazioni', parent: 'blog' },
 'blog-camion-panne-san-gottardo-traffico-bloccato': { name: 'Camion in panne al San Gottardo', path: '/articoli-frontaliere/camion-panne-san-gottardo-traffico-bloccato', parent: 'blog' },
 'blog-aumento-inchieste-penali-2025': { name: 'Aumento inchieste penali', path: '/articoli-frontaliere/aumento-inchieste-penali-2025', parent: 'blog' },
 'blog-dogana-chiasso-centro-tecnologico': { name: 'Economia', path: '/articoli-frontaliere/dogana-chiasso-centro-tecnologico', parent: 'blog' },
 'blog-permessi-dubbi-roveredo-insoddisfatta': { name: 'Permessi dubbi, Roveredo insoddisfatta e', path: '/articoli-frontaliere/permessi-dubbi-roveredo-insoddisfatta', parent: 'blog' },
 'blog-permessi-dimora-diversi-opinioni': { name: 'Permessi di dimora', path: '/articoli-frontaliere/permessi-dimora-diversi-opinioni', parent: 'blog' },
 'blog-chiasso-zanzara-tigre-strategia-2026': { name: 'Chiasso & Zanzara Tigre', path: '/articoli-frontaliere/chiasso-zanzara-tigre-strategia-2026', parent: 'blog' },
 'blog-trasferimento-ufficio-postale-chiasso': { name: 'Trasferimento Ufficio Postale', path: '/articoli-frontaliere/trasferimento-ufficio-postale-chiasso', parent: 'blog' },
 'blog-esame-complementare-passerella-aperte-pre-iscrizioni': { name: 'Esame complementare passerella', path: '/articoli-frontaliere/esame-complementare-passerella-aperte-pre-iscrizioni', parent: 'blog' },
 'blog-gasolio-costi-pullman-ticino-lago-como': { name: 'Lago di Como', path: '/articoli-frontaliere/gasolio-costi-pullman-ticino-lago-como', parent: 'blog' },
 'blog-turismo-pasquale-ticino-2026': { name: 'Turismo pasquale in Ticino', path: '/articoli-frontaliere/turismo-pasquale-ticino-2026', parent: 'blog' },
 'blog-mozzarella-clandestina-2026-ricerca': { name: 'Mozzarella clandestina in Ticino', path: '/articoli-frontaliere/mozzarella-clandestina-2026-ricerca', parent: 'blog' },
 'blog-accordi-svizzera-ue-2026': { name: 'Accordi Svizzera-UE verso ratifica nel 2', path: '/articoli-frontaliere/accordi-svizzera-ue-2026', parent: 'blog' },
 'blog-vacanze-di-pasqua-san-gottardo': { name: 'Vacanze di Pasqua: colonna al San Gottardo', path: '/articoli-frontaliere/vacanze-di-pasqua-san-gottardo', parent: 'blog' },
 'blog-medici-manca-verbano-ticino-2026': { name: 'Medici in Ticino e Varese', path: '/articoli-frontaliere/medici-manca-verbano-ticino-2026', parent: 'blog' },
 'blog-italia-taglia-accise-benzinai-preoccupati': { name: 'L\'Italia taglia le accise, benzinai preo', path: '/articoli-frontaliere/italia-taglia-accise-benzinai-preoccupati', parent: 'blog' },
 'blog-aumento-mezzi-pubblici-ticino': { name: 'Aumento prezzi mezzi pubblici Ticino', path: '/articoli-frontaliere/aumento-mezzi-pubblici-ticino', parent: 'blog' },
 'blog-ladri-di-auto-scappano-con-40-chiavi-e-una-skoda': { name: 'Ticino', path: '/articoli-frontaliere/ladri-di-auto-scappano-con-40-chiavi-e-una-skoda', parent: 'blog' },
 'blog-incendi-boschivi-ticino-2026': { name: 'Ambiente', path: '/articoli-frontaliere/incendi-boschivi-ticino-2026', parent: 'blog' },
 'blog-benzina-ticino-taglio-accise': { name: 'Benzina Ticino Taglio Accise', path: '/articoli-frontaliere/benzina-ticino-taglio-accise', parent: 'blog' },
 'blog-abolizione-imposta-valore-locativo-2029': { name: 'Fisco Ticino', path: '/articoli-frontaliere/abolizione-imposta-valore-locativo-2029', parent: 'blog' },
 'blog-contrabbando-pokemon-ticino': { name: 'Contrabbando di Pokémon', path: '/articoli-frontaliere/contrabbando-pokemon-ticino', parent: 'blog' },
 'blog-sconto-benzina-ticino': { name: 'Sconto benzina', path: '/articoli-frontaliere/sconto-benzina-ticino', parent: 'blog' },
 'blog-anziana-si-difende-da-una-scippatrice-e-la-fa-arrestare': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/anziana-si-difende-da-una-scippatrice-e-la-fa-arrestare', parent: 'blog' },
 'blog-supsi-bachelor-sostenibilita-2027': { name: 'SUPSI Sostenibilità', path: '/articoli-frontaliere/supsi-bachelor-sostenibilita-2027', parent: 'blog' },
 'blog-lavena-ponte-tresa-bicicletta-grave': { name: 'Frontalieri Ticino - Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-bicicletta-grave', parent: 'blog' },
 'blog-roveredo-permessi-anticrimine': { name: 'Roveredo denuncia', path: '/articoli-frontaliere/roveredo-permessi-anticrimine', parent: 'blog' },
 'blog-pasqua-messaggio-di-avvenire': { name: 'Pasqua', path: '/articoli-frontaliere/pasqua-messaggio-di-avvenire', parent: 'blog' },
 'blog-tramonto-a-cadenazzo': { name: 'Tramonto a Cadenazzo', path: '/articoli-frontaliere/tramonto-a-cadenazzo', parent: 'blog' },
 'blog-traffico-san-gottardo-2026': { name: 'Traffico paralizzato al San Gottardo', path: '/articoli-frontaliere/traffico-san-gottardo-2026', parent: 'blog' },
 'blog-auto-si-ribalta-sulla-sp1-tra-varese-e-gavirate': { name: 'Auto si ribalta sulla SP1 tra Varese e G', path: '/articoli-frontaliere/auto-si-ribalta-sulla-sp1-tra-varese-e-gavirate', parent: 'blog' },
 'blog-nestle-200-posti-lombardia': { name: 'Nestle apre sede in Lombardia e offre 20', path: '/articoli-frontaliere/nestle-200-posti-lombardia', parent: 'blog' },
 'blog-la-quinta-svizzera-che-ha-un-debole-per-milano': { name: 'La \'Quinta Svizzera\' e la Lombardia', path: '/articoli-frontaliere/la-quinta-svizzera-che-ha-un-debole-per-milano', parent: 'blog' },
 'blog-comuni-investono-turismo-ticino': { name: 'Comuni ticinesi investono nel settore tu', path: '/articoli-frontaliere/comuni-investono-turismo-ticino', parent: 'blog' },
 'blog-agriscambio': { name: 'Tanti agricoltori verso la pensione', path: '/articoli-frontaliere/agriscambio', parent: 'blog' },
 'blog-galleria-del-ceneri-chiusa-per-problemi-tecnici': { name: 'Viabilità', path: '/articoli-frontaliere/galleria-del-ceneri-chiusa-per-problemi-tecnici', parent: 'blog' },
 'blog-corso-pastori-ticino': { name: 'Corso pastori Ticino', path: '/articoli-frontaliere/corso-pastori-ticino', parent: 'blog' },
 'blog-diventare-pastore-ticino': { name: 'Formazione pastore', path: '/articoli-frontaliere/diventare-pastore-ticino', parent: 'blog' },
 'blog-trump-intesa-o-inferno': { name: 'Tensione tra Stati Uniti e Cina', path: '/articoli-frontaliere/trump-intesa-o-inferno', parent: 'blog' },
 'blog-coop-richiama-formaggi-salmonelle': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/coop-richiama-formaggi-salmonelle', parent: 'blog' },
 'blog-scambio-abiti-bellinzona': { name: 'Bellinzona', path: '/articoli-frontaliere/scambio-abiti-bellinzona', parent: 'blog' },
 'blog-protesta-costi-cure-domicilio': { name: 'Protesta contro i costi per le cure a', path: '/articoli-frontaliere/protesta-costi-cure-domicilio', parent: 'blog' },
 'blog-acqua-non-potabile-lavizzara': { name: 'Lavizzara', path: '/articoli-frontaliere/acqua-non-potabile-lavizzara', parent: 'blog' },
 'blog-nuova-direttrice-servizi-sociali-bellinzona': { name: 'Servizi sociali Bellinzona', path: '/articoli-frontaliere/nuova-direttrice-servizi-sociali-bellinzona', parent: 'blog' },
 'blog-riaperta-galleria-monte-ceneri': { name: 'Riaperta la galleria del Monte Ceneri', path: '/articoli-frontaliere/riaperta-galleria-monte-ceneri', parent: 'blog' },
 'blog-ucraini-in-ticino-aiuti-incognite': { name: 'Ucraini in Ticino', path: '/articoli-frontaliere/ucraini-in-ticino-aiuti-incognite', parent: 'blog' },
 'blog-fuga-da-dubai-ticino-alternativa': { name: 'Fuga da Dubai, il Ticino come alternativ', path: '/articoli-frontaliere/fuga-da-dubai-ticino-alternativa', parent: 'blog' },
 'blog-tax-free-come-cresce': { name: 'Economia', path: '/articoli-frontaliere/tax-free-come-cresce', parent: 'blog' },
 'blog-traffico-san-gottardo-pasquetta-2026': { name: 'Traffico Gottardo', path: '/articoli-frontaliere/traffico-san-gottardo-pasquetta-2026', parent: 'blog' },
 'blog-controlli-auto-immatricolate-grigioni': { name: 'Controlli auto Grigioni', path: '/articoli-frontaliere/controlli-auto-immatricolate-grigioni', parent: 'blog' },
 'blog-locarno-magadino-trasporto': { name: 'Trasporto lacustre', path: '/articoli-frontaliere/locarno-magadino-trasporto', parent: 'blog' },
 'blog-prezzi-benzina-ticino': { name: 'Prezzi benzina', path: '/articoli-frontaliere/prezzi-benzina-ticino', parent: 'blog' },
 'blog-lavizzara-problemi-alla-rete-idrica-niente-acqua-potabile-in-varie-zone': { name: 'Lavizzara', path: '/articoli-frontaliere/lavizzara-problemi-alla-rete-idrica-niente-acqua-potabile-in-varie-zone', parent: 'blog' },
 'blog-raffica-chiusure-a9-2026': { name: 'Chiusure e deviazioni sulla A9', path: '/articoli-frontaliere/raffica-chiusure-a9-2026', parent: 'blog' },
 'blog-conflitto-medio-oriente-energia-ticino': { name: 'Energia e rincari', path: '/articoli-frontaliere/conflitto-medio-oriente-energia-ticino', parent: 'blog' },
 'blog-lavoro-notte-lincendio-laveno-mombello': { name: 'Notizie', path: '/articoli-frontaliere/lavoro-notte-lincendio-laveno-mombello', parent: 'blog' },
 'blog-prevenzione-maschile-centro-beccaria': { name: 'Salute', path: '/articoli-frontaliere/prevenzione-maschile-centro-beccaria', parent: 'blog' },
 'blog-controlli-varese-esposto-espulsione': { name: 'Controlli nel cuore di Varese', path: '/articoli-frontaliere/controlli-varese-esposto-espulsione', parent: 'blog' },
 'blog-incidente-arogno-31enne-gravi-condizioni': { name: 'Incidente Arogno', path: '/articoli-frontaliere/incidente-arogno-31enne-gravi-condizioni', parent: 'blog' },
 'blog-carburanti-ticino-aumento-prezzi': { name: 'Prezzi carburanti in Ticino', path: '/articoli-frontaliere/carburanti-ticino-aumento-prezzi', parent: 'blog' },
 'blog-provincia-di-varese-investe-su-manutenzione-delle-strade-e-del-verde-con-i-ristorni-dei-frontalieri-2026': { name: 'Provincia di Varese: investimenti in', path: '/articoli-frontaliere/provincia-di-varese-investe-su-manutenzione-delle-strade-e-del-verde-con-i-ristorni-dei-frontalieri-2026', parent: 'blog' },
 'blog-turisti-in-como-ztl': { name: 'La famigliola di turisti investita in ce', path: '/articoli-frontaliere/turisti-in-como-ztl', parent: 'blog' },
 'blog-niederlander-droga-ticino': { name: 'Traffico di droga', path: '/articoli-frontaliere/niederlander-droga-ticino', parent: 'blog' },
 'blog-stop-agli-artigiani-per-caso': { name: 'Economia', path: '/articoli-frontaliere/stop-agli-artigiani-per-caso', parent: 'blog' },
 'blog-incendi-nel-luganese-arrestato-un-piromane': { name: 'Incendi nel Luganese', path: '/articoli-frontaliere/incendi-nel-luganese-arrestato-un-piromane', parent: 'blog' },
 'blog-front-alieri-soci-sagl-nodi-fiscali-2026': { name: 'Frontalieri fiscali', path: '/articoli-frontaliere/front-alieri-soci-sagl-nodi-fiscali-2026', parent: 'blog' },
 'blog-benzina-cara-ticino': { name: 'Benzina più cara in Svizzera', path: '/articoli-frontaliere/benzina-cara-ticino', parent: 'blog' },
 'blog-incidente-rampa-a9-chiasso-2026': { name: 'Incidenti', path: '/articoli-frontaliere/incidente-rampa-a9-chiasso-2026', parent: 'blog' },
 'blog-tilo-s50-lavori-mal-pensa-varese-2026': { name: 'TILO S50', path: '/articoli-frontaliere/tilo-s50-lavori-mal-pensa-varese-2026', parent: 'blog' },
 'blog-tilo-s50-modifiche-aprile': { name: 'Trasporti', path: '/articoli-frontaliere/tilo-s50-modifiche-aprile', parent: 'blog' },
 'blog-consiglio-federale-ferma-perequazione-2030': { name: 'Perequazione, Ticino deluso', path: '/articoli-frontaliere/consiglio-federale-ferma-perequazione-2030', parent: 'blog' },
 'blog-camionisti-furbetti-governo-ticino-2026': { name: 'Caso camionisti', path: '/articoli-frontaliere/camionisti-furbetti-governo-ticino-2026', parent: 'blog' },
 'blog-multe-vignetta-chiasso-2024': { name: 'Multe Vignetta', path: '/articoli-frontaliere/multe-vignetta-chiasso-2024', parent: 'blog' },
 'blog-petizione-aromat-svizzera': { name: 'Petizione Aromat', path: '/articoli-frontaliere/petizione-aromat-svizzera', parent: 'blog' },
 'blog-frontalieri-tassa-salute-scontro': { name: 'Tassa salute', path: '/articoli-frontaliere/frontalieri-tassa-salute-scontro', parent: 'blog' },
 'blog-multe-vignetta-chiasso-pasqua-2026': { name: 'Pasqua 2026', path: '/articoli-frontaliere/multe-vignetta-chiasso-pasqua-2026', parent: 'blog' },
 'blog-tasse-ticino-frontalieri-perequazione-2026': { name: 'Ticino penalizzato', path: '/articoli-frontaliere/tasse-ticino-frontalieri-perequazione-2026', parent: 'blog' },
 'blog-asili-bellinzona-progetto-pilota-orario-prolungato-2027': { name: 'Asili a Bellinzona', path: '/articoli-frontaliere/asili-bellinzona-progetto-pilota-orario-prolungato-2027', parent: 'blog' },
 'blog-multe-vignetta-chiasso-2026': { name: 'Multe Vignetta', path: '/articoli-frontaliere/multe-vignetta-chiasso-2026', parent: 'blog' },
 'blog-servizio-trasfusionale-locarno-chiusura-24-giugno': { name: 'Servizio Trasfusionale di Locarno chiude', path: '/articoli-frontaliere/servizio-trasfusionale-locarno-chiusura-24-giugno', parent: 'blog' },
 'blog-ritardi-disoccupazione-ticino': { name: 'Disoccupazione', path: '/articoli-frontaliere/ritardi-disoccupazione-ticino', parent: 'blog' },
 'blog-benzina-lombardia-frontalieri-ticinesi-2026': { name: 'Frontalieri presi d’assalto', path: '/articoli-frontaliere/benzina-lombardia-frontalieri-ticinesi-2026', parent: 'blog' },
 'blog-diploma-usa-non-riconosciuto-ticino': { name: 'Diploma statunitense bloccato in Ticino', path: '/articoli-frontaliere/diploma-usa-non-riconosciuto-ticino', parent: 'blog' },
 'blog-discover-eu-2026-frontalieri-ticino': { name: 'DiscoverEU 2026', path: '/articoli-frontaliere/discover-eu-2026-frontalieri-ticino', parent: 'blog' },
 'blog-banche-svizzere-pronti-clienti-golfo-2026': { name: 'Banche svizzere in allerta per i clienti', path: '/articoli-frontaliere/banche-svizzere-pronti-clienti-golfo-2026', parent: 'blog' },
 'blog-fertilizzanti-crisi-hormuz-rincari-ticino-40': { name: 'Fertilizzanti +40% in Ticino', path: '/articoli-frontaliere/fertilizzanti-crisi-hormuz-rincari-ticino-40', parent: 'blog' },
 'blog-tassa-salute-frontalieri-lombardia-isola-2026': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-frontalieri-lombardia-isola-2026', parent: 'blog' },
 'blog-reclutamento-infermieri-lombardia': { name: 'Reclutamento Infermieri', path: '/articoli-frontaliere/reclutamento-infermieri-lombardia', parent: 'blog' },
 'blog-autostrada-a9-chiude-de-notti-2026': { name: 'Autostrada A9 verso Chiasso chiusa di no', path: '/articoli-frontaliere/autostrada-a9-chiude-de-notti-2026', parent: 'blog' },
 'blog-multa-vignetta-pasqua-chiasso-2024': { name: 'Vignetta Svizzera', path: '/articoli-frontaliere/multa-vignetta-pasqua-chiasso-2024', parent: 'blog' },
 'blog-salva-venti-anni-monito-infarti': { name: 'SALVA compie 20 anni', path: '/articoli-frontaliere/salva-venti-anni-monito-infarti', parent: 'blog' },
 'blog-marchi-migros-riduzione-frontalieri-ticino': { name: 'Migros rebranding', path: '/articoli-frontaliere/marchi-migros-riduzione-frontalieri-ticino', parent: 'blog' },
 'blog-disagi-tilo-mendrisio-malpensa-2026': { name: 'Disagi Tilo', path: '/articoli-frontaliere/disagi-tilo-mendrisio-malpensa-2026', parent: 'blog' },
 'blog-cpb-forfettario-semplificato-soglia-150mila': { name: 'CPB', path: '/articoli-frontaliere/cpb-forfettario-semplificato-soglia-150mila', parent: 'blog' },
 'blog-verbano-livello-max-accordo-ticino-2026': { name: 'Verbano', path: '/articoli-frontaliere/verbano-livello-max-accordo-ticino-2026', parent: 'blog' },
 'blog-tassa-salute-frontalieri-lombardia-minacce-ticino': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-frontalieri-lombardia-minacce-ticino', parent: 'blog' },
 'blog-lavoro-frontalieri-ticino-scarse-incastri': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/lavoro-frontalieri-ticino-scarse-incastri', parent: 'blog' },
 'blog-visione-politica-fuga-giovani-ticino': { name: 'Fuga dei giovani dal Ticino', path: '/articoli-frontaliere/visione-politica-fuga-giovani-ticino', parent: 'blog' },
 'blog-cure-a-domicilio-atlas-protesta-18-aprile': { name: 'Cure a domicilio', path: '/articoli-frontaliere/cure-a-domicilio-atlas-protesta-18-aprile', parent: 'blog' },
 'blog-frontalieri-salari-perequazione-ricchezza-2026': { name: 'Frontalieri in Ticino', path: '/articoli-frontaliere/frontalieri-salari-perequazione-ricchezza-2026', parent: 'blog' },
 'blog-acqua-potabile-lavizzara-piano-peccia-monti-rima': { name: 'Acqua di nuovo potabile a Lavizzara', path: '/articoli-frontaliere/acqua-potabile-lavizzara-piano-peccia-monti-rima', parent: 'blog' },
 'blog-giovani-fuga-ticino': { name: 'Giovani Ticino', path: '/articoli-frontaliere/giovani-fuga-ticino', parent: 'blog' },
 'blog-svizzera-alleanza-porti-europei-anti-droga': { name: 'Svizzera nell’Alleanza dei porti europei', path: '/articoli-frontaliere/svizzera-alleanza-porti-europei-anti-droga', parent: 'blog' },
 'blog-glarona-domeniche-senzauto-ticino-frontalieri': { name: 'Mobilità', path: '/articoli-frontaliere/glarona-domeniche-senzauto-ticino-frontalieri', parent: 'blog' },
 'blog-controlli-frontalieri-ponte-chiasso-2025': { name: 'Frontiera e documenti', path: '/articoli-frontaliere/controlli-frontalieri-ponte-chiasso-2025', parent: 'blog' },
 'blog-frontalieri-ticino-dati-ust-2025': { name: 'Dati UST 2025', path: '/articoli-frontaliere/frontalieri-ticino-dati-ust-2025', parent: 'blog' },
 'blog-bibo-app-mezzi-pubblici-2026': { name: 'Bibo', path: '/articoli-frontaliere/bibo-app-mezzi-pubblici-2026', parent: 'blog' },
 'blog-varese-frontalieri-7000-postivacanti-2026': { name: 'Varese', path: '/articoli-frontaliere/varese-frontalieri-7000-postivacanti-2026', parent: 'blog' },
 'blog-iniziative-cassa-malati-governo-ticinese-insoddisfazione-lega-ps': { name: 'Iniziative cassa malati', path: '/articoli-frontaliere/iniziative-cassa-malati-governo-ticinese-insoddisfazione-lega-ps', parent: 'blog' },
 'blog-fermo-treni-gallarate-sesto-aprile-2026': { name: 'Fermo treni Gallarate-Sesto', path: '/articoli-frontaliere/fermo-treni-gallarate-sesto-aprile-2026', parent: 'blog' },
 'blog-bibo-sistema-biglietti-digitali-mezzi-2026': { name: 'Bibo', path: '/articoli-frontaliere/bibo-sistema-biglietti-digitali-mezzi-2026', parent: 'blog' },
 'blog-infermieri-ticinesi-ricerca-lavoro-milano': { name: 'Infermieri ticinesi', path: '/articoli-frontaliere/infermieri-ticinesi-ricerca-lavoro-milano', parent: 'blog' },
 'blog-tappa-campione-ditalia-2025-commissione': { name: 'Ticino e Campione d’Italia', path: '/articoli-frontaliere/tappa-campione-ditalia-2025-commissione', parent: 'blog' },
    'blog-nuova-strategia-zanzara-tigre-chiasso-2026': { name: 'Chiasso affida ai privati la lotta alla', path: '/articoli-frontaliere/nuova-strategia-zanzara-tigre-chiasso-2026', parent: 'blog' },
    'blog-lombardia-7mln-talenti-pmi-frontalieri': { name: 'Lombardia stanzia 7 milioni per dottori', path: '/articoli-frontaliere/lombardia-7mln-talenti-pmi-frontalieri', parent: 'blog' },
    'blog-slowup-ticino-2026-giornata-senz-auto': { name: 'slowUp Ticino 2026', path: '/articoli-frontaliere/slowup-ticino-2026-giornata-senz-auto', parent: 'blog' },
    'blog-bike-sharing-como-riapre-30-aprile': { name: 'Bike sharing a Como', path: '/articoli-frontaliere/bike-sharing-como-riapre-30-aprile', parent: 'blog' },
    'blog-progetto-ticosa-parcheggi-acinque-frontalieri': { name: 'Progetto Ticosa', path: '/articoli-frontaliere/progetto-ticosa-parcheggi-acinque-frontalieri', parent: 'blog' },
    'blog-asili-nido-bellinzona-iniziativa-firme-2026': { name: 'Asili nido pubblici', path: '/articoli-frontaliere/asili-nido-bellinzona-iniziativa-firme-2026', parent: 'blog' },
    'blog-cannabis-medica-rimborsi-casse-malati-ticino': { name: 'Cannabis terapeutica', path: '/articoli-frontaliere/cannabis-medica-rimborsi-casse-malati-ticino', parent: 'blog' },
    'blog-asili-nido-pubblici-ticino-iniziativa-popolare-2026': { name: 'Asili nido Ticino', path: '/articoli-frontaliere/asili-nido-pubblici-ticino-iniziativa-popolare-2026', parent: 'blog' },
    'blog-berna-limita-acquisto-immobili-stranieri-2026': { name: 'Novità fiscali', path: '/articoli-frontaliere/berna-limita-acquisto-immobili-stranieri-2026', parent: 'blog' },
    'blog-riforma-cassa-malati-ticino-2029': { name: 'Premi cassa malati', path: '/articoli-frontaliere/riforma-cassa-malati-ticino-2029', parent: 'blog' },
    'blog-slowup-strade-trasporti-limiti-2026': { name: 'SlowUp 2026', path: '/articoli-frontaliere/slowup-strade-trasporti-limiti-2026', parent: 'blog' },
    'blog-petrolio-e-gas-svizzera-approvvigionamento-2026': { name: 'Energia e costi', path: '/articoli-frontaliere/petrolio-e-gas-svizzera-approvvigionamento-2026', parent: 'blog' },
    'blog-fuochi-allaperto-ticino-grazie-normativa-2024': { name: 'Norme fuochi all\'aperto', path: '/articoli-frontaliere/fuochi-allaperto-ticino-grazie-normativa-2024', parent: 'blog' },
    'blog-governo-limita-acquisti-immobiliari-estero-2026': { name: 'Acquisti immobiliari dall’estero', path: '/articoli-frontaliere/governo-limita-acquisti-immobiliari-estero-2026', parent: 'blog' },
    'blog-incidente-cassano-magnago-frontalieri-ticinesi': { name: 'Incidente a Cassano Magnago', path: '/articoli-frontaliere/incidente-cassano-magnago-frontalieri-ticinesi', parent: 'blog' },
    'blog-wirt-sorpreso-einbrecher-marokkaner-ticino': { name: 'Ristoratore ticinese sorprende ladro', path: '/articoli-frontaliere/wirt-sorpreso-einbrecher-marokkaner-ticino', parent: 'blog' },
    'blog-irania-nazionale-italia-riqualifica-2026': { name: 'Novità sportive', path: '/articoli-frontaliere/irania-nazionale-italia-riqualifica-2026', parent: 'blog' },
    'blog-collaborazione-imprese-istituzioni-frontalieri-ticino': { name: 'Webuild e Salini', path: '/articoli-frontaliere/collaborazione-imprese-istituzioni-frontalieri-ticino', parent: 'blog' },
    'blog-ribaltone-mps-lovaglio-frontalieri-ticino': { name: 'Monte dei Paschi di Siena', path: '/articoli-frontaliere/ribaltone-mps-lovaglio-frontalieri-ticino', parent: 'blog' },
    'blog-giro-italia-2026-bellinzona-cari-tappa': { name: 'Giro d’Italia 2026', path: '/articoli-frontaliere/giro-italia-2026-bellinzona-cari-tappa', parent: 'blog' },
    'blog-infortunio-locarnese-operaio-frontaliero-decede': { name: 'Operaio frontaliero bulgaro muore in inc', path: '/articoli-frontaliere/infortunio-locarnese-operaio-frontaliero-decede', parent: 'blog' },
    'blog-film-swiss-sabotage-frontalieri-ticinesi': { name: 'Film Swiss Sabotage', path: '/articoli-frontaliere/film-swiss-sabotage-frontalieri-ticinesi', parent: 'blog' },
    'blog-pendolare-inverso-altdorf-lugano-problemi': { name: 'Pendolare inverso', path: '/articoli-frontaliere/pendolare-inverso-altdorf-lugano-problemi', parent: 'blog' },
    'blog-centro-breggia-risparmio-casa-arriva-balerna': { name: 'Risparmio Casa arriva al Centro Breggia', path: '/articoli-frontaliere/centro-breggia-risparmio-casa-arriva-balerna', parent: 'blog' },
    'blog-blocco-droga-confine-brogeda-2026': { name: 'Trafico di droga bloccato a Brogeda', path: '/articoli-frontaliere/blocco-droga-confine-brogeda-2026', parent: 'blog' },
    'blog-ffs-collegamenti-estivi-rimini-francia-2026': { name: 'Trasporti 2026', path: '/articoli-frontaliere/ffs-collegamenti-estivi-rimini-francia-2026', parent: 'blog' },
    'blog-strumenti-comune-chiasso-assunzione-residenti': { name: 'Chiasso cerca soluzioni per assumere più', path: '/articoli-frontaliere/strumenti-comune-chiasso-assunzione-residenti', parent: 'blog' },
    'blog-petizione-chiasso-ritorno-alla-natura-2025': { name: 'Statua ‘Ritorno alla natura’ a Chiasso', path: '/articoli-frontaliere/petizione-chiasso-ritorno-alla-natura-2025', parent: 'blog' },
    'blog-congresso-varese-2026-fisco-lavoro-ticino': { name: 'Varese 2026', path: '/articoli-frontaliere/congresso-varese-2026-fisco-lavoro-ticino', parent: 'blog' },
    'blog-psicoterapia-digitale-deprexis-rimborsata-2026': { name: 'Deprexis rimborsata da cassa malati', path: '/articoli-frontaliere/psicoterapia-digitale-deprexis-rimborsata-2026', parent: 'blog' },
    'blog-deputato-varesino-ferrara-forno-massacro-2026': { name: 'Deputato varesino a Forno di Massa', path: '/articoli-frontaliere/deputato-varesino-ferrara-forno-massacro-2026', parent: 'blog' },
    'blog-tassa-salute-ticino-riforme-invece-aggravi': { name: 'Ticino', path: '/articoli-frontaliere/tassa-salute-ticino-riforme-invece-aggravi', parent: 'blog' },
    'blog-chiassolitteratura-venti-anniversario-2026': { name: 'ChiassoLetteraria festeggia 20 anni dal', path: '/articoli-frontaliere/chiassolitteratura-venti-anniversario-2026', parent: 'blog' },
    'blog-finanze-2025-fragile-ticino': { name: 'Finanze', path: '/articoli-frontaliere/finanze-2025-fragile-ticino', parent: 'blog' },
    'blog-tassa-salute-frontalieri-lombardia-rinvio-2026': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-frontalieri-lombardia-rinvio-2026', parent: 'blog' },
    'blog-arresto-droga-confine-brogeda-2026': { name: 'Frontalieri e sicurezza', path: '/articoli-frontaliere/arresto-droga-confine-brogeda-2026', parent: 'blog' },
    'blog-manutenzione-ustat-servizi-chiusure-31-12-2025': { name: 'Servizi USTAT', path: '/articoli-frontaliere/manutenzione-ustat-servizi-chiusure-31-12-2025', parent: 'blog' },
    'blog-confine-italia-svizzera-6-regole-doganali': { name: 'Confine Italia-Svizzera', path: '/articoli-frontaliere/confine-italia-svizzera-6-regole-doganali', parent: 'blog' },
    'blog-due-arresti-brogeda-smuggling-droga-2024': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/due-arresti-brogeda-smuggling-droga-2024', parent: 'blog' },
    'blog-tutela-frontalieri-specie-invasive-ticino-2026': { name: 'Ticino', path: '/articoli-frontaliere/tutela-frontalieri-specie-invasive-ticino-2026', parent: 'blog' },
    'blog-usi-supsi-25-milioni-casse-malati': { name: 'Taglio da 25 milioni per USI e SUPSI', path: '/articoli-frontaliere/usi-supsi-25-milioni-casse-malati', parent: 'blog' },
    'blog-lega-ticino-solidarieta-casa-propria-2026': { name: 'Lega Ticino', path: '/articoli-frontaliere/lega-ticino-solidarieta-casa-propria-2026', parent: 'blog' },
    'blog-moon-stars-resident-discount-locarno-card': { name: 'Moon&Stars', path: '/articoli-frontaliere/moon-stars-resident-discount-locarno-card', parent: 'blog' },
    'blog-scoperta-quantita-marijuana-colverde-confine-ticino': { name: 'Scoperta record a Colverde', path: '/articoli-frontaliere/scoperta-quantita-marijuana-colverde-confine-ticino', parent: 'blog' },
    'blog-controlli-serali-lavena-ponte-tresa-15-aprile-2026': { name: 'Controlli straordinari a Lavena Ponte Tr', path: '/articoli-frontaliere/controlli-serali-lavena-ponte-tresa-15-aprile-2026', parent: 'blog' },
    'blog-svizzera-canada-mercati-alternativi-trump': { name: 'Accordi commerciali', path: '/articoli-frontaliere/svizzera-canada-mercati-alternativi-trump', parent: 'blog' },
    'blog-iniziative-casse-malati-61-milioni-ticino': { name: 'Casse malati Ticino', path: '/articoli-frontaliere/iniziative-casse-malati-61-milioni-ticino', parent: 'blog' },
    'blog-allentamenti-affitti-brevi-ticino-2025': { name: 'Allentamenti affitti brevi in Ticino', path: '/articoli-frontaliere/allentamenti-affitti-brevi-ticino-2025', parent: 'blog' },
    'blog-fuoriuscita-ammoniaca-rapelli-stabio': { name: 'Cronaca Stabio', path: '/articoli-frontaliere/fuoriuscita-ammoniaca-rapelli-stabio', parent: 'blog' },
    'blog-ia-selezione-personale-ticino': { name: 'IA Lavoro Ticino', path: '/articoli-frontaliere/ia-selezione-personale-ticino', parent: 'blog' },
    'blog-swiss-market-index-vedi-breve-rimbalzo': { name: 'Swiss Market Index in territorio positiv', path: '/articoli-frontaliere/swiss-market-index-vedi-breve-rimbalzo', parent: 'blog' },
    'blog-sussidi-cassa-malati-mendrisio-rallentamenti': { name: 'Sussidi cassa malati a Mendrisio', path: '/articoli-frontaliere/sussidi-cassa-malati-mendrisio-rallentamenti', parent: 'blog' },
    'blog-sussidi-cassa-malati-mendrisio-ritardi': { name: 'Mendrisio', path: '/articoli-frontaliere/sussidi-cassa-malati-mendrisio-ritardi', parent: 'blog' },
    'blog-varese-economia-frontalieri-ticino-2026': { name: 'Varese economia in crescita', path: '/articoli-frontaliere/varese-economia-frontalieri-ticino-2026', parent: 'blog' },
    'blog-lombardia-investimento-moda-ticinesi-next-fashion': { name: 'Lombardia investe 12,3 milioni in moda', path: '/articoli-frontaliere/lombardia-investimento-moda-ticinesi-next-fashion', parent: 'blog' },
    'blog-svizzera-usa-nuovi-negoziati-commerciali-2026': { name: 'Svizzera-USA', path: '/articoli-frontaliere/svizzera-usa-nuovi-negoziati-commerciali-2026', parent: 'blog' },
    'blog-aumento-kerosene-voli-cancellati-frontalieri-ticino': { name: 'Trasporti aerei', path: '/articoli-frontaliere/aumento-kerosene-voli-cancellati-frontalieri-ticino', parent: 'blog' },
    'blog-radar-controlli-velocita-ticino-aprile-2026': { name: 'Radar mobili in Ticino', path: '/articoli-frontaliere/radar-controlli-velocita-ticino-aprile-2026', parent: 'blog' },
    'blog-nuove-tratte-estive-ffs-ticino-2026': { name: 'Mobilità transfrontaliera', path: '/articoli-frontaliere/nuove-tratte-estive-ffs-ticino-2026', parent: 'blog' },
    'blog-malpensa-carburante-rischio-frontalieri-2026': { name: 'Malpensa senza carburante', path: '/articoli-frontaliere/malpensa-carburante-rischio-frontalieri-2026', parent: 'blog' },
    'blog-nuovo-potabilizzatore-mobile-emergenza-ticino': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/nuovo-potabilizzatore-mobile-emergenza-ticino', parent: 'blog' },
    'blog-nuovo-potabilizzatore-mobile-ticino-emergenza': { name: 'Acqua potabile in emergenza', path: '/articoli-frontaliere/nuovo-potabilizzatore-mobile-ticino-emergenza', parent: 'blog' },
    'blog-palaraiffeisen-porta-aperte-lugano-2026': { name: 'PalaRaiffeisen 2026', path: '/articoli-frontaliere/palaraiffeisen-porta-aperte-lugano-2026', parent: 'blog' },
    'blog-fashion-outlet-landquart-15-nuovi-negozi-expansion': { name: 'Fashion Outlet Landquart', path: '/articoli-frontaliere/fashion-outlet-landquart-15-nuovi-negozi-expansion', parent: 'blog' },
    'blog-salario-minimo-25-chf-ticino': { name: 'Salario Minimo', path: '/articoli-frontaliere/salario-minimo-25-chf-ticino', parent: 'blog' },
    'blog-confindustria-varese-paciaroni-2026': { name: 'Confindustria Varese', path: '/articoli-frontaliere/confindustria-varese-paciaroni-2026', parent: 'blog' },
    'blog-finanza-ticino-si-reinventa-economia-dati': { name: 'Finanza ticinese si reinventa', path: '/articoli-frontaliere/finanza-ticino-si-reinventa-economia-dati', parent: 'blog' },
    'blog-coppa-del-mondo-orientamento-locarnese-2026': { name: 'Eventi sportivi', path: '/articoli-frontaliere/coppa-del-mondo-orientamento-locarnese-2026', parent: 'blog' },
    'blog-grigioni-governo-2026-nove-candidati': { name: 'Grigioni', path: '/articoli-frontaliere/grigioni-governo-2026-nove-candidati', parent: 'blog' },
    'blog-svizzera-usa-accordo-commerciale-2026': { name: 'Svizzera-USA', path: '/articoli-frontaliere/svizzera-usa-accordo-commerciale-2026', parent: 'blog' },
    'blog-risoluzione-federviti-vino-ticinese-2025': { name: 'Federviti lancia risoluzione', path: '/articoli-frontaliere/risoluzione-federviti-vino-ticinese-2025', parent: 'blog' },
    'blog-iniziative-cassa-malati-piano-lega-ticino': { name: 'Cassa malati Ticino', path: '/articoli-frontaliere/iniziative-cassa-malati-piano-lega-ticino', parent: 'blog' },
    'blog-chiusura-ramo-a8-a9-notte-lavori-2026': { name: 'A8-A9 verso Chiasso chiusa di notte', path: '/articoli-frontaliere/chiusura-ramo-a8-a9-notte-lavori-2026', parent: 'blog' },
    'blog-ia-swiss-re-produttivita-ceo-berger': { name: 'L’IA riduce i tempi di determinazione de', path: '/articoli-frontaliere/ia-swiss-re-produttivita-ceo-berger', parent: 'blog' },
    'blog-rinascita-praterie-sommerse-laghi-ticino': { name: 'Progetto Echo', path: '/articoli-frontaliere/rinascita-praterie-sommerse-laghi-ticino', parent: 'blog' },
    'blog-fuga-ammoniaca-stabio-rapelli-allerta-ticino': { name: 'Fuga di ammoniaca a Stabio', path: '/articoli-frontaliere/fuga-ammoniaca-stabio-rapelli-allerta-ticino', parent: 'blog' },
    'blog-inaugurazione-ail-arena-lugano-30-31-maggio': { name: 'AIL Arena a Lugano', path: '/articoli-frontaliere/inaugurazione-ail-arena-lugano-30-31-maggio', parent: 'blog' },
    'blog-sussidi-cassa-malati-mendrisio-ritardi-2026': { name: 'Ritardi negli assegni cassa malati a Men', path: '/articoli-frontaliere/sussidi-cassa-malati-mendrisio-ritardi-2026', parent: 'blog' },
    'blog-alloggi-frontalieri-ticino-crisi-2025': { name: 'Casa e mercato', path: '/articoli-frontaliere/alloggi-frontalieri-ticino-crisi-2025', parent: 'blog' },
    'blog-grandine-bellinzonese-allerta-lugano-chiasso-19-aprile-2026': { name: 'Maltempo Ticino', path: '/articoli-frontaliere/grandine-bellinzonese-allerta-lugano-chiasso-19-aprile-2026', parent: 'blog' },
    'blog-sportello-dipendenze-digitali-ticino-2024': { name: 'Ticino', path: '/articoli-frontaliere/sportello-dipendenze-digitali-ticino-2024', parent: 'blog' },
    'blog-tasse-agevolate-milionari-ticino-golfo': { name: 'Ticino, paradiso fiscale per milionari i', path: '/articoli-frontaliere/tasse-agevolate-milionari-ticino-golfo', parent: 'blog' },
    'blog-infermiere-pratiche-avanzate-ticino-2024': { name: 'APN Ticino', path: '/articoli-frontaliere/infermiere-pratiche-avanzate-ticino-2024', parent: 'blog' },
    'blog-caos-medioriente-e-impatti-costruzione-ticino': { name: 'Medio Oriente in fiamme', path: '/articoli-frontaliere/caos-medioriente-e-impatti-costruzione-ticino', parent: 'blog' },
    'blog-parmelin-washington-dazi-usa-2026': { name: 'Dazi USA', path: '/articoli-frontaliere/parmelin-washington-dazi-usa-2026', parent: 'blog' },
    'blog-gang-colombiani-verbano-arresti-ticino-2026': { name: 'Tre colombiani arrestati per furto sul V', path: '/articoli-frontaliere/gang-colombiani-verbano-arresti-ticino-2026', parent: 'blog' },
    'blog-parmelin-accordo-investimenti-bahrein-2026': { name: 'Parmelin firma accordo con Bahrein per p', path: '/articoli-frontaliere/parmelin-accordo-investimenti-bahrein-2026', parent: 'blog' },
    'blog-palazzo-civico-collegiata-accessibilita-bellinzona-2026': { name: 'Palazzo civico e Collegiata di Bellinzon', path: '/articoli-frontaliere/palazzo-civico-collegiata-accessibilita-bellinzona-2026', parent: 'blog' },
    'blog-roche-farmaci-obesita-ticino-2026': { name: 'Farmaci obesità', path: '/articoli-frontaliere/roche-farmaci-obesita-ticino-2026', parent: 'blog' },
    'blog-chiusure-autostrada-a9-lombardia-2026': { name: 'Chiusure autostrada', path: '/articoli-frontaliere/chiusure-autostrada-a9-lombardia-2026', parent: 'blog' },
    'blog-capre-dogana-gandria-incidenti-2026': { name: 'Capre dogana Gandria', path: '/articoli-frontaliere/capre-dogana-gandria-incidenti-2026', parent: 'blog' },
    'blog-lavori-autostrade-ticino-aprile-2026': { name: 'Lavori autostrade', path: '/articoli-frontaliere/lavori-autostrade-ticino-aprile-2026', parent: 'blog' },
    'blog-militari-treni-ticino-20-euro': { name: 'Novità', path: '/articoli-frontaliere/militari-treni-ticino-20-euro', parent: 'blog' },
    'blog-just-eat-migros-ticino-consegna-2026': { name: 'Novità', path: '/articoli-frontaliere/just-eat-migros-ticino-consegna-2026', parent: 'blog' },
    'blog-capre-dogana-gandria-intervento-30-marzo': { name: 'Notizie', path: '/articoli-frontaliere/capre-dogana-gandria-intervento-30-marzo', parent: 'blog' },
    'blog-costi-cure-domocilio-ticino-2026': { name: 'Cure a domicilio', path: '/articoli-frontaliere/costi-cure-domocilio-ticino-2026', parent: 'blog' },
    'blog-salario-minimo-ticino-2027-2029': { name: 'Salario minimo', path: '/articoli-frontaliere/salario-minimo-ticino-2027-2029', parent: 'blog' },
    'blog-cure-domocilio-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/cure-domocilio-ticino-2026', parent: 'blog' },
    'blog-asili-nido-bellinzona-sussidi-2026': { name: 'Asili nido Bellinzona', path: '/articoli-frontaliere/asili-nido-bellinzona-sussidi-2026', parent: 'blog' },
    'blog-giovani-scomparsi-7-cantoni': { name: 'In sette cantoni stanno scomparendo i', path: '/articoli-frontaliere/giovani-scomparsi-7-cantoni', parent: 'blog' },
    'blog-svizzeri-italiani-cucina-preferita': { name: 'Novità', path: '/articoli-frontaliere/svizzeri-italiani-cucina-preferita', parent: 'blog' },
    'blog-svizzera-chiude-investitori-immobiliari-stranieri': { name: 'Novità', path: '/articoli-frontaliere/svizzera-chiude-investitori-immobiliari-stranieri', parent: 'blog' },
    'blog-salario-minimo-ticino-2027-2029-nuove-regole': { name: 'Salario minimo', path: '/articoli-frontaliere/salario-minimo-ticino-2027-2029-nuove-regole', parent: 'blog' },
    'blog-cybercrimepolice-ticino-italiano-2026': { name: 'Novità', path: '/articoli-frontaliere/cybercrimepolice-ticino-italiano-2026', parent: 'blog' },
    'blog-azienda-assume-autisti-lombardia-800-euro': { name: 'Novità', path: '/articoli-frontaliere/azienda-assume-autisti-lombardia-800-euro', parent: 'blog' },
    'blog-bancastato-walking-mendrisio-2026': { name: 'Eventi', path: '/articoli-frontaliere/bancastato-walking-mendrisio-2026', parent: 'blog' },
    'blog-whp-premia-aziende-ticino-2026': { name: 'WHP Ticino', path: '/articoli-frontaliere/whp-premia-aziende-ticino-2026', parent: 'blog' },
    'blog-rapina-milano-frontaliere-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/rapina-milano-frontaliere-ticino-2026', parent: 'blog' },
    'blog-frontalieri-contributo-sanitario-2026': { name: 'Frontalieri', path: '/articoli-frontaliere/frontalieri-contributo-sanitario-2026', parent: 'blog' },
    'blog-bellinzona-calcio-licenza-negata-finanze': { name: 'Bellinzona', path: '/articoli-frontaliere/bellinzona-calcio-licenza-negata-finanze', parent: 'blog' },
    'blog-mozione-salute-vigili-fuoco-lombardia': { name: 'Mozione salute', path: '/articoli-frontaliere/mozione-salute-vigili-fuoco-lombardia', parent: 'blog' },
    'blog-cuasso-monte-ospedale-frontalieri-chiusura': { name: 'Novità', path: '/articoli-frontaliere/cuasso-monte-ospedale-frontalieri-chiusura', parent: 'blog' },
    'blog-tassa-salute-frontalieri-lombardia-2026': { name: 'Tassa salute', path: '/articoli-frontaliere/tassa-salute-frontalieri-lombardia-2026', parent: 'blog' },
    'blog-donne-arte-chiasso-2026': { name: 'Donna in arte', path: '/articoli-frontaliere/donne-arte-chiasso-2026', parent: 'blog' },
    'blog-cameradi-commercio-2026-integrazione': { name: 'Varese', path: '/articoli-frontaliere/cameradi-commercio-2026-integrazione', parent: 'blog' },
    'blog-basiletti-main-draw-chiasso-2026': { name: 'Novità', path: '/articoli-frontaliere/basiletti-main-draw-chiasso-2026', parent: 'blog' },
    'blog-ticino-trasporto-pubblico-priorita': { name: 'Trasporto pubblico', path: '/articoli-frontaliere/ticino-trasporto-pubblico-priorita', parent: 'blog' },
    'blog-omaggio-angeli-ponte-chiasso': { name: 'Omaggio Angeli', path: '/articoli-frontaliere/omaggio-angeli-ponte-chiasso', parent: 'blog' },
    'blog-dogana-chiasso-traffico-2026': { name: 'Dogana Chiasso', path: '/articoli-frontaliere/dogana-chiasso-traffico-2026', parent: 'blog' },
    'blog-integrazione-lavoro-stranieri-ticino-2026': { name: 'Integrazione lavorativa', path: '/articoli-frontaliere/integrazione-lavoro-stranieri-ticino-2026', parent: 'blog' },
    'blog-salario-minimo-ticino-2029-4000-franchi': { name: 'Salario minimo', path: '/articoli-frontaliere/salario-minimo-ticino-2029-4000-franchi', parent: 'blog' },
    'blog-guasti-trenord-aprile-2026': { name: 'Trasporti Lombardia', path: '/articoli-frontaliere/guasti-trenord-aprile-2026', parent: 'blog' },
    'blog-ponte-chiasso-sanita-2026': { name: 'Sanità Ponte Chiasso', path: '/articoli-frontaliere/ponte-chiasso-sanita-2026', parent: 'blog' },
    'blog-soloaffitti-como-frontalieri-ticino': { name: 'Affitti Como', path: '/articoli-frontaliere/soloaffitti-como-frontalieri-ticino', parent: 'blog' },
    'blog-aumenti-stipendi-medici-infermieri-lombardia': { name: 'Novità', path: '/articoli-frontaliere/aumenti-stipendi-medici-infermieri-lombardia', parent: 'blog' },
    'blog-svincolo-a2-sigirino-ritardo': { name: 'Svincolo A2 Sigirino', path: '/articoli-frontaliere/svincolo-a2-sigirino-ritardo', parent: 'blog' },
    'blog-salari-svizzera-aumentati-2025': { name: 'Salari Svizzera', path: '/articoli-frontaliere/salari-svizzera-aumentati-2025', parent: 'blog' },
    'blog-academy-fnma-autisti-bus-2026': { name: 'Academy FNMA', path: '/articoli-frontaliere/academy-fnma-autisti-bus-2026', parent: 'blog' },
    'blog-patentino-digitale-lombardia-2026': { name: 'Novità', path: '/articoli-frontaliere/patentino-digitale-lombardia-2026', parent: 'blog' },
    'blog-chiamate-shock-arresti-locarnese-2024': { name: 'Novità', path: '/articoli-frontaliere/chiamate-shock-arresti-locarnese-2024', parent: 'blog' },
    'blog-valbianca-in-forti-difficolta-airolo-mette-1-5-milioni-e-aumenta-il-moltiplicatore': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/valbianca-in-forti-difficolta-airolo-mette-1-5-milioni-e-aumenta-il-moltiplicatore', parent: 'blog' },
    'blog-aumento-stipendi-frontalieri-lombardia-2026': { name: 'Novità', path: '/articoli-frontaliere/aumento-stipendi-frontalieri-lombardia-2026', parent: 'blog' },
    'blog-cantieri-sottoceneri-estate-2024': { name: 'Cantieri Sottoceneri', path: '/articoli-frontaliere/cantieri-sottoceneri-estate-2024', parent: 'blog' },
    'blog-ricarica-auto-elettriche-campione-2026': { name: 'Novità', path: '/articoli-frontaliere/ricarica-auto-elettriche-campione-2026', parent: 'blog' },
    'blog-cena-spring-avsi-libano-castiglione': { name: 'Eventi', path: '/articoli-frontaliere/cena-spring-avsi-libano-castiglione', parent: 'blog' },
    'blog-permessi-dimora-grigioni-cambia-prassi': { name: 'Novità', path: '/articoli-frontaliere/permessi-dimora-grigioni-cambia-prassi', parent: 'blog' },
    'blog-divario-salariale-frontalieri-ticino-2026': { name: 'Divario salariale', path: '/articoli-frontaliere/divario-salariale-frontalieri-ticino-2026', parent: 'blog' },
    'blog-bandecchi-quarti-chiasso-2026': { name: 'Sport', path: '/articoli-frontaliere/bandecchi-quarti-chiasso-2026', parent: 'blog' },
    'blog-cantello-peduncolo-gaggiolo-2026': { name: 'Novità', path: '/articoli-frontaliere/cantello-peduncolo-gaggiolo-2026', parent: 'blog' },
    'blog-assegno-educativo-mendrisio-2026': { name: 'Assegno educativo', path: '/articoli-frontaliere/assegno-educativo-mendrisio-2026', parent: 'blog' },
    'blog-grigioni-permessi-dimora-2026': { name: 'Novità', path: '/articoli-frontaliere/grigioni-permessi-dimora-2026', parent: 'blog' },
    'blog-aumento-stipendi-medici-infermieri-lombardia-2026': { name: 'Aumento stipendi', path: '/articoli-frontaliere/aumento-stipendi-medici-infermieri-lombardia-2026', parent: 'blog' },
    'blog-dividere-lavoratori-salari-2026': { name: 'Novità', path: '/articoli-frontaliere/dividere-lavoratori-salari-2026', parent: 'blog' },
    'blog-lufthansa-bagaglio-gratuito-eliminato': { name: 'Novità', path: '/articoli-frontaliere/lufthansa-bagaglio-gratuito-eliminato', parent: 'blog' },
    'blog-como-frazione-tavernola-banditi-assaltano-gioielleria-e-si-dileguano': { name: 'Banditi assaltano gioielleria a Tavernola', path: '/articoli-frontaliere/como-frazione-tavernola-banditi-assaltano-gioielleria-e-si-dileguano', parent: 'blog' },
    'blog-regione-lombardia-aumento-stipendi-medici-infermieri': { name: 'Regione Lombardia, aumento stipendi medici', path: '/articoli-frontaliere/regione-lombardia-aumento-stipendi-medici-infermieri', parent: 'blog' },
    'blog-divario-salari-ticino-frontalieri-2026': { name: 'Divario salariale', path: '/articoli-frontaliere/divario-salari-ticino-frontalieri-2026', parent: 'blog' },
    'blog-economia-svizzera-rischio-burocrazia': { name: 'Novità', path: '/articoli-frontaliere/economia-svizzera-rischio-burocrazia', parent: 'blog' },
    'blog-samira-de-stefano-semifinale-chiasso': { name: 'Novità', path: '/articoli-frontaliere/samira-de-stefano-semifinale-chiasso', parent: 'blog' },
    'blog-omaggio-angeli-ponte-chiasso-2026': { name: 'Omaggio agli Angeli', path: '/articoli-frontaliere/omaggio-angeli-ponte-chiasso-2026', parent: 'blog' },
    'blog-polizia-stabio-futuro-incerto': { name: 'Novità', path: '/articoli-frontaliere/polizia-stabio-futuro-incerto', parent: 'blog' },
    'blog-settimana-corta-ticino-2026': { name: 'Settimana corta', path: '/articoli-frontaliere/settimana-corta-ticino-2026', parent: 'blog' },
    'blog-comco-ia-criteri-2026': { name: 'Novità', path: '/articoli-frontaliere/comco-ia-criteri-2026', parent: 'blog' },
    'blog-autista-belga-20-ore-thurgau-intervento': { name: 'Novità', path: '/articoli-frontaliere/autista-belga-20-ore-thurgau-intervento', parent: 'blog' },
    'blog-ust-neuchatel-telelavoro-300-dipendenti': { name: 'UST Neuchâtel', path: '/articoli-frontaliere/ust-neuchatel-telelavoro-300-dipendenti', parent: 'blog' },
    'blog-cartaelettronica-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/cartaelettronica-varese-2026', parent: 'blog' },
    'blog-frode-crediti-covid-ticino-3334-casi': { name: 'Frode crediti Covid', path: '/articoli-frontaliere/frode-crediti-covid-ticino-3334-casi', parent: 'blog' },
    'blog-frontalieri-tassa-salute-lombardia': { name: 'Frontalieri, “tassa sulla salute” al via', path: '/articoli-frontaliere/frontalieri-tassa-salute-lombardia', parent: 'blog' },
    'blog-casa-ticino-2026-piu-difficile': { name: 'Mercato immobiliare', path: '/articoli-frontaliere/casa-ticino-2026-piu-difficile', parent: 'blog' },
    'blog-sicurezza-frontalieri-ticino-2024': { name: 'Sicurezza', path: '/articoli-frontaliere/sicurezza-frontalieri-ticino-2024', parent: 'blog' },
    'blog-vacanze-estive-2026-costi-guerra': { name: 'Vacanze estive', path: '/articoli-frontaliere/vacanze-estive-2026-costi-guerra', parent: 'blog' },
    'blog-irb-bellinzona-valore-aggiunto-ticino': { name: 'IRB Bellinzona', path: '/articoli-frontaliere/irb-bellinzona-valore-aggiunto-ticino', parent: 'blog' },
    'blog-incentivo-remigrazione-frontalieri-ticino': { name: 'Novità', path: '/articoli-frontaliere/incentivo-remigrazione-frontalieri-ticino', parent: 'blog' },
    'blog-confederazione-cantoni-ridiscutono-compiti-2026': { name: 'Novità', path: '/articoli-frontaliere/confederazione-cantoni-ridiscutono-compiti-2026', parent: 'blog' },
    'blog-asili-nido-bellinzona-asp-2026': { name: 'Asili nido Bellinzona', path: '/articoli-frontaliere/asili-nido-bellinzona-asp-2026', parent: 'blog' },
    'blog-lavena-ponte-tresa-battesimo-civico-2026': { name: 'Eventi', path: '/articoli-frontaliere/lavena-ponte-tresa-battesimo-civico-2026', parent: 'blog' },
    'blog-ferrovia-tilo-s40-fermi-italia-personale': { name: 'Disagi ferroviari', path: '/articoli-frontaliere/ferrovia-tilo-s40-fermi-italia-personale', parent: 'blog' },
    'blog-grigioni-stretta-permessi-dimora-2026': { name: 'Novità', path: '/articoli-frontaliere/grigioni-stretta-permessi-dimora-2026', parent: 'blog' },
    'blog-spese-cura-frontalieri-ufas-2026': { name: 'Novità', path: '/articoli-frontaliere/spese-cura-frontalieri-ufas-2026', parent: 'blog' },
    'blog-miliardari-dubai-svizzera-lugano': { name: 'Novità', path: '/articoli-frontaliere/miliardari-dubai-svizzera-lugano', parent: 'blog' },
    'blog-crans-montana-spese-cura-italiani-ufas-2026': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-spese-cura-italiani-ufas-2026', parent: 'blog' },
    'blog-alleanza-clima-ticino-comuni': { name: 'Alleanza clima', path: '/articoli-frontaliere/alleanza-clima-ticino-comuni', parent: 'blog' },
    'blog-marketing-territoriale-varese-35000-euro': { name: 'Marketing Territoriale', path: '/articoli-frontaliere/marketing-territoriale-varese-35000-euro', parent: 'blog' },
    'blog-nuova-tassa-frontalieri-2026': { name: 'Nuova tassa frontalieri', path: '/articoli-frontaliere/nuova-tassa-frontalieri-2026', parent: 'blog' },
    'blog-crans-montana-fatture-cure-italiani-2026': { name: 'Crans-Montana: fatture cure italiani', path: '/articoli-frontaliere/crans-montana-fatture-cure-italiani-2026', parent: 'blog' },
    'blog-svizzeri-shopping-como-700-milioni': { name: 'Novità', path: '/articoli-frontaliere/svizzeri-shopping-como-700-milioni', parent: 'blog' },
    'blog-apprendisti-ticino-incidenti-2026': { name: 'Novità', path: '/articoli-frontaliere/apprendisti-ticino-incidenti-2026', parent: 'blog' },
    'blog-fiorenzo-dado-le-sue-tre-p-e-gli-statali-nella-morsa-politica': { name: 'Fiorenzo Dadò, le sue tre «P» e gli stat', path: '/articoli-frontaliere/fiorenzo-dado-le-sue-tre-p-e-gli-statali-nella-morsa-politica', parent: 'blog' },
    'blog-medici-senza-permesso-svizzera-2026': { name: 'Sanità', path: '/articoli-frontaliere/medici-senza-permesso-svizzera-2026', parent: 'blog' },
    'blog-crans-montana-spese-cura-italiani-2026': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-spese-cura-italiani-2026', parent: 'blog' },
    'blog-lombardia-aumenta-stipendi-sanitari-2026': { name: 'Novità', path: '/articoli-frontaliere/lombardia-aumenta-stipendi-sanitari-2026', parent: 'blog' },
    'blog-petizione-gioventu-comunista-tassa-esenzione-militare': { name: 'Petizione militare', path: '/articoli-frontaliere/petizione-gioventu-comunista-tassa-esenzione-militare', parent: 'blog' },
    'blog-petizione-tassa-esenzione-militare-ticino': { name: 'Petizione tassa militare', path: '/articoli-frontaliere/petizione-tassa-esenzione-militare-ticino', parent: 'blog' },
    'blog-immigrazione-svizzera-60-anni-2026': { name: 'Immigrazione Svizzera', path: '/articoli-frontaliere/immigrazione-svizzera-60-anni-2026', parent: 'blog' },
    'blog-supermercati-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/supermercati-ticino-2026', parent: 'blog' },
    'blog-latte-ticino-crisi-politica-ritardo': { name: 'Novità', path: '/articoli-frontaliere/latte-ticino-crisi-politica-ritardo', parent: 'blog' },
    'blog-maria-timofeeva-trionfa-chiasso-2026': { name: 'Sport', path: '/articoli-frontaliere/maria-timofeeva-trionfa-chiasso-2026', parent: 'blog' },
    'blog-crans-montana-cure-italiani-2026': { name: 'Crans-Montana cure', path: '/articoli-frontaliere/crans-montana-cure-italiani-2026', parent: 'blog' },
    'blog-costi-salute-svizzera-frontalieri-2026': { name: 'Costi salute', path: '/articoli-frontaliere/costi-salute-svizzera-frontalieri-2026', parent: 'blog' },
    'blog-imposta-ocse-multinazionali-obiettivi-lontani': { name: 'Fiscale', path: '/articoli-frontaliere/imposta-ocse-multinazionali-obiettivi-lontani', parent: 'blog' },
    'blog-settimana-corta-svizzera-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/settimana-corta-svizzera-frontalieri', parent: 'blog' },
    'blog-adulti-genitori-sostegno-finanziario-ticino-2026': { name: 'Sostegno finanziario', path: '/articoli-frontaliere/adulti-genitori-sostegno-finanziario-ticino-2026', parent: 'blog' },
    'blog-swiss-lufthansa-economy-basic-2026': { name: 'Novità', path: '/articoli-frontaliere/swiss-lufthansa-economy-basic-2026', parent: 'blog' },
    'blog-twint-account-frode-frontalieri': { name: 'Frode TWINT', path: '/articoli-frontaliere/twint-account-frode-frontalieri', parent: 'blog' },
    'blog-costi-sanitari-ticino-2024-4-percento': { name: 'Sanità Ticino', path: '/articoli-frontaliere/costi-sanitari-ticino-2024-4-percento', parent: 'blog' },
    'blog-cybersicurezza-industriale-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/cybersicurezza-industriale-ticino-2026', parent: 'blog' },
    'blog-redditi-varesotti-2024-luvinate': { name: 'Redditi Varese', path: '/articoli-frontaliere/redditi-varesotti-2024-luvinate', parent: 'blog' },
    'blog-chiusure-autostrade-ticino-2026': { name: 'Chiusure autostrade', path: '/articoli-frontaliere/chiusure-autostrade-ticino-2026', parent: 'blog' },
    'blog-accordo-navigazione-costanza-2026': { name: 'Novità', path: '/articoli-frontaliere/accordo-navigazione-costanza-2026', parent: 'blog' },
    'blog-comunita-energetica-rinnovabile-luinese-400-kw': { name: 'Novità', path: '/articoli-frontaliere/comunita-energetica-rinnovabile-luinese-400-kw', parent: 'blog' },
    'blog-chiusura-notturna-a8-gallarate-29-aprile-2026': { name: 'Chiusura notturna', path: '/articoli-frontaliere/chiusura-notturna-a8-gallarate-29-aprile-2026', parent: 'blog' },
    'blog-sovranita-latte-ticino': { name: 'Sovranità alimentare e latte ticinese', path: '/articoli-frontaliere/sovranita-latte-ticino', parent: 'blog' },
    'blog-chiasso-scoperta-enti-primo-intervento': { name: 'Chiasso', path: '/articoli-frontaliere/chiasso-scoperta-enti-primo-intervento', parent: 'blog' },
    'blog-tennis-donne-open-di-chiasso-a-marija-glebovna-timofeeva-il-titolo': { name: 'Tennis donne / “Open” di Chiasso, a Marija', path: '/articoli-frontaliere/tennis-donne-open-di-chiasso-a-marija-glebovna-timofeeva-il-titolo', parent: 'blog' },
    'blog-foreste-sommerse-lago-como-lugano': { name: 'Novità', path: '/articoli-frontaliere/foreste-sommerse-lago-como-lugano', parent: 'blog' },
    'blog-grigioni-viabilita-olimpica-2026': { name: 'Viabilità olimpica', path: '/articoli-frontaliere/grigioni-viabilita-olimpica-2026', parent: 'blog' },
    'blog-mobilita-sostenibile-citta-vivibili-2026': { name: 'Mobilità sostenibile', path: '/articoli-frontaliere/mobilita-sostenibile-citta-vivibili-2026', parent: 'blog' },
    'blog-relazioni-italo-svizzere-2026': { name: 'Relazioni italo-svizzere', path: '/articoli-frontaliere/relazioni-italo-svizzere-2026', parent: 'blog' },
    'blog-integrazione-inclusione-ticino-2026': { name: 'Integrazione e inclusione', path: '/articoli-frontaliere/integrazione-inclusione-ticino-2026', parent: 'blog' },
    'blog-reddito-como-2024-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/reddito-como-2024-frontalieri', parent: 'blog' },
    'blog-st-moritz-case-accessibili-2026': { name: 'Novità', path: '/articoli-frontaliere/st-moritz-case-accessibili-2026', parent: 'blog' },
    'blog-ex-gas-macello-residenze-secondarie': { name: 'Novità', path: '/articoli-frontaliere/ex-gas-macello-residenze-secondarie', parent: 'blog' },
    'blog-contratto-lago-lands-lake-2026': { name: 'Contratto di Lago', path: '/articoli-frontaliere/contratto-lago-lands-lake-2026', parent: 'blog' },
    'blog-controlli-velocita-ticino-aprile-maggio': { name: 'Controlli velocità', path: '/articoli-frontaliere/controlli-velocita-ticino-aprile-maggio', parent: 'blog' },
    'blog-finanze-pubbliche-ticino-2026-preoccupazioni': { name: 'Finanze pubbliche', path: '/articoli-frontaliere/finanze-pubbliche-ticino-2026-preoccupazioni', parent: 'blog' },
    'blog-premi-non-oltre-10-percento': { name: 'Fiscale', path: '/articoli-frontaliere/premi-non-oltre-10-percento', parent: 'blog' },
    'blog-guerra-iran-industria-alimentare-svizzera': { name: 'Novità', path: '/articoli-frontaliere/guerra-iran-industria-alimentare-svizzera', parent: 'blog' },
    'blog-bollini-rossi-traffico-san-gottardo-2026': { name: 'Traffico San Gottardo', path: '/articoli-frontaliere/bollini-rossi-traffico-san-gottardo-2026', parent: 'blog' },
    'blog-treno-guasto-bellinzona-2026': { name: 'Novità', path: '/articoli-frontaliere/treno-guasto-bellinzona-2026', parent: 'blog' },
    'blog-elezioni-como-frontalieri-2026': { name: 'Elezioni Como', path: '/articoli-frontaliere/elezioni-como-frontalieri-2026', parent: 'blog' },
    'blog-teatro-architettura-mendrisio-stagione-2026': { name: 'Cultura', path: '/articoli-frontaliere/teatro-architettura-mendrisio-stagione-2026', parent: 'blog' },
    'blog-frontalieri-arresto-maggia-truffa': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-arresto-maggia-truffa', parent: 'blog' },
    'blog-study-china-ticino-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/study-china-ticino-frontalieri', parent: 'blog' },
    'blog-treno-senza-biglietto-frontalieri-ticino': { name: 'Novità', path: '/articoli-frontaliere/treno-senza-biglietto-frontalieri-ticino', parent: 'blog' },
    'blog-polizia-stradale-varese-1600-patenti': { name: 'Novità', path: '/articoli-frontaliere/polizia-stradale-varese-1600-patenti', parent: 'blog' },
    'blog-agricoltori-varesini-sfide-burocrazia': { name: 'Novità', path: '/articoli-frontaliere/agricoltori-varesini-sfide-burocrazia', parent: 'blog' },
    'blog-nuove-banconote-euro-restyling-2026': { name: 'Novità', path: '/articoli-frontaliere/nuove-banconote-euro-restyling-2026', parent: 'blog' },
    'blog-amazon-made-in-italy-days-2026-ticino': { name: 'Amazon Made in Italy Days', path: '/articoli-frontaliere/amazon-made-in-italy-days-2026-ticino', parent: 'blog' },
    'blog-carburanti-ticino-confronto-2024': { name: 'Caro-carburanti', path: '/articoli-frontaliere/carburanti-ticino-confronto-2024', parent: 'blog' },
    'blog-nuovo-contratto-edilizia-ticino-2026-2031': { name: 'Nuovo CCL-Ti', path: '/articoli-frontaliere/nuovo-contratto-edilizia-ticino-2026-2031', parent: 'blog' },
    'blog-primo-maggio-varese-2026-lavoro-dignitoso': { name: 'Primo Maggio Varese', path: '/articoli-frontaliere/primo-maggio-varese-2026-lavoro-dignitoso', parent: 'blog' },
    'blog-fallimenti-fotovoltaico-clienti-ticino': { name: 'Novità', path: '/articoli-frontaliere/fallimenti-fotovoltaico-clienti-ticino', parent: 'blog' },
    'blog-coop-svizzera-insetti-commestibili-2026': { name: 'Novità', path: '/articoli-frontaliere/coop-svizzera-insetti-commestibili-2026', parent: 'blog' },
    'blog-controlli-frontalieri-airolo-2026': { name: 'Novità', path: '/articoli-frontaliere/controlli-frontalieri-airolo-2026', parent: 'blog' },
    'blog-fallimenti-startup-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/fallimenti-startup-svizzera-2026', parent: 'blog' },
    'blog-limite-velocita-30-ticino-inquinamento-acustico': { name: 'Novità', path: '/articoli-frontaliere/limite-velocita-30-ticino-inquinamento-acustico', parent: 'blog' },
    'blog-varese-parcheggi-ospedale-sette-laghi-2026': { name: 'Varese Parcheggi', path: '/articoli-frontaliere/varese-parcheggi-ospedale-sette-laghi-2026', parent: 'blog' },
    'blog-zecche-ticino-2026-18000-punture': { name: 'Zecche Ticino', path: '/articoli-frontaliere/zecche-ticino-2026-18000-punture', parent: 'blog' },
    'blog-lavoratori-pensionati-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/lavoratori-pensionati-ticino-2026', parent: 'blog' },
    'blog-calcio-dnb-bellinzona-vittoria-stade-nyonnais': { name: 'Calcio Dnb', path: '/articoli-frontaliere/calcio-dnb-bellinzona-vittoria-stade-nyonnais', parent: 'blog' },
    'blog-svizzera-indipendenza-energetica-importazioni-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzera-indipendenza-energetica-importazioni-2026', parent: 'blog' },
    'blog-nuove-misure-violenza-domestica-svizzera': { name: 'Novità', path: '/articoli-frontaliere/nuove-misure-violenza-domestica-svizzera', parent: 'blog' },
    'blog-ruag-ia-svizzera-difesa-2026': { name: 'Novità', path: '/articoli-frontaliere/ruag-ia-svizzera-difesa-2026', parent: 'blog' },
    'blog-nuove-leggi-violenza-domestica-2027': { name: 'Novità', path: '/articoli-frontaliere/nuove-leggi-violenza-domestica-2027', parent: 'blog' },
    'blog-regione-lombardia-casa-popolari-6-4-milioni': { name: 'Case popolari', path: '/articoli-frontaliere/regione-lombardia-casa-popolari-6-4-milioni', parent: 'blog' },
    'blog-prevenzione-violenza-domestica-san-gallo-2026': { name: 'Prevenzione violenza', path: '/articoli-frontaliere/prevenzione-violenza-domestica-san-gallo-2026', parent: 'blog' },
    'blog-zurigo-economia-svizzera-crescita-media-2026': { name: 'Economia Svizzera', path: '/articoli-frontaliere/zurigo-economia-svizzera-crescita-media-2026', parent: 'blog' },
    'blog-swisscom-minacce-cyber-2026': { name: 'Novità', path: '/articoli-frontaliere/swisscom-minacce-cyber-2026', parent: 'blog' },
    'blog-svizzera-istruzioni-uso-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzera-istruzioni-uso-2026', parent: 'blog' },
    'blog-reparto-securizzato-pasture-consenso-cantone-comuni': { name: 'Novità', path: '/articoli-frontaliere/reparto-securizzato-pasture-consenso-cantone-comuni', parent: 'blog' },
    'blog-nuovo-ccnl-edilizia-ticino-2026-2031': { name: 'Nuovo CCL', path: '/articoli-frontaliere/nuovo-ccnl-edilizia-ticino-2026-2031', parent: 'blog' },
    'blog-morcote-eventi-2026-scalinata-caccia-tesoro': { name: 'Eventi Ticino', path: '/articoli-frontaliere/morcote-eventi-2026-scalinata-caccia-tesoro', parent: 'blog' },
    'blog-svizzera-credito-energetico-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzera-credito-energetico-2026', parent: 'blog' },
    'blog-oftalmologi-svizzeri-messico-vista': { name: 'Novità', path: '/articoli-frontaliere/oftalmologi-svizzeri-messico-vista', parent: 'blog' },
    'blog-rumore-traffico-svizzera-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/rumore-traffico-svizzera-frontalieri', parent: 'blog' },
    'blog-bandiera-svizzera-scarpe-on-controversia': { name: 'Controversia bandiera svizzera', path: '/articoli-frontaliere/bandiera-svizzera-scarpe-on-controversia', parent: 'blog' },
    'blog-incontro-solidarieta-sicurezza-bioggio': { name: 'Incontro solidarietà sicurezza', path: '/articoli-frontaliere/incontro-solidarieta-sicurezza-bioggio', parent: 'blog' },
    'blog-infermieri-ticino-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/infermieri-ticino-frontalieri-2026', parent: 'blog' },
    'blog-deepfake-legge-svizzera-2026': { name: 'Deepfake pornografici', path: '/articoli-frontaliere/deepfake-legge-svizzera-2026', parent: 'blog' },
    'blog-ticinesi-missione-ucraina-2026': { name: 'Missioni umanitarie', path: '/articoli-frontaliere/ticinesi-missione-ucraina-2026', parent: 'blog' },
    'blog-frontalieri-massagno-salario-scandaloso': { name: 'Frontalieri e lavoro', path: '/articoli-frontaliere/frontalieri-massagno-salario-scandaloso', parent: 'blog' },
    'blog-cure-infermieristiche-190mila-firme-2026': { name: 'Cure infermieristiche', path: '/articoli-frontaliere/cure-infermieristiche-190mila-firme-2026', parent: 'blog' },
    'blog-maxi-spiegamento-fiamme-gialle-comasco-2026': { name: 'Novità', path: '/articoli-frontaliere/maxi-spiegamento-fiamme-gialle-comasco-2026', parent: 'blog' },
    'blog-riforma-medici-famiglia-sumai-organizzazione': { name: 'Riforma medici', path: '/articoli-frontaliere/riforma-medici-famiglia-sumai-organizzazione', parent: 'blog' },
    'blog-lavoratori-pensionati-ticino-2026-2046': { name: 'Novità', path: '/articoli-frontaliere/lavoratori-pensionati-ticino-2026-2046', parent: 'blog' },
    'blog-universita-varese-intelligenza-artificiale-2026': { name: 'Novità', path: '/articoli-frontaliere/universita-varese-intelligenza-artificiale-2026', parent: 'blog' },
    'blog-visite-gratuite-prevenzione-tumore-seno-gallarate-lilt': { name: 'Novità', path: '/articoli-frontaliere/visite-gratuite-prevenzione-tumore-seno-gallarate-lilt', parent: 'blog' },
    'blog-frontalieri-mozione-sirica-ticino-2024': { name: 'Mozione Sirica', path: '/articoli-frontaliere/frontalieri-mozione-sirica-ticino-2024', parent: 'blog' },
    'blog-corsi-gratuiti-varese-sociale-2026': { name: 'Corsi gratuiti', path: '/articoli-frontaliere/corsi-gratuiti-varese-sociale-2026', parent: 'blog' },
    'blog-solaro-rifiuti-differenziata-tariffazione-puntuale': { name: 'Incontri Solaro', path: '/articoli-frontaliere/solaro-rifiuti-differenziata-tariffazione-puntuale', parent: 'blog' },
    'blog-svizzera-disoccupazione-frontalieri-quadri': { name: 'Novità', path: '/articoli-frontaliere/svizzera-disoccupazione-frontalieri-quadri', parent: 'blog' },
    'blog-corteo-maggio-lugano-traffico-2024': { name: '1° maggio Lugano', path: '/articoli-frontaliere/corteo-maggio-lugano-traffico-2024', parent: 'blog' },
    'blog-incidenti-mortali-lavoro-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/incidenti-mortali-lavoro-svizzera-2026', parent: 'blog' },
    'blog-coldiretti-brennero-made-italy-2026': { name: 'Novità', path: '/articoli-frontaliere/coldiretti-brennero-made-italy-2026', parent: 'blog' },
    'blog-ticino-tedeschi-turismo-2026': { name: 'Novità', path: '/articoli-frontaliere/ticino-tedeschi-turismo-2026', parent: 'blog' },
    'blog-universita-ticino-tagli-contributi-2026': { name: 'Tagli USI 2026', path: '/articoli-frontaliere/universita-ticino-tagli-contributi-2026', parent: 'blog' },
    'blog-chiasso-arresti-furto-biciclette-2026': { name: 'Novità', path: '/articoli-frontaliere/chiasso-arresti-furto-biciclette-2026', parent: 'blog' },
    'blog-sicurezza-lavoro-ats-insubria-2026': { name: 'Novità', path: '/articoli-frontaliere/sicurezza-lavoro-ats-insubria-2026', parent: 'blog' },
    'blog-furto-biciclette-giubiasco-2026': { name: 'Furto biciclette Giubiasco', path: '/articoli-frontaliere/furto-biciclette-giubiasco-2026', parent: 'blog' },
    'blog-osservatori-traffico-lago-como-2026': { name: 'Novità', path: '/articoli-frontaliere/osservatori-traffico-lago-como-2026', parent: 'blog' },
    'blog-sicurezza-lavoro-ats-insubria-varese-como-2026': { name: 'Sicurezza lavoro', path: '/articoli-frontaliere/sicurezza-lavoro-ats-insubria-varese-como-2026', parent: 'blog' },
    'blog-furto-biciclette-benzina-chiasso-2026': { name: 'Furti Chiasso', path: '/articoli-frontaliere/furto-biciclette-benzina-chiasso-2026', parent: 'blog' },
    'blog-bando-formazione-professionale-plr-2026': { name: 'Bando Formazione', path: '/articoli-frontaliere/bando-formazione-professionale-plr-2026', parent: 'blog' },
    'blog-lavoratori-pensionati-svizzera-2026': { name: 'Lavoratori pensionati', path: '/articoli-frontaliere/lavoratori-pensionati-svizzera-2026', parent: 'blog' },
    'blog-met-svizzera-insoddisfatta-sistema-2026': { name: 'Novità', path: '/articoli-frontaliere/met-svizzera-insoddisfatta-sistema-2026', parent: 'blog' },
    'blog-nuovi-esperti-gestione-energia-varese': { name: 'Novità', path: '/articoli-frontaliere/nuovi-esperti-gestione-energia-varese', parent: 'blog' },
    'blog-negoziati-falliti-stretto-hormuz-2026': { name: 'Novità', path: '/articoli-frontaliere/negoziati-falliti-stretto-hormuz-2026', parent: 'blog' },
    'blog-roadmap-violenza-domestica-bilancio-positivo': { name: 'Novità', path: '/articoli-frontaliere/roadmap-violenza-domestica-bilancio-positivo', parent: 'blog' },
    'blog-benessere-integrita-allievi-bellinzona-2026': { name: 'Novità', path: '/articoli-frontaliere/benessere-integrita-allievi-bellinzona-2026', parent: 'blog' },
    'blog-cosa-significa-made-switzerland': { name: 'Novità', path: '/articoli-frontaliere/cosa-significa-made-switzerland', parent: 'blog' },
    'blog-equans-licenziamenti-monteceneri-19-dipendenti': { name: 'Equans licenziamenti', path: '/articoli-frontaliere/equans-licenziamenti-monteceneri-19-dipendenti', parent: 'blog' },
    'blog-verdi-ticino-cantonali-2026': { name: 'Novità', path: '/articoli-frontaliere/verdi-ticino-cantonali-2026', parent: 'blog' },
    'blog-borse-studio-bracco-lombardia-2026': { name: 'Borse di studio', path: '/articoli-frontaliere/borse-studio-bracco-lombardia-2026', parent: 'blog' },
    'blog-sportello-me-te-cunardo-marchirolo-2026': { name: 'Sportello ME-TE', path: '/articoli-frontaliere/sportello-me-te-cunardo-marchirolo-2026', parent: 'blog' },
    'blog-accordo-edilizia-ticino-2026-2031': { name: 'Novità', path: '/articoli-frontaliere/accordo-edilizia-ticino-2026-2031', parent: 'blog' },
    'blog-equans-rivera-19-licenziamenti': { name: 'Novità', path: '/articoli-frontaliere/equans-rivera-19-licenziamenti', parent: 'blog' },
    'blog-controlli-finanza-comasco-226-persone': { name: 'Controlli Finanza', path: '/articoli-frontaliere/controlli-finanza-comasco-226-persone', parent: 'blog' },
    'blog-auto-cinesi-svizzera-2026': { name: 'Auto cinesi', path: '/articoli-frontaliere/auto-cinesi-svizzera-2026', parent: 'blog' },
    'blog-dengue-sistema-rapido-individuazione': { name: 'Novità', path: '/articoli-frontaliere/dengue-sistema-rapido-individuazione', parent: 'blog' },
    'blog-aprile-secco-siccita-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/aprile-secco-siccita-ticino-2026', parent: 'blog' },
    'blog-multa-svapo-stazioni-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/multa-svapo-stazioni-ticino-2026', parent: 'blog' },
    'blog-svizzera-disoccupazione-frontalieri-quadri-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzera-disoccupazione-frontalieri-quadri-2026', parent: 'blog' },
    'blog-allerta-gialla-temporali-varese-2026': { name: 'Allerta meteo', path: '/articoli-frontaliere/allerta-gialla-temporali-varese-2026', parent: 'blog' },
    'blog-ostetriche-eoc-mendrisio-2026': { name: 'Conferenza ostetriche', path: '/articoli-frontaliere/ostetriche-eoc-mendrisio-2026', parent: 'blog' },
    'blog-modello-zurigo-violenza-domestica': { name: 'Novità', path: '/articoli-frontaliere/modello-zurigo-violenza-domestica', parent: 'blog' },
    'blog-sepolti-con-animali-domestici-berna-2026': { name: 'Novità', path: '/articoli-frontaliere/sepolti-con-animali-domestici-berna-2026', parent: 'blog' },
    'blog-swiss-guasti-voli-frontalieri-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/swiss-guasti-voli-frontalieri-ticino-2026', parent: 'blog' },
    'blog-banca-ditalia-varese-10-anni-dopo': { name: 'Banca d\'Italia Varese', path: '/articoli-frontaliere/banca-ditalia-varese-10-anni-dopo', parent: 'blog' },
    'blog-svizzeri-contributo-clima-acquisti-online-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzeri-contributo-clima-acquisti-online-2026', parent: 'blog' },
    'blog-passeggiata-lago-inverno-ascona-2026': { name: 'Novità', path: '/articoli-frontaliere/passeggiata-lago-inverno-ascona-2026', parent: 'blog' },
    'blog-notifiche-frontalieri-ticino-2026': { name: 'Notifiche frontalieri', path: '/articoli-frontaliere/notifiche-frontalieri-ticino-2026', parent: 'blog' },
    'blog-minacce-informatiche-svizzera-2026': { name: 'Minacce informatiche', path: '/articoli-frontaliere/minacce-informatiche-svizzera-2026', parent: 'blog' },
    'blog-gamberetti-torneo-madrid-2026': { name: 'Novità', path: '/articoli-frontaliere/gamberetti-torneo-madrid-2026', parent: 'blog' },
    'blog-carburanti-tpl-ticino-2026': { name: 'Trasporto pubblico', path: '/articoli-frontaliere/carburanti-tpl-ticino-2026', parent: 'blog' },
    'blog-scoperta-africa-materia-castronno-2026': { name: 'Eventi Culturali', path: '/articoli-frontaliere/scoperta-africa-materia-castronno-2026', parent: 'blog' },
    'blog-universita-ticino-numero-chiuso-2026': { name: 'Novità', path: '/articoli-frontaliere/universita-ticino-numero-chiuso-2026', parent: 'blog' },
    'blog-pedaggi-autostrada-lombardia-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/pedaggi-autostrada-lombardia-frontalieri', parent: 'blog' },
    'blog-semaforo-paradiso-melide-2026': { name: 'Semaforo Melide', path: '/articoli-frontaliere/semaforo-paradiso-melide-2026', parent: 'blog' },
    'blog-zurigo-economia-svizzera-crescita': { name: 'Economia Svizzera', path: '/articoli-frontaliere/zurigo-economia-svizzera-crescita', parent: 'blog' },
    'blog-frontalieri-trottinetti-velocita-polizia': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-trottinetti-velocita-polizia', parent: 'blog' },
    'blog-ats-insubria-soluzioni-ospedali-2026': { name: 'Novità sanitarie', path: '/articoli-frontaliere/ats-insubria-soluzioni-ospedali-2026', parent: 'blog' },
    'blog-avis-lombardia-dono-sangue-privati-2026': { name: 'Novità', path: '/articoli-frontaliere/avis-lombardia-dono-sangue-privati-2026', parent: 'blog' },
    'blog-varese-moto-storiche-2026': { name: 'Raduno moto storiche', path: '/articoli-frontaliere/varese-moto-storiche-2026', parent: 'blog' },
    'blog-nuovo-contratto-edilizia-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/nuovo-contratto-edilizia-ticino-2026', parent: 'blog' },
    'blog-viabilita-varese-racordo-chiuso-2026': { name: 'Viabilità', path: '/articoli-frontaliere/viabilita-varese-racordo-chiuso-2026', parent: 'blog' },
    'blog-furti-biciclette-mendrisiotto-2026': { name: 'Novità', path: '/articoli-frontaliere/furti-biciclette-mendrisiotto-2026', parent: 'blog' },
    'blog-per-giumai-acquisti-monte-piaroi-2026': { name: 'Novità', path: '/articoli-frontaliere/per-giumai-acquisti-monte-piaroi-2026', parent: 'blog' },
    'blog-rovine-magliaso-scuole-nuove-2026': { name: 'Novità', path: '/articoli-frontaliere/rovine-magliaso-scuole-nuove-2026', parent: 'blog' },
    'blog-bns-ubs-misure-non-estreme-2026': { name: 'Novità', path: '/articoli-frontaliere/bns-ubs-misure-non-estreme-2026', parent: 'blog' },
    'blog-nuovi-maestri-lavoro-varese-leonardo-2026': { name: 'Nuovi Maestri del Lavoro', path: '/articoli-frontaliere/nuovi-maestri-lavoro-varese-leonardo-2026', parent: 'blog' },
    'blog-cambio-guardia-pro-velo-ticino-sabbadini-vitali': { name: 'Novità', path: '/articoli-frontaliere/cambio-guardia-pro-velo-ticino-sabbadini-vitali', parent: 'blog' },
    'blog-nuovo-ambulatorio-ecocardiografia-busto-arsizio': { name: 'Novità sanità', path: '/articoli-frontaliere/nuovo-ambulatorio-ecocardiografia-busto-arsizio', parent: 'blog' },
    'blog-velafrica-bici-usate-lugano-2026': { name: 'Novità', path: '/articoli-frontaliere/velafrica-bici-usate-lugano-2026', parent: 'blog' },
    'blog-ospedale-varese-acqua-calda-oncologia': { name: 'Ospedale Varese', path: '/articoli-frontaliere/ospedale-varese-acqua-calda-oncologia', parent: 'blog' },
    'blog-cinque-nordafricani-festnati-auto-aarau': { name: 'Notizie', path: '/articoli-frontaliere/cinque-nordafricani-festnati-auto-aarau', parent: 'blog' },
    'blog-doppio-sequestro-discariche-abusive-varese': { name: 'Novità', path: '/articoli-frontaliere/doppio-sequestro-discariche-abusive-varese', parent: 'blog' },
    'blog-sfida-comuni-coop-2026-attivita-fisica': { name: 'Novità', path: '/articoli-frontaliere/sfida-comuni-coop-2026-attivita-fisica', parent: 'blog' },
    'blog-cina-tutela-lavoratori-nuove-occupazioni': { name: 'Novità', path: '/articoli-frontaliere/cina-tutela-lavoratori-nuove-occupazioni', parent: 'blog' },
    'blog-usi-ticino-tagli-bilancio-2026': { name: 'USI Tagli', path: '/articoli-frontaliere/usi-ticino-tagli-bilancio-2026', parent: 'blog' },
    'blog-campione-ditalia-elezioni-sindaco-2026': { name: 'Elezioni Campione d’Italia', path: '/articoli-frontaliere/campione-ditalia-elezioni-sindaco-2026', parent: 'blog' },
    'blog-gioventu-dibatte-500-studenti-gara': { name: 'Novità', path: '/articoli-frontaliere/gioventu-dibatte-500-studenti-gara', parent: 'blog' },
    'blog-tallero-doro-80-anni-nuovo-design': { name: 'Novità', path: '/articoli-frontaliere/tallero-doro-80-anni-nuovo-design', parent: 'blog' },
    'blog-conservatorio-bellinzona-valori-musicali': { name: 'Novità', path: '/articoli-frontaliere/conservatorio-bellinzona-valori-musicali', parent: 'blog' },
    'blog-national-geographic-scuola-einaudi-varese': { name: 'National Geographic a scuola', path: '/articoli-frontaliere/national-geographic-scuola-einaudi-varese', parent: 'blog' },
    'blog-benessere-scolastico-bellinzona-2026': { name: 'Benessere scolastico', path: '/articoli-frontaliere/benessere-scolastico-bellinzona-2026', parent: 'blog' },
    'blog-mendrisio-capitale-culturale-opportunita': { name: 'Mendrisio Capitale Culturale', path: '/articoli-frontaliere/mendrisio-capitale-culturale-opportunita', parent: 'blog' },
    'blog-pro-velo-ticino-cambiamento-presidenza-2026': { name: 'Novità', path: '/articoli-frontaliere/pro-velo-ticino-cambiamento-presidenza-2026', parent: 'blog' },
    'blog-nomine-sims-fallimento': { name: 'Nomine SIMS', path: '/articoli-frontaliere/nomine-sims-fallimento', parent: 'blog' },
    'blog-crans-montana-fatture-scontro-roma-2026': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-fatture-scontro-roma-2026', parent: 'blog' },
    'blog-ticino-calimero-sindrome-2026': { name: 'Novità', path: '/articoli-frontaliere/ticino-calimero-sindrome-2026', parent: 'blog' },
    'blog-salario-minimo-mediano-ticino-2026': { name: 'Salari Ticino', path: '/articoli-frontaliere/salario-minimo-mediano-ticino-2026', parent: 'blog' },
    'blog-padroncini-lavoratori-stabili-bassi-2025': { name: 'Novità', path: '/articoli-frontaliere/padroncini-lavoratori-stabili-bassi-2025', parent: 'blog' },
    'blog-bcc-busto-garolfo-2-milioni-territorio': { name: 'Novità', path: '/articoli-frontaliere/bcc-busto-garolfo-2-milioni-territorio', parent: 'blog' },
    'blog-nuova-legge-polizia-ticino-controllo-periodico': { name: 'Novità', path: '/articoli-frontaliere/nuova-legge-polizia-ticino-controllo-periodico', parent: 'blog' },
    'blog-malpensa-parigi-galline-frontalieri': { name: 'Pratico', path: '/articoli-frontaliere/malpensa-parigi-galline-frontalieri', parent: 'blog' },
    'blog-borsa-zurigo-frontalieri-27-aprile-2026': { name: 'Borsa Zurigo', path: '/articoli-frontaliere/borsa-zurigo-frontalieri-27-aprile-2026', parent: 'blog' },
    'blog-colpi-arma-da-fuoco-como-ferito-frontaliere': { name: 'Incidente Como', path: '/articoli-frontaliere/colpi-arma-da-fuoco-como-ferito-frontaliere', parent: 'blog' },
    'blog-disagi-trenord-tilo-s40-25-aprile-2024': { name: 'Disagi linea TiLo S40', path: '/articoli-frontaliere/disagi-trenord-tilo-s40-25-aprile-2024', parent: 'blog' },
    'blog-scommesse-guerra-trump-prediction-market': { name: 'Novità', path: '/articoli-frontaliere/scommesse-guerra-trump-prediction-market', parent: 'blog' },
    'blog-furti-lusso-murten-2026': { name: 'Furti Ticino', path: '/articoli-frontaliere/furti-lusso-murten-2026', parent: 'blog' },
    'blog-gestione-illecita-rifiuti-varese-arcisate-2026': { name: 'Pratico', path: '/articoli-frontaliere/gestione-illecita-rifiuti-varese-arcisate-2026', parent: 'blog' },
    'blog-frontalieri-ticino-crescita-2026': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/frontalieri-ticino-crescita-2026', parent: 'blog' },
    'blog-trasparenza-iniziative-popolari-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/trasparenza-iniziative-popolari-ticino-2026', parent: 'blog' },
    'blog-tristan-brenn-fischer-decisione': { name: 'Novità', path: '/articoli-frontaliere/tristan-brenn-fischer-decisione', parent: 'blog' },
    'blog-svizzera-brevetti-innovazione-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzera-brevetti-innovazione-2026', parent: 'blog' },
    'blog-frontalieri-rega-boglia-intervento': { name: 'Intervento Rega', path: '/articoli-frontaliere/frontalieri-rega-boglia-intervento', parent: 'blog' },
    'blog-equans-licenziamenti-monteceneri-2026': { name: 'Novità', path: '/articoli-frontaliere/equans-licenziamenti-monteceneri-2026', parent: 'blog' },
    'blog-momenti-paura-velivolo-swiss-2026': { name: 'Incidente aereo', path: '/articoli-frontaliere/momenti-paura-velivolo-swiss-2026', parent: 'blog' },
    'blog-allerta-meteo-ticino-lombardia-2026': { name: 'Allerta meteo', path: '/articoli-frontaliere/allerta-meteo-ticino-lombardia-2026', parent: 'blog' },
    'blog-rottamazione-quinquies-scadenza-30-aprile': { name: 'Rottamazione-quinquies', path: '/articoli-frontaliere/rottamazione-quinquies-scadenza-30-aprile', parent: 'blog' },
    'blog-architettura-sostenibile-ticino-2026': { name: 'Architettura sostenibile', path: '/articoli-frontaliere/architettura-sostenibile-ticino-2026', parent: 'blog' },
    'blog-sisa-contro-tagli-governo-2024': { name: 'Novità', path: '/articoli-frontaliere/sisa-contro-tagli-governo-2024', parent: 'blog' },
    'blog-pista-ciclopedonale-bodio-giornico-2026': { name: 'Novità', path: '/articoli-frontaliere/pista-ciclopedonale-bodio-giornico-2026', parent: 'blog' },
    'blog-momoride-carpooling-benefico-ticino-2026': { name: 'MomòRide', path: '/articoli-frontaliere/momoride-carpooling-benefico-ticino-2026', parent: 'blog' },
    'blog-kit-escursionisti-montagna-pulita': { name: 'Kit escursionisti', path: '/articoli-frontaliere/kit-escursionisti-montagna-pulita', parent: 'blog' },
    'blog-moda-sostenibile-bellinzona-9-maggio': { name: 'Moda sostenibile', path: '/articoli-frontaliere/moda-sostenibile-bellinzona-9-maggio', parent: 'blog' },
    'blog-fuga-ammoniaca-chiasso-controllo': { name: 'Novità', path: '/articoli-frontaliere/fuga-ammoniaca-chiasso-controllo', parent: 'blog' },
    'blog-chiasso-ammoniaca-stadio-ghiaccio': { name: 'Novità', path: '/articoli-frontaliere/chiasso-ammoniaca-stadio-ghiaccio', parent: 'blog' },
    'blog-fuga-ammoniaca-chiasso-pista-ghiaccio': { name: 'Novità', path: '/articoli-frontaliere/fuga-ammoniaca-chiasso-pista-ghiaccio', parent: 'blog' },
    'blog-biglietto-trenord-whatsapp-ticino': { name: 'Biglietti Trenord', path: '/articoli-frontaliere/biglietto-trenord-whatsapp-ticino', parent: 'blog' },
    'blog-tassa-aerei-sostegno-treni': { name: 'Novità', path: '/articoli-frontaliere/tassa-aerei-sostegno-treni', parent: 'blog' },
    'blog-comune-como-appuntamenti-cie-2026': { name: 'Novità', path: '/articoli-frontaliere/comune-como-appuntamenti-cie-2026', parent: 'blog' },
    'blog-auto-elettriche-ricarica-breganzona': { name: 'Auto elettriche', path: '/articoli-frontaliere/auto-elettriche-ricarica-breganzona', parent: 'blog' },
    'blog-universita-insubria-4-4-milioni-ricerca': { name: 'Novità', path: '/articoli-frontaliere/universita-insubria-4-4-milioni-ricerca', parent: 'blog' },
    'blog-airpack-lombardia-41-lavoratori': { name: 'Novità', path: '/articoli-frontaliere/airpack-lombardia-41-lavoratori', parent: 'blog' },
    'blog-tassa-aerei-trasporto-pubblico': { name: 'Iniziativa tassa aerei', path: '/articoli-frontaliere/tassa-aerei-trasporto-pubblico', parent: 'blog' },
    'blog-settimanaprofessionale-ticino-2024': { name: 'Novità', path: '/articoli-frontaliere/settimanaprofessionale-ticino-2024', parent: 'blog' },
    'blog-colazione-equo-ticino-9-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/colazione-equo-ticino-9-maggio-2026', parent: 'blog' },
    'blog-costo-energia-varese-impatti-frontalieri': { name: 'Caro energia', path: '/articoli-frontaliere/costo-energia-varese-impatti-frontalieri', parent: 'blog' },
    'blog-ospedali-varesini-cambiamenti-20-anni': { name: 'Novità', path: '/articoli-frontaliere/ospedali-varesini-cambiamenti-20-anni', parent: 'blog' },
    'blog-sunrise-integra-hbb-ssr-2026': { name: 'Novità', path: '/articoli-frontaliere/sunrise-integra-hbb-ssr-2026', parent: 'blog' },
    'blog-infermieri-lavoro-ore-settimanali': { name: 'Novità', path: '/articoli-frontaliere/infermieri-lavoro-ore-settimanali', parent: 'blog' },
    'blog-sorveglianza-telecomunicazioni-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/sorveglianza-telecomunicazioni-ticino-2026', parent: 'blog' },
    'blog-spese-bancarie-titoli-frontalieri': { name: 'Spese bancarie titoli', path: '/articoli-frontaliere/spese-bancarie-titoli-frontalieri', parent: 'blog' },
    'blog-bicicletta-insubria-varese-2026': { name: 'Pendolarismo sostenibile', path: '/articoli-frontaliere/bicicletta-insubria-varese-2026', parent: 'blog' },
    'blog-montessori-green-food-week-2026': { name: 'Novità', path: '/articoli-frontaliere/montessori-green-food-week-2026', parent: 'blog' },
    'blog-passi-solidarieta-porto-ceresio-2026': { name: 'Novità', path: '/articoli-frontaliere/passi-solidarieta-porto-ceresio-2026', parent: 'blog' },
    'blog-processo-karimova-archiviazione-parziale': { name: 'Processo Karimova', path: '/articoli-frontaliere/processo-karimova-archiviazione-parziale', parent: 'blog' },
    'blog-cardiocentro-lugano-ristrutturazione-2026': { name: 'Cardiocentro Lugano', path: '/articoli-frontaliere/cardiocentro-lugano-ristrutturazione-2026', parent: 'blog' },
    'blog-ex-capo-esercito-kaiser-partner-privatbank': { name: 'Novità', path: '/articoli-frontaliere/ex-capo-esercito-kaiser-partner-privatbank', parent: 'blog' },
    'blog-nuove-regole-centri-estivi-saronno-2026': { name: 'Novità', path: '/articoli-frontaliere/nuove-regole-centri-estivi-saronno-2026', parent: 'blog' },
    'blog-ex-sede-banca-ditalia-vendita-varese': { name: 'Novità', path: '/articoli-frontaliere/ex-sede-banca-ditalia-vendita-varese', parent: 'blog' },
    'blog-139-frontalieri-ticino-special-olympics': { name: 'Special Olympics', path: '/articoli-frontaliere/139-frontalieri-ticino-special-olympics', parent: 'blog' },
    'blog-gastrobellinzona-andrea-giuliani': { name: 'Novità', path: '/articoli-frontaliere/gastrobellinzona-andrea-giuliani', parent: 'blog' },
    'blog-infermieri-ticino-ore-lavorative-2026': { name: 'Novità', path: '/articoli-frontaliere/infermieri-ticino-ore-lavorative-2026', parent: 'blog' },
    'blog-dezonare-terreni-blenio-2026': { name: 'Novità', path: '/articoli-frontaliere/dezonare-terreni-blenio-2026', parent: 'blog' },
    'blog-dfp-bankitalia-margini-debito-ue-2026': { name: 'Fiscale', path: '/articoli-frontaliere/dfp-bankitalia-margini-debito-ue-2026', parent: 'blog' },
    'blog-momoride-carpooling-benefico-ticino-2024': { name: 'MomòRide', path: '/articoli-frontaliere/momoride-carpooling-benefico-ticino-2024', parent: 'blog' },
    'blog-borse-zurigo-flessione-2026': { name: 'Borse europee', path: '/articoli-frontaliere/borse-zurigo-flessione-2026', parent: 'blog' },
    'blog-traffico-droga-arresti-svizzera-estero-2026': { name: 'Novità', path: '/articoli-frontaliere/traffico-droga-arresti-svizzera-estero-2026', parent: 'blog' },
    'blog-caslano-2025-bilancio-avanzamento': { name: 'Bilancio Caslano', path: '/articoli-frontaliere/caslano-2025-bilancio-avanzamento', parent: 'blog' },
    'blog-lombardia-piano-ciclabile-115-milioni': { name: 'Piano ciclabile', path: '/articoli-frontaliere/lombardia-piano-ciclabile-115-milioni', parent: 'blog' },
    'blog-sam-mendrisiotto-25-anni-emergenze': { name: 'Emergenze Sanitarie', path: '/articoli-frontaliere/sam-mendrisiotto-25-anni-emergenze', parent: 'blog' },
    'blog-nidi-extrascolastico-ticino-un-servizio': { name: 'Ticino', path: '/articoli-frontaliere/nidi-extrascolastico-ticino-un-servizio', parent: 'blog' },
    'blog-ticinesi-parigi-roland-garros': { name: 'Roland Garros', path: '/articoli-frontaliere/ticinesi-parigi-roland-garros', parent: 'blog' },
    'blog-locarno-landquart-rifiuti-1000-tonnellate': { name: 'Novità', path: '/articoli-frontaliere/locarno-landquart-rifiuti-1000-tonnellate', parent: 'blog' },
    'blog-stipendi-svizzeri-crescono-2025': { name: 'Novità', path: '/articoli-frontaliere/stipendi-svizzeri-crescono-2025', parent: 'blog' },
    'blog-tassa-traffico-pesante-lacune-controlli': { name: 'Fiscale', path: '/articoli-frontaliere/tassa-traffico-pesante-lacune-controlli', parent: 'blog' },
    'blog-quadri-interpella-consiglio-frontiere-tasse': { name: 'Frontiere e tasse', path: '/articoli-frontaliere/quadri-interpella-consiglio-frontiere-tasse', parent: 'blog' },
    'blog-fenealuil-decreto-lavoro-2026': { name: 'Decreto Lavoro', path: '/articoli-frontaliere/fenealuil-decreto-lavoro-2026', parent: 'blog' },
    'blog-bilancio-val-mara-2025-avanzamento-616mila': { name: 'Bilancio Val Mara', path: '/articoli-frontaliere/bilancio-val-mara-2025-avanzamento-616mila', parent: 'blog' },
    'blog-ambulatorio-cardio-metabolico-villa-san-giuseppe': { name: 'Novità sanitarie', path: '/articoli-frontaliere/ambulatorio-cardio-metabolico-villa-san-giuseppe', parent: 'blog' },
    'blog-riforma-ue-disoccupazione-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/riforma-ue-disoccupazione-frontalieri', parent: 'blog' },
    'blog-casse-malati-dado-scissione-dossier': { name: 'Casse malati', path: '/articoli-frontaliere/casse-malati-dado-scissione-dossier', parent: 'blog' },
    'blog-iliad-piu-veloci-rete-mobili': { name: 'Novità', path: '/articoli-frontaliere/iliad-piu-veloci-rete-mobili', parent: 'blog' },
    'blog-formazione-ferrero-ministero-2026': { name: 'Novità', path: '/articoli-frontaliere/formazione-ferrero-ministero-2026', parent: 'blog' },
    'blog-frontalieri-bellinzonese-truffe-16-mesi': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-bellinzonese-truffe-16-mesi', parent: 'blog' },
    'blog-decreto-lavoro-meloni-2026-frontalieri': { name: 'Decreto Lavoro', path: '/articoli-frontaliere/decreto-lavoro-meloni-2026-frontalieri', parent: 'blog' },
    'blog-calcio-dnb-belli-crisi': { name: 'Calcio Dnb', path: '/articoli-frontaliere/calcio-dnb-belli-crisi', parent: 'blog' },
    'blog-berset-sostegno-reynard-crans-montana': { name: 'Novità', path: '/articoli-frontaliere/berset-sostegno-reynard-crans-montana', parent: 'blog' },
    'blog-biasca-roller-hockey-uttigen-2026': { name: 'Novità', path: '/articoli-frontaliere/biasca-roller-hockey-uttigen-2026', parent: 'blog' },
    'blog-vuoto-ginevra-olympic-basket': { name: 'Novità', path: '/articoli-frontaliere/vuoto-ginevra-olympic-basket', parent: 'blog' },
    'blog-nuova-pista-ciclopedonale-bodio-giornico-2026': { name: 'Nuova pista ciclopedonale', path: '/articoli-frontaliere/nuova-pista-ciclopedonale-bodio-giornico-2026', parent: 'blog' },
    'blog-lago-como-edition-hotel-lusso': { name: 'Novità', path: '/articoli-frontaliere/lago-como-edition-hotel-lusso', parent: 'blog' },
    'blog-momoride-carpooling-sfida-collettiva': { name: 'Carpooling', path: '/articoli-frontaliere/momoride-carpooling-sfida-collettiva', parent: 'blog' },
    'blog-nuove-scuole-vernate-neggio-2026': { name: 'Nuove scuole', path: '/articoli-frontaliere/nuove-scuole-vernate-neggio-2026', parent: 'blog' },
    'blog-casse-malati-ticino-divise-2026': { name: 'Casse malati', path: '/articoli-frontaliere/casse-malati-ticino-divise-2026', parent: 'blog' },
    'blog-cina-spostamenti-frontalieri-primo-maggio': { name: 'Novità', path: '/articoli-frontaliere/cina-spostamenti-frontalieri-primo-maggio', parent: 'blog' },
    'blog-lugano-cultura-digitale-2024': { name: 'Novità culturale', path: '/articoli-frontaliere/lugano-cultura-digitale-2024', parent: 'blog' },
    'blog-fondazione-xenia-patto-generazionale': { name: 'Fondazione Xenia', path: '/articoli-frontaliere/fondazione-xenia-patto-generazionale', parent: 'blog' },
    'blog-europa-dal-basso-regioni-podcast-bianchi': { name: 'Novità', path: '/articoli-frontaliere/europa-dal-basso-regioni-podcast-bianchi', parent: 'blog' },
    'blog-viggi-bando-giovani-comunit-2026': { name: 'Bando giovani', path: '/articoli-frontaliere/viggi-bando-giovani-comunit-2026', parent: 'blog' },
    'blog-furti-centro-pacchi-cadenazzo': { name: 'Novità', path: '/articoli-frontaliere/furti-centro-pacchi-cadenazzo', parent: 'blog' },
    'blog-fattura-miliardaria-energia-medio-oriente': { name: 'Novità', path: '/articoli-frontaliere/fattura-miliardaria-energia-medio-oriente', parent: 'blog' },
    'blog-riforma-infermieri-ticino-2026': { name: 'Riforma infermieristica', path: '/articoli-frontaliere/riforma-infermieri-ticino-2026', parent: 'blog' },
    'blog-emergenza-casa-como-analisi': { name: 'Emergenza casa', path: '/articoli-frontaliere/emergenza-casa-como-analisi', parent: 'blog' },
    'blog-iniziativa-f-35-ticino-2026': { name: 'Iniziativa F-35', path: '/articoli-frontaliere/iniziativa-f-35-ticino-2026', parent: 'blog' },
    'blog-giro-e-angera-verbania-2026': { name: 'Giro-E 2026', path: '/articoli-frontaliere/giro-e-angera-verbania-2026', parent: 'blog' },
    'blog-iniziative-casse-malati-dado-scissione-dossier': { name: 'Iniziative casse malati', path: '/articoli-frontaliere/iniziative-casse-malati-dado-scissione-dossier', parent: 'blog' },
    'blog-moschea-pregassona-udc-interroga-municipio': { name: 'Moschea Pregassona', path: '/articoli-frontaliere/moschea-pregassona-udc-interroga-municipio', parent: 'blog' },
    'blog-como-area-camper-26-posti-lavori': { name: 'Novità', path: '/articoli-frontaliere/como-area-camper-26-posti-lavori', parent: 'blog' },
    'blog-caricabatteria-unico-portatili-2024': { name: 'Novità', path: '/articoli-frontaliere/caricabatteria-unico-portatili-2024', parent: 'blog' },
    'blog-ufficio-open-space-stress-frontalieri': { name: 'Lavoro e benessere', path: '/articoli-frontaliere/ufficio-open-space-stress-frontalieri', parent: 'blog' },
    'blog-estival-pagamento-caduta-stile-lugano': { name: 'Novità', path: '/articoli-frontaliere/estival-pagamento-caduta-stile-lugano', parent: 'blog' },
    'blog-giornata-contro-rumore-lugano-2024': { name: 'Controlli rumore', path: '/articoli-frontaliere/giornata-contro-rumore-lugano-2024', parent: 'blog' },
    'blog-estival-jazz-lugano-pagamento-2024': { name: 'Novità', path: '/articoli-frontaliere/estival-jazz-lugano-pagamento-2024', parent: 'blog' },
    'blog-varese-sostenibilita-csr-camera-commercio': { name: 'Eventi Varese', path: '/articoli-frontaliere/varese-sostenibilita-csr-camera-commercio', parent: 'blog' },
    'blog-lombardia-30-milioni-quartiere-efficientamento': { name: 'Novità', path: '/articoli-frontaliere/lombardia-30-milioni-quartiere-efficientamento', parent: 'blog' },
    'blog-moschea-lugano-pregassona-2026': { name: 'Novità', path: '/articoli-frontaliere/moschea-lugano-pregassona-2026', parent: 'blog' },
    'blog-fuga-ammoniaca-chiasso-causa-trovata': { name: 'Novità', path: '/articoli-frontaliere/fuga-ammoniaca-chiasso-causa-trovata', parent: 'blog' },
    'blog-unitas-80-anni-innovazione-inclusione': { name: 'Unitas 80 anni', path: '/articoli-frontaliere/unitas-80-anni-innovazione-inclusione', parent: 'blog' },
    'blog-dfp-giorgetti-deficit-ridotto': { name: 'Fiscale', path: '/articoli-frontaliere/dfp-giorgetti-deficit-ridotto', parent: 'blog' },
    'blog-castiglione-olona-ufficio-postale-riaperto': { name: 'Novità', path: '/articoli-frontaliere/castiglione-olona-ufficio-postale-riaperto', parent: 'blog' },
    'blog-programmi-educativi-bellinzona-2026': { name: 'Programmi educativi', path: '/articoli-frontaliere/programmi-educativi-bellinzona-2026', parent: 'blog' },
    'blog-aeroporti-milano-boom-fatturato-197-milioni': { name: 'Novità', path: '/articoli-frontaliere/aeroporti-milano-boom-fatturato-197-milioni', parent: 'blog' },
    'blog-servizio-clienti-bancario-promossi-bocciati': { name: 'Servizio clienti', path: '/articoli-frontaliere/servizio-clienti-bancario-promossi-bocciati', parent: 'blog' },
    'blog-agricoltura-spaziale-svizzera-ricerca': { name: 'Novità', path: '/articoli-frontaliere/agricoltura-spaziale-svizzera-ricerca', parent: 'blog' },
    'blog-ubs-lobbying-parlamento-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/ubs-lobbying-parlamento-ticino-2026', parent: 'blog' },
    'blog-nuovo-presidente-gastro-bellinzona': { name: 'Novità', path: '/articoli-frontaliere/nuovo-presidente-gastro-bellinzona', parent: 'blog' },
    'blog-varese-ospedale-parcheggi-personale-2026': { name: 'Presidio UIL FP', path: '/articoli-frontaliere/varese-ospedale-parcheggi-personale-2026', parent: 'blog' },
    'blog-coalizione-sanitario-volonta-calpestata': { name: 'Novità', path: '/articoli-frontaliere/coalizione-sanitario-volonta-calpestata', parent: 'blog' },
    'blog-volo-swiss-evacuato-passeggeri-bagaglio': { name: 'Novità', path: '/articoli-frontaliere/volo-swiss-evacuato-passeggeri-bagaglio', parent: 'blog' },
    'blog-banche-golfo-frontalieri-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/banche-golfo-frontalieri-ticino-2026', parent: 'blog' },
    'blog-rilanciare-commercio-saronno-2026': { name: 'Novità', path: '/articoli-frontaliere/rilanciare-commercio-saronno-2026', parent: 'blog' },
    'blog-lugano-aggressione-abitazione-2024': { name: 'Novità', path: '/articoli-frontaliere/lugano-aggressione-abitazione-2024', parent: 'blog' },
    'blog-furti-chiese-ticino-rumeni-fermati': { name: 'Furti in chiese', path: '/articoli-frontaliere/furti-chiese-ticino-rumeni-fermati', parent: 'blog' },
    'blog-attentato-washington-trump-2026': { name: 'Attentato Washington', path: '/articoli-frontaliere/attentato-washington-trump-2026', parent: 'blog' },
    'blog-casa-montana-nante-governo-regolare': { name: 'Novità', path: '/articoli-frontaliere/casa-montana-nante-governo-regolare', parent: 'blog' },
    'blog-neuchatel-palloncini-lanterne-vietati': { name: 'Novità', path: '/articoli-frontaliere/neuchatel-palloncini-lanterne-vietati', parent: 'blog' },
    'blog-vaud-parlamento-dimissioni-dittli': { name: 'Novità', path: '/articoli-frontaliere/vaud-parlamento-dimissioni-dittli', parent: 'blog' },
    'blog-rogo-san-fermo-battaglia-2024': { name: 'Novità', path: '/articoli-frontaliere/rogo-san-fermo-battaglia-2024', parent: 'blog' },
    'blog-terremoto-san-gallo-2026': { name: 'Novità', path: '/articoli-frontaliere/terremoto-san-gallo-2026', parent: 'blog' },
    'blog-infermieri-indipendenti-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/infermieri-indipendenti-ticino-2026', parent: 'blog' },
    'blog-deposito-carrozzeria-sequestrato-como-2026': { name: 'Deposito carrozzeria', path: '/articoli-frontaliere/deposito-carrozzeria-sequestrato-como-2026', parent: 'blog' },
    'blog-agesp-rifiuti-primo-maggio-2026': { name: 'Servizi rifiuti Agesp', path: '/articoli-frontaliere/agesp-rifiuti-primo-maggio-2026', parent: 'blog' },
    'blog-stop-cinese-acquisizione-manus-implicazioni': { name: 'Novità', path: '/articoli-frontaliere/stop-cinese-acquisizione-manus-implicazioni', parent: 'blog' },
    'blog-gita-cuore-soncino-saronno-point': { name: 'Gita del cuore', path: '/articoli-frontaliere/gita-cuore-soncino-saronno-point', parent: 'blog' },
    'blog-decreto-lavoro-meloni-frontalieri-ticino': { name: 'Decreto lavoro', path: '/articoli-frontaliere/decreto-lavoro-meloni-frontalieri-ticino', parent: 'blog' },
    'blog-othermovie-lugano-2026-god-witness': { name: 'OtherMovie Lugano', path: '/articoli-frontaliere/othermovie-lugano-2026-god-witness', parent: 'blog' },
    'blog-emporio-solidarieta-olgiate-olona': { name: 'Novità', path: '/articoli-frontaliere/emporio-solidarieta-olgiate-olona', parent: 'blog' },
    'blog-estival-jazz-lugano-cambia-formula-2026': { name: 'Novità', path: '/articoli-frontaliere/estival-jazz-lugano-cambia-formula-2026', parent: 'blog' },
    'blog-eurovision-ballad-ticino-2026': { name: 'Eurovision 2026', path: '/articoli-frontaliere/eurovision-ballad-ticino-2026', parent: 'blog' },
    'blog-unitas-ottantesimo-futuro-ticino': { name: 'Unitas 80 anni', path: '/articoli-frontaliere/unitas-ottantesimo-futuro-ticino', parent: 'blog' },
    'blog-como-io-ho-segnalato-ma-il-comune-non-ne-vuole-sapere': { name: 'Como, io ho segnalato ma il Comune non ne', path: '/articoli-frontaliere/como-io-ho-segnalato-ma-il-comune-non-ne-vuole-sapere', parent: 'blog' },
    'blog-ucraina-russia-droni-2026': { name: 'Novità', path: '/articoli-frontaliere/ucraina-russia-droni-2026', parent: 'blog' },
    'blog-play-suisse-novita-streaming-2026': { name: 'Novità Play Suisse', path: '/articoli-frontaliere/play-suisse-novita-streaming-2026', parent: 'blog' },
    'blog-dehors-como-ricorso-tar-20-maggio': { name: 'Novità', path: '/articoli-frontaliere/dehors-como-ricorso-tar-20-maggio', parent: 'blog' },
    'blog-bruno-breguet-scomparsa-ufficializzata': { name: 'Novità', path: '/articoli-frontaliere/bruno-breguet-scomparsa-ufficializzata', parent: 'blog' },
    'blog-profumo-prato-tagliato-grido-aiuto-piante': { name: 'Novità', path: '/articoli-frontaliere/profumo-prato-tagliato-grido-aiuto-piante', parent: 'blog' },
    'blog-novartis-calo-utile-2026': { name: 'Novita', path: '/articoli-frontaliere/novartis-calo-utile-2026', parent: 'blog' },
    'blog-taglio-accise-proroga-meloni-2026': { name: 'Novità', path: '/articoli-frontaliere/taglio-accise-proroga-meloni-2026', parent: 'blog' },
    'blog-fedpol-arresto-corruzione-2026': { name: 'Novità', path: '/articoli-frontaliere/fedpol-arresto-corruzione-2026', parent: 'blog' },
    'blog-momoride-benefico-mendrisiotto-2024': { name: 'MomòRide', path: '/articoli-frontaliere/momoride-benefico-mendrisiotto-2024', parent: 'blog' },
    'blog-uzbekistan-oro-gas-ticino-implicazioni': { name: 'Novità', path: '/articoli-frontaliere/uzbekistan-oro-gas-ticino-implicazioni', parent: 'blog' },
    'blog-attentato-washington-trump-2026-analisi': { name: 'Attentato a Trump', path: '/articoli-frontaliere/attentato-washington-trump-2026-analisi', parent: 'blog' },
    'blog-spese-militari-2025-aumento-2900-miliardi': { name: 'Spese militari', path: '/articoli-frontaliere/spese-militari-2025-aumento-2900-miliardi', parent: 'blog' },
    'blog-karimova-processo-bellinzona-2026': { name: 'Processo Karimova', path: '/articoli-frontaliere/karimova-processo-bellinzona-2026', parent: 'blog' },
    'blog-truffe-sentimentali-zurigo-2026': { name: 'Truffe sentimentali', path: '/articoli-frontaliere/truffe-sentimentali-zurigo-2026', parent: 'blog' },
    'blog-esposizione-segughi-malvaglia-2026': { name: 'Esposizione Segugi', path: '/articoli-frontaliere/esposizione-segughi-malvaglia-2026', parent: 'blog' },
    'blog-ragazza-morta-campo-perquisita-casa-amico': { name: 'Novità', path: '/articoli-frontaliere/ragazza-morta-campo-perquisita-casa-amico', parent: 'blog' },
    'blog-violenza-domestica-misure-urgenti': { name: 'Novità', path: '/articoli-frontaliere/violenza-domestica-misure-urgenti', parent: 'blog' },
    'blog-robot-umanoidi-maratona-fascinazione': { name: 'Tecnologia e frontalieri', path: '/articoli-frontaliere/robot-umanoidi-maratona-fascinazione', parent: 'blog' },
    'blog-guida-svizzera-frontalieri-ticino': { name: 'Guida pratica', path: '/articoli-frontaliere/guida-svizzera-frontalieri-ticino', parent: 'blog' },
    'blog-commesse-pubbliche-servizi-essenziali-2026': { name: 'Novità', path: '/articoli-frontaliere/commesse-pubbliche-servizi-essenziali-2026', parent: 'blog' },
    'blog-frontalieri-ticino-sentono-criminali': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-ticino-sentono-criminali', parent: 'blog' },
    'blog-esubero-leventina-zone-edificabili-2026': { name: 'Novità', path: '/articoli-frontaliere/esubero-leventina-zone-edificabili-2026', parent: 'blog' },
    'blog-varese-corsi-net-opportunita-rete-sinergie-2026': { name: 'Varese Corsi Net', path: '/articoli-frontaliere/varese-corsi-net-opportunita-rete-sinergie-2026', parent: 'blog' },
    'blog-centri-responsabilita-frontalieri-ticino': { name: 'Novità', path: '/articoli-frontaliere/centri-responsabilita-frontalieri-ticino', parent: 'blog' },
    'blog-incontro-sem-cantone-comuni-annullato': { name: 'Novità', path: '/articoli-frontaliere/incontro-sem-cantone-comuni-annullato', parent: 'blog' },
    'blog-centrosinistra-varese-patto-2027': { name: 'Centrosinistra Varese', path: '/articoli-frontaliere/centrosinistra-varese-patto-2027', parent: 'blog' },
    'blog-magadino-parco-giochi-nuova-area-ludica': { name: 'Novità', path: '/articoli-frontaliere/magadino-parco-giochi-nuova-area-ludica', parent: 'blog' },
    'blog-incidente-valle-verzasca-2026': { name: 'Incidente Valle Verzasca', path: '/articoli-frontaliere/incidente-valle-verzasca-2026', parent: 'blog' },
    'blog-guida-affettuosa-separazione-ticino-2026': { name: 'Guida separazione', path: '/articoli-frontaliere/guida-affettuosa-separazione-ticino-2026', parent: 'blog' },
    'blog-processo-tentato-omicidio-chiasso-2026': { name: 'Processo Chiasso', path: '/articoli-frontaliere/processo-tentato-omicidio-chiasso-2026', parent: 'blog' },
    'blog-varese-cultura-2030-ecosistema-culturale': { name: 'Varese Cultura 2030', path: '/articoli-frontaliere/varese-cultura-2030-ecosistema-culturale', parent: 'blog' },
    'blog-casa-montana-nante-ricorso-tram': { name: 'Novità', path: '/articoli-frontaliere/casa-montana-nante-ricorso-tram', parent: 'blog' },
    'blog-atleti-ticinesi-vittoria-arcegno-ascona': { name: 'Sport Ticino', path: '/articoli-frontaliere/atleti-ticinesi-vittoria-arcegno-ascona', parent: 'blog' },
    'blog-malnate-comitati-quartiere-bilancio-partecipativo': { name: 'Comitati di Quartiere', path: '/articoli-frontaliere/malnate-comitati-quartiere-bilancio-partecipativo', parent: 'blog' },
    'blog-casa-montana-nante-voto-validato': { name: 'Novità', path: '/articoli-frontaliere/casa-montana-nante-voto-validato', parent: 'blog' },
    'blog-furti-cantine-luganese-condannato': { name: 'Novità', path: '/articoli-frontaliere/furti-cantine-luganese-condannato', parent: 'blog' },
    'blog-varese-corsi-parlare-pubblico-2026': { name: 'Public Speaking', path: '/articoli-frontaliere/varese-corsi-parlare-pubblico-2026', parent: 'blog' },
    'blog-svizzera-10-milioni-votazione-ticino': { name: 'Iniziativa UDC', path: '/articoli-frontaliere/svizzera-10-milioni-votazione-ticino', parent: 'blog' },
    'blog-lombardia-tassa-sanitaria-frontalieri-2026': { name: 'Tassa sanitaria', path: '/articoli-frontaliere/lombardia-tassa-sanitaria-frontalieri-2026', parent: 'blog' },
    'blog-730-precompilato-frontalieri-ticino-2026': { name: 'Fiscale', path: '/articoli-frontaliere/730-precompilato-frontalieri-ticino-2026', parent: 'blog' },
    'blog-tosatura-pecore-riparazione-vestiti-bellinzona-2026': { name: 'Evento Bellinzona', path: '/articoli-frontaliere/tosatura-pecore-riparazione-vestiti-bellinzona-2026', parent: 'blog' },
    'blog-geopolitica-sindacato-nuovi-equilibri-varese': { name: 'Geopolitica e sindacato', path: '/articoli-frontaliere/geopolitica-sindacato-nuovi-equilibri-varese', parent: 'blog' },
    'blog-ferrara-m5s-beko-cassinetta-verifica': { name: 'Novità', path: '/articoli-frontaliere/ferrara-m5s-beko-cassinetta-verifica', parent: 'blog' },
    'blog-azienda-comasca-fotovoltaico-25-tonnellate-co2': { name: 'Novità', path: '/articoli-frontaliere/azienda-comasca-fotovoltaico-25-tonnellate-co2', parent: 'blog' },
    'blog-citta-fiore-orticolario-tricolore-2026': { name: 'Novità', path: '/articoli-frontaliere/citta-fiore-orticolario-tricolore-2026', parent: 'blog' },
    'blog-friborgogotteron-spareggio-titolo-hockey': { name: 'Novità Sport', path: '/articoli-frontaliere/friborgogotteron-spareggio-titolo-hockey', parent: 'blog' },
    'blog-como-verdi-elogio-rapinese-alberi': { name: 'Novità', path: '/articoli-frontaliere/como-verdi-elogio-rapinese-alberi', parent: 'blog' },
    'blog-petrolio-gas-svizzera-approvvigionamento-sicuro': { name: 'Novità', path: '/articoli-frontaliere/petrolio-gas-svizzera-approvvigionamento-sicuro', parent: 'blog' },
    'blog-von-der-leyen-ue-energia-500-milioni-giorno': { name: 'Novità', path: '/articoli-frontaliere/von-der-leyen-ue-energia-500-milioni-giorno', parent: 'blog' },
    'blog-svizzera-cashless-bns-sistema-equo': { name: 'Novità', path: '/articoli-frontaliere/svizzera-cashless-bns-sistema-equo', parent: 'blog' },
    'blog-avs-dati-digitale-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/avs-dati-digitale-frontalieri', parent: 'blog' },
    'blog-scorte-carburante-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/scorte-carburante-svizzera-2026', parent: 'blog' },
    'blog-swiss-duty-free-addio-30-settembre': { name: 'Novità', path: '/articoli-frontaliere/swiss-duty-free-addio-30-settembre', parent: 'blog' },
    'blog-momoride-carpooling-frontalieri-benefici': { name: 'Carpooling aziendale', path: '/articoli-frontaliere/momoride-carpooling-frontalieri-benefici', parent: 'blog' },
    'blog-swiss-duty-free-fine-vendite-bordo': { name: 'Novità', path: '/articoli-frontaliere/swiss-duty-free-fine-vendite-bordo', parent: 'blog' },
    'blog-incidente-aarau-18enne-frontaliere': { name: 'Incidente Aarau', path: '/articoli-frontaliere/incidente-aarau-18enne-frontaliere', parent: 'blog' },
    'blog-san-gallo-vince-thun-ritardo-festa': { name: 'Novità', path: '/articoli-frontaliere/san-gallo-vince-thun-ritardo-festa', parent: 'blog' },
    'blog-hupac-busto-utile-positivo-collegamenti': { name: 'Novità', path: '/articoli-frontaliere/hupac-busto-utile-positivo-collegamenti', parent: 'blog' },
    'blog-hupac-bilancio-positivo-2025': { name: 'Novità', path: '/articoli-frontaliere/hupac-bilancio-positivo-2025', parent: 'blog' },
    'blog-infermieri-orario-lavoro-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/infermieri-orario-lavoro-ticino-2026', parent: 'blog' },
    'blog-rumore-traffico-svizzera-500-morti-anno': { name: 'Novità', path: '/articoli-frontaliere/rumore-traffico-svizzera-500-morti-anno', parent: 'blog' },
    'blog-frontalieri-ticino-parchi-vandalismo-2026': { name: 'Parchi vandalizzati', path: '/articoli-frontaliere/frontalieri-ticino-parchi-vandalismo-2026', parent: 'blog' },
    'blog-spacchettamento-casse-malati-2026': { name: 'Novità', path: '/articoli-frontaliere/spacchettamento-casse-malati-2026', parent: 'blog' },
    'blog-athora-italia-previdenza-complementare-2026': { name: 'Previdenza complementare', path: '/articoli-frontaliere/athora-italia-previdenza-complementare-2026', parent: 'blog' },
    'blog-annuario-impresari-2026-ticino': { name: 'Annuario 2026', path: '/articoli-frontaliere/annuario-impresari-2026-ticino', parent: 'blog' },
    'blog-via-francisca-10-anni-turismo-ticino': { name: 'Via Francisca', path: '/articoli-frontaliere/via-francisca-10-anni-turismo-ticino', parent: 'blog' },
    'blog-scuola-viganello-gaza-gemellaggio-2026': { name: 'Gemellaggio scuole', path: '/articoli-frontaliere/scuola-viganello-gaza-gemellaggio-2026', parent: 'blog' },
    'blog-digitalizzazione-avs-ai-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/digitalizzazione-avs-ai-frontalieri', parent: 'blog' },
    'blog-celti-tradate-parco-pineta-2026': { name: 'Eventi culturali', path: '/articoli-frontaliere/celti-tradate-parco-pineta-2026', parent: 'blog' },
    'blog-canapa-losanna-bilancio-positivo-2026': { name: 'Novità', path: '/articoli-frontaliere/canapa-losanna-bilancio-positivo-2026', parent: 'blog' },
    'blog-estival-jazz-marti-ritiro-2026': { name: 'Novità', path: '/articoli-frontaliere/estival-jazz-marti-ritiro-2026', parent: 'blog' },
    'blog-licata-lombardia-bulgaria-opportunita': { name: 'Novità', path: '/articoli-frontaliere/licata-lombardia-bulgaria-opportunita', parent: 'blog' },
    'blog-maroggia-servizi-postali-2026': { name: 'Novità', path: '/articoli-frontaliere/maroggia-servizi-postali-2026', parent: 'blog' },
    'blog-gemellaggio-scuole-viganello-gaza-2026': { name: 'Gemellaggio scuole', path: '/articoli-frontaliere/gemellaggio-scuole-viganello-gaza-2026', parent: 'blog' },
    'blog-laurent-morel-nominato-direttore-ef-svizzera': { name: 'Novità', path: '/articoli-frontaliere/laurent-morel-nominato-direttore-ef-svizzera', parent: 'blog' },
    'blog-san-gottardo-secondo-tubo-caduto-diaframma': { name: 'San Gottardo', path: '/articoli-frontaliere/san-gottardo-secondo-tubo-caduto-diaframma', parent: 'blog' },
    'blog-venditti-estival-lugano-2026': { name: 'Eventi Lugano', path: '/articoli-frontaliere/venditti-estival-lugano-2026', parent: 'blog' },
    'blog-accordo-syndicom-vsm-2026': { name: 'Novità', path: '/articoli-frontaliere/accordo-syndicom-vsm-2026', parent: 'blog' },
    'blog-philipp-plein-mendrisio-interrogazione': { name: 'Novità', path: '/articoli-frontaliere/philipp-plein-mendrisio-interrogazione', parent: 'blog' },
    'blog-mercatino-primavera-lugano-2026': { name: 'Mercatino Primavera', path: '/articoli-frontaliere/mercatino-primavera-lugano-2026', parent: 'blog' },
    'blog-italia-svizzera-ricerca-2026': { name: 'Novità', path: '/articoli-frontaliere/italia-svizzera-ricerca-2026', parent: 'blog' },
    'blog-ricerca-italiana-ginevra-2026': { name: 'Novità', path: '/articoli-frontaliere/ricerca-italiana-ginevra-2026', parent: 'blog' },
    'blog-svizzera-serbia-cooperazione-2026': { name: 'Cooperazione Svizzera-Serbia', path: '/articoli-frontaliere/svizzera-serbia-cooperazione-2026', parent: 'blog' },
    'blog-chi-finanzia-politica-svizzera-2026': { name: 'Politica svizzera', path: '/articoli-frontaliere/chi-finanzia-politica-svizzera-2026', parent: 'blog' },
    'blog-accordo-lago-maggiore-italia-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/accordo-lago-maggiore-italia-svizzera-2026', parent: 'blog' },
    'blog-webinar-ai-azienda-strategia-casi-concreti': { name: 'Webinar AI', path: '/articoli-frontaliere/webinar-ai-azienda-strategia-casi-concreti', parent: 'blog' },
    'blog-comunita-montana-valli-verbano-incontri-natura-cambia': { name: 'Incontri natura', path: '/articoli-frontaliere/comunita-montana-valli-verbano-incontri-natura-cambia', parent: 'blog' },
    'blog-innalzamento-lago-maggiore-140-metri': { name: 'Novità', path: '/articoli-frontaliere/innalzamento-lago-maggiore-140-metri', parent: 'blog' },
    'blog-guardie-svizzere-giuramento-vaticano-2026': { name: 'Novità', path: '/articoli-frontaliere/guardie-svizzere-giuramento-vaticano-2026', parent: 'blog' },
    'blog-apprendistato-varese-2-7-ingressi-lavoro': { name: 'Apprendistato Varese', path: '/articoli-frontaliere/apprendistato-varese-2-7-ingressi-lavoro', parent: 'blog' },
    'blog-casa-hockey-lugano-ambri-2026': { name: 'Novità Hockey', path: '/articoli-frontaliere/casa-hockey-lugano-ambri-2026', parent: 'blog' },
    'blog-swiss-duty-free-cambia-vendite-2026': { name: 'Novità', path: '/articoli-frontaliere/swiss-duty-free-cambia-vendite-2026', parent: 'blog' },
    'blog-tutor-sapiens-apprendistato-terzo-livello': { name: 'Novità', path: '/articoli-frontaliere/tutor-sapiens-apprendistato-terzo-livello', parent: 'blog' },
    'blog-tunnel-tonale-viabilita-lombardia': { name: 'Novità', path: '/articoli-frontaliere/tunnel-tonale-viabilita-lombardia', parent: 'blog' },
    'blog-spring-giubiasco-sport-convivialita-2026': { name: 'Spring Giubiasco', path: '/articoli-frontaliere/spring-giubiasco-sport-convivialita-2026', parent: 'blog' },
    'blog-carnago-forza-italia-pendolarismo': { name: 'Carnago', path: '/articoli-frontaliere/carnago-forza-italia-pendolarismo', parent: 'blog' },
    'blog-usa-svizzera-frizioni-commerciali-2026': { name: 'Novità', path: '/articoli-frontaliere/usa-svizzera-frizioni-commerciali-2026', parent: 'blog' },
    'blog-terremoto-gottardo-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/terremoto-gottardo-frontalieri', parent: 'blog' },
    'blog-benzina-record-annuale-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/benzina-record-annuale-svizzera-2026', parent: 'blog' },
    'blog-giovane-gambizzato-como-2026': { name: 'Incidente Como', path: '/articoli-frontaliere/giovane-gambizzato-como-2026', parent: 'blog' },
    'blog-andre-wyss-nuovo-presidente-ffs': { name: 'Novità', path: '/articoli-frontaliere/andre-wyss-nuovo-presidente-ffs', parent: 'blog' },
    'blog-moncucco-risultati-positivi-2025': { name: 'Novità', path: '/articoli-frontaliere/moncucco-risultati-positivi-2025', parent: 'blog' },
    'blog-bellinzona-datore-lavoro-conciliabilita': { name: 'Novità', path: '/articoli-frontaliere/bellinzona-datore-lavoro-conciliabilita', parent: 'blog' },
    'blog-mendrisio-conti-positivi-2025': { name: 'Conti Mendrisio', path: '/articoli-frontaliere/mendrisio-conti-positivi-2025', parent: 'blog' },
    'blog-criminalita-organizzata-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/criminalita-organizzata-svizzera-2026', parent: 'blog' },
    'blog-stazioni-sciistiche-ticino-contributi-2026': { name: 'Novità', path: '/articoli-frontaliere/stazioni-sciistiche-ticino-contributi-2026', parent: 'blog' },
    'blog-ubs-keller-sutter-lobbismo-2026': { name: 'Novità', path: '/articoli-frontaliere/ubs-keller-sutter-lobbismo-2026', parent: 'blog' },
    'blog-daverio-gazzada-assistenza-medica-2026': { name: 'Novità', path: '/articoli-frontaliere/daverio-gazzada-assistenza-medica-2026', parent: 'blog' },
    'blog-trivella-san-gottardo-zona-faglia': { name: 'Novità', path: '/articoli-frontaliere/trivella-san-gottardo-zona-faglia', parent: 'blog' },
    'blog-ambulatori-medici-temporanei-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/ambulatori-medici-temporanei-varese-2026', parent: 'blog' },
    'blog-copernicus-clima-2025-europa': { name: 'Novità', path: '/articoli-frontaliere/copernicus-clima-2025-europa', parent: 'blog' },
    'blog-credinvest-bank-crescita-2026': { name: 'Novità', path: '/articoli-frontaliere/credinvest-bank-crescita-2026', parent: 'blog' },
    'blog-riforma-frontalieri-costi-svizzera': { name: 'Novità', path: '/articoli-frontaliere/riforma-frontalieri-costi-svizzera', parent: 'blog' },
    'blog-conciliabilita-vita-lavoro-bellinzona-2026': { name: 'Conciliabilità vita-lavoro', path: '/articoli-frontaliere/conciliabilita-vita-lavoro-bellinzona-2026', parent: 'blog' },
    'blog-chiasso-assassinio-mancato-15-anni-carcere': { name: 'Novità', path: '/articoli-frontaliere/chiasso-assassinio-mancato-15-anni-carcere', parent: 'blog' },
    'blog-lite-dogana-ponte-chiasso-ferito-contuso': { name: 'Incidente dogana', path: '/articoli-frontaliere/lite-dogana-ponte-chiasso-ferito-contuso', parent: 'blog' },
    'blog-intesa-sanpaolo-premia-10-imprese-vincenti': { name: 'Novità', path: '/articoli-frontaliere/intesa-sanpaolo-premia-10-imprese-vincenti', parent: 'blog' },
    'blog-pillola-giorno-dopo-consulenza-nazionale': { name: 'Novità', path: '/articoli-frontaliere/pillola-giorno-dopo-consulenza-nazionale', parent: 'blog' },
    'blog-sindaci-verbania-baveno-cannobio-opposizione': { name: 'Novità', path: '/articoli-frontaliere/sindaci-verbania-baveno-cannobio-opposizione', parent: 'blog' },
    'blog-mendrisio-bilancio-positivo-2025': { name: 'Novità', path: '/articoli-frontaliere/mendrisio-bilancio-positivo-2025', parent: 'blog' },
    'blog-terzo-frigo-tenero-anti-spreco': { name: 'Novità', path: '/articoli-frontaliere/terzo-frigo-tenero-anti-spreco', parent: 'blog' },
    'blog-frontalieri-disoccupazione-stato-lavoro': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-disoccupazione-stato-lavoro', parent: 'blog' },
    'blog-lavoro-openjobmetis-2026-opportunita': { name: 'Lavoro', path: '/articoli-frontaliere/lavoro-openjobmetis-2026-opportunita', parent: 'blog' },
    'blog-openjobmetis-materia-castronno-2026': { name: 'Openjobmetis Materia', path: '/articoli-frontaliere/openjobmetis-materia-castronno-2026', parent: 'blog' },
    'blog-vaiolo-delle-scimmie-ticino-2026': { name: 'Salute', path: '/articoli-frontaliere/vaiolo-delle-scimmie-ticino-2026', parent: 'blog' },
    'blog-maroggia-postale-domestico-2024': { name: 'Servizi postali', path: '/articoli-frontaliere/maroggia-postale-domestico-2024', parent: 'blog' },
    'blog-convegno-milano-mafia-italia-svizzera-2026': { name: 'Convegno Milano', path: '/articoli-frontaliere/convegno-milano-mafia-italia-svizzera-2026', parent: 'blog' },
    'blog-gruppo-moncucco-2025-risultati': { name: 'Novità', path: '/articoli-frontaliere/gruppo-moncucco-2025-risultati', parent: 'blog' },
    'blog-distretto-benessere-campo-fiori-2026': { name: 'Distretto benessere', path: '/articoli-frontaliere/distretto-benessere-campo-fiori-2026', parent: 'blog' },
    'blog-chiusure-ospedale-circolo-varese-2026': { name: 'Chiusure Ospedale', path: '/articoli-frontaliere/chiusure-ospedale-circolo-varese-2026', parent: 'blog' },
    'blog-svizzera-overtourism-lucerna-grindelwald': { name: 'Novità', path: '/articoli-frontaliere/svizzera-overtourism-lucerna-grindelwald', parent: 'blog' },
    'blog-alluvione-lavizzara-piano-pericoli-approvato': { name: 'Alluvione Lavizzara', path: '/articoli-frontaliere/alluvione-lavizzara-piano-pericoli-approvato', parent: 'blog' },
    'blog-bedretto-lab-microterremoti-ricerca': { name: 'Novità', path: '/articoli-frontaliere/bedretto-lab-microterremoti-ricerca', parent: 'blog' },
    'blog-microterremoto-ticino-successo-test': { name: 'Novità', path: '/articoli-frontaliere/microterremoto-ticino-successo-test', parent: 'blog' },
    'blog-festa-famiglie-lugano-2026': { name: 'Festa famiglie', path: '/articoli-frontaliere/festa-famiglie-lugano-2026', parent: 'blog' },
    'blog-stop-milioni-casse-malati-club-sportivi': { name: 'Novità', path: '/articoli-frontaliere/stop-milioni-casse-malati-club-sportivi', parent: 'blog' },
    'blog-delusi-svizzera-frontalieri-abbandonati': { name: 'Novità', path: '/articoli-frontaliere/delusi-svizzera-frontalieri-abbandonati', parent: 'blog' },
    'blog-separazioni-ticino-famiglie-monoparentali': { name: 'Separazioni Ticino', path: '/articoli-frontaliere/separazioni-ticino-famiglie-monoparentali', parent: 'blog' },
    'blog-dichiarazione-precompilata-2026-disponibile': { name: 'Fiscale', path: '/articoli-frontaliere/dichiarazione-precompilata-2026-disponibile', parent: 'blog' },
    'blog-moncucco-utile-raddoppiato-2026': { name: 'Novità', path: '/articoli-frontaliere/moncucco-utile-raddoppiato-2026', parent: 'blog' },
    'blog-domenica-natura-spazio-tradate-2026': { name: 'Eventi Tradate', path: '/articoli-frontaliere/domenica-natura-spazio-tradate-2026', parent: 'blog' },
    'blog-lago-maggiore-innalzamento-2026': { name: 'Novità', path: '/articoli-frontaliere/lago-maggiore-innalzamento-2026', parent: 'blog' },
    'blog-usa-critica-svizzera-bio-duopolio': { name: 'Novità', path: '/articoli-frontaliere/usa-critica-svizzera-bio-duopolio', parent: 'blog' },
    'blog-dl-bollette-novita-consumatori-2026': { name: 'Novità consumatori', path: '/articoli-frontaliere/dl-bollette-novita-consumatori-2026', parent: 'blog' },
    'blog-bonus-sicurezza-2026-frontalieri-ticino': { name: 'Bonus sicurezza 2026', path: '/articoli-frontaliere/bonus-sicurezza-2026-frontalieri-ticino', parent: 'blog' },
    'blog-palma-muralto-ristrutturazione-strategia-2024': { name: 'Novità', path: '/articoli-frontaliere/palma-muralto-ristrutturazione-strategia-2024', parent: 'blog' },
    'blog-gev-ticino-ambiente-2026': { name: 'Protezione ambientale', path: '/articoli-frontaliere/gev-ticino-ambiente-2026', parent: 'blog' },
    'blog-siccita-lombardia-riserve-idriche-2026': { name: 'Novità', path: '/articoli-frontaliere/siccita-lombardia-riserve-idriche-2026', parent: 'blog' },
    'blog-fed-powell-addio-tassi-invariati': { name: 'Economia', path: '/articoli-frontaliere/fed-powell-addio-tassi-invariati', parent: 'blog' },
    'blog-ubs-utile-3-miliardi-2026': { name: 'Novità', path: '/articoli-frontaliere/ubs-utile-3-miliardi-2026', parent: 'blog' },
    'blog-borse-europee-zurigo-trimestrali': { name: 'Novità', path: '/articoli-frontaliere/borse-europee-zurigo-trimestrali', parent: 'blog' },
    'blog-supsi-20-nuovi-professori-2026': { name: 'Novità', path: '/articoli-frontaliere/supsi-20-nuovi-professori-2026', parent: 'blog' },
    'blog-italian-e-bike-tragedy-bern': { name: 'Morto italiano in incidente di e-bike nel', path: '/articoli-frontaliere/italian-e-bike-tragedy-bern', parent: 'blog' },
    'blog-violenza-sessuale-conseguenze-ticino': { name: 'Violenza sessuale, le conseguenze sono', path: '/articoli-frontaliere/violenza-sessuale-conseguenze-ticino', parent: 'blog' },
    'blog-mendrisio-bilancio-positivo-2025-analisi': { name: 'Bilancio Mendrisio', path: '/articoli-frontaliere/mendrisio-bilancio-positivo-2025-analisi', parent: 'blog' },
    'blog-ubs-credit-suisse-integrazione-risultati-2026': { name: 'Novità', path: '/articoli-frontaliere/ubs-credit-suisse-integrazione-risultati-2026', parent: 'blog' },
    'blog-varese-digitale-3d-visita': { name: 'Varese Digitale', path: '/articoli-frontaliere/varese-digitale-3d-visita', parent: 'blog' },
    'blog-varesotto-paperoni-lago-maggiore-2026': { name: 'Varese: il 2% detiene il 15% della', path: '/articoli-frontaliere/varesotto-paperoni-lago-maggiore-2026', parent: 'blog' },
    'blog-regione-lombardia-4-4-milioni-insubria': { name: 'Novità', path: '/articoli-frontaliere/regione-lombardia-4-4-milioni-insubria', parent: 'blog' },
    'blog-luve-hyperscaler-ai-accordo-100-milioni': { name: 'Novità', path: '/articoli-frontaliere/luve-hyperscaler-ai-accordo-100-milioni', parent: 'blog' },
    'blog-social-media-frontalieri-ticino': { name: 'Social Media', path: '/articoli-frontaliere/social-media-frontalieri-ticino', parent: 'blog' },
    'blog-stazioni-sciistiche-ticino-credito-dati-2026': { name: 'Stazioni sciistiche', path: '/articoli-frontaliere/stazioni-sciistiche-ticino-credito-dati-2026', parent: 'blog' },
    'blog-lavori-notturni-via-clemente-maraini': { name: 'Lavori notturni', path: '/articoli-frontaliere/lavori-notturni-via-clemente-maraini', parent: 'blog' },
    'blog-parcheggi-ospedale-circolo-varese-2026': { name: 'Parcheggi e viabilità', path: '/articoli-frontaliere/parcheggi-ospedale-circolo-varese-2026', parent: 'blog' },
    'blog-mani-pulite-vite-salvate-asst-iniziativa': { name: 'Novità', path: '/articoli-frontaliere/mani-pulite-vite-salvate-asst-iniziativa', parent: 'blog' },
    'blog-manager-insubria-rasizza-battioni-4-maggio': { name: 'Novità', path: '/articoli-frontaliere/manager-insubria-rasizza-battioni-4-maggio', parent: 'blog' },
    'blog-lavoro-etico-convegno-liuc-ucid': { name: 'Convegno LIUC', path: '/articoli-frontaliere/lavoro-etico-convegno-liuc-ucid', parent: 'blog' },
    'blog-1maggio-eremo-monastero-legge-varese': { name: '1° maggio', path: '/articoli-frontaliere/1maggio-eremo-monastero-legge-varese', parent: 'blog' },
    'blog-vergiate-color-run-2026-non-competitiva': { name: 'Color Run Vergiate', path: '/articoli-frontaliere/vergiate-color-run-2026-non-competitiva', parent: 'blog' },
    'blog-due-scuole-due-mondi-un-solo-legame': { name: 'Mostra gemellaggio', path: '/articoli-frontaliere/due-scuole-due-mondi-un-solo-legame', parent: 'blog' },
    'blog-camion-incastrato-grantola-2026': { name: 'Novità', path: '/articoli-frontaliere/camion-incastrato-grantola-2026', parent: 'blog' },
    'blog-vedano-olona-medici-servizio-instabile': { name: 'Servizio medici', path: '/articoli-frontaliere/vedano-olona-medici-servizio-instabile', parent: 'blog' },
    'blog-elmec-innovation-summit-brunello-2026': { name: 'Elmec Innovation Summit', path: '/articoli-frontaliere/elmec-innovation-summit-brunello-2026', parent: 'blog' },
    'blog-scuola-austriaca-bitcoin-lugano-2026': { name: 'Scuola austriaca Lugano', path: '/articoli-frontaliere/scuola-austriaca-bitcoin-lugano-2026', parent: 'blog' },
    'blog-domus-san-donato-autonomia-terza-eta': { name: 'Novità', path: '/articoli-frontaliere/domus-san-donato-autonomia-terza-eta', parent: 'blog' },
    'blog-moda-sostenibile-varese-2026': { name: 'Moda sostenibile', path: '/articoli-frontaliere/moda-sostenibile-varese-2026', parent: 'blog' },
    'blog-sciopero-fame-timoc-terreno-conteso': { name: 'Novità', path: '/articoli-frontaliere/sciopero-fame-timoc-terreno-conteso', parent: 'blog' },
    'blog-ispra-pranzo-solidale-oratorio-2026': { name: 'Novità', path: '/articoli-frontaliere/ispra-pranzo-solidale-oratorio-2026', parent: 'blog' },
    'blog-malpensa-contanti-sequestri-370mila-euro': { name: 'Malpensa Contanti', path: '/articoli-frontaliere/malpensa-contanti-sequestri-370mila-euro', parent: 'blog' },
    'blog-grigioni-stretta-permessi-mafia-roveredo': { name: 'Novità', path: '/articoli-frontaliere/grigioni-stretta-permessi-mafia-roveredo', parent: 'blog' },
    'blog-restringimento-a2-ritardi-2026': { name: 'Novità', path: '/articoli-frontaliere/restringimento-a2-ritardi-2026', parent: 'blog' },
    'blog-repressione-cinese-svizzera-ong-critiche': { name: 'Novità', path: '/articoli-frontaliere/repressione-cinese-svizzera-ong-critiche', parent: 'blog' },
    'blog-traffico-intenso-a2-lugano-ritardi': { name: 'Traffico A2 Lugano', path: '/articoli-frontaliere/traffico-intenso-a2-lugano-ritardi', parent: 'blog' },
    'blog-ritardi-a2-tra-chiasso-lugano': { name: 'Traffico A2', path: '/articoli-frontaliere/ritardi-a2-tra-chiasso-lugano', parent: 'blog' },
    'blog-a2-corsia-ritardi-lugano-2026': { name: 'Novità', path: '/articoli-frontaliere/a2-corsia-ritardi-lugano-2026', parent: 'blog' },
    'blog-aquanexa-visita-acquedotto-alfa-laveno': { name: 'Novità', path: '/articoli-frontaliere/aquanexa-visita-acquedotto-alfa-laveno', parent: 'blog' },
    'blog-bollino-rosso-a2-chiasso-lugano-2026': { name: 'Novità', path: '/articoli-frontaliere/bollino-rosso-a2-chiasso-lugano-2026', parent: 'blog' },
    'blog-pnrr-disabilita-medio-olona-715mila-euro': { name: 'Novità', path: '/articoli-frontaliere/pnrr-disabilita-medio-olona-715mila-euro', parent: 'blog' },
    'blog-problemi-casellario-giudiziale-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/problemi-casellario-giudiziale-varese-2026', parent: 'blog' },
    'blog-comco-inchieste-pubblicita-online-2026': { name: 'Novità', path: '/articoli-frontaliere/comco-inchieste-pubblicita-online-2026', parent: 'blog' },
    'blog-glaciazione-demografica-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/glaciazione-demografica-ticino-2026', parent: 'blog' },
    'blog-a2-traffico-ritardi-lugano-2026': { name: 'Traffico A2', path: '/articoli-frontaliere/a2-traffico-ritardi-lugano-2026', parent: 'blog' },
    'blog-roberto-grassi-nuovo-presidente-liuc-castellanza': { name: 'Novità LIUC', path: '/articoli-frontaliere/roberto-grassi-nuovo-presidente-liuc-castellanza', parent: 'blog' },
    'blog-ia-selezione-personale-rischi-ticino': { name: 'IA nel lavoro', path: '/articoli-frontaliere/ia-selezione-personale-rischi-ticino', parent: 'blog' },
    'blog-denatalita-ticino-azione-urgente-2026': { name: 'Novità', path: '/articoli-frontaliere/denatalita-ticino-azione-urgente-2026', parent: 'blog' },
    'blog-beko-cassinetta-risultati-2026': { name: 'Novità', path: '/articoli-frontaliere/beko-cassinetta-risultati-2026', parent: 'blog' },
    'blog-samantha-bourgoin-apisuisse-2026': { name: 'Novità', path: '/articoli-frontaliere/samantha-bourgoin-apisuisse-2026', parent: 'blog' },
    'blog-birdwatching-monteviasco-2026': { name: 'Novità', path: '/articoli-frontaliere/birdwatching-monteviasco-2026', parent: 'blog' },
    'blog-gallarate-bilancio-cassani-2026': { name: 'Bilancio Gallarate', path: '/articoli-frontaliere/gallarate-bilancio-cassani-2026', parent: 'blog' },
    'blog-certificazione-greco-antico-lombardia-2026': { name: 'Novità', path: '/articoli-frontaliere/certificazione-greco-antico-lombardia-2026', parent: 'blog' },
    'blog-rokj-lugano-serata-solidale': { name: 'Eventi solidali', path: '/articoli-frontaliere/rokj-lugano-serata-solidale', parent: 'blog' },
    'blog-varese-fogliaro-san-giuseppe-2026': { name: 'Eventi Varese', path: '/articoli-frontaliere/varese-fogliaro-san-giuseppe-2026', parent: 'blog' },
    'blog-polizia-ticinese-fase-progettuale-conclusa': { name: 'Novità', path: '/articoli-frontaliere/polizia-ticinese-fase-progettuale-conclusa', parent: 'blog' },
    'blog-a2-melide-chiusure-notturne-lavori': { name: 'Novità', path: '/articoli-frontaliere/a2-melide-chiusure-notturne-lavori', parent: 'blog' },
    'blog-sanzioni-ue-imprese-italiane-2026': { name: 'Novità', path: '/articoli-frontaliere/sanzioni-ue-imprese-italiane-2026', parent: 'blog' },
    'blog-varese-lavoro-specializzato-paradosso-2026': { name: 'Novità', path: '/articoli-frontaliere/varese-lavoro-specializzato-paradosso-2026', parent: 'blog' },
    'blog-varese-competenze-lavoro-2026': { name: 'Mercato del lavoro', path: '/articoli-frontaliere/varese-competenze-lavoro-2026', parent: 'blog' },
    'blog-kof-barometro-ripresa-economica-2026': { name: 'Economia Svizzera', path: '/articoli-frontaliere/kof-barometro-ripresa-economica-2026', parent: 'blog' },
    'blog-parita-paura-frontalieri-ticino': { name: 'Parità di genere', path: '/articoli-frontaliere/parita-paura-frontalieri-ticino', parent: 'blog' },
    'blog-presunti-maltrattamenti-asilo-chiasso': { name: 'Novità', path: '/articoli-frontaliere/presunti-maltrattamenti-asilo-chiasso', parent: 'blog' },
    'blog-commercio-dettaglio-ricavi-ticino-2026': { name: 'Commercio dettaglio', path: '/articoli-frontaliere/commercio-dettaglio-ricavi-ticino-2026', parent: 'blog' },
    'blog-contibellinzona-2025-risultati': { name: 'Finanze comunali', path: '/articoli-frontaliere/contibellinzona-2025-risultati', parent: 'blog' },
    'blog-italia-inadempiente-crediti-sanitari': { name: 'Novità', path: '/articoli-frontaliere/italia-inadempiente-crediti-sanitari', parent: 'blog' },
    'blog-settore-alberghiero-ricavi-2025': { name: 'Novità', path: '/articoli-frontaliere/settore-alberghiero-ricavi-2025', parent: 'blog' },
    'blog-berna-skopje-scambi-economici-2026': { name: 'Novità', path: '/articoli-frontaliere/berna-skopje-scambi-economici-2026', parent: 'blog' },
    'blog-conti-bellinzona-2025-balzo-11-milioni': { name: 'Conti Bellinzona', path: '/articoli-frontaliere/conti-bellinzona-2025-balzo-11-milioni', parent: 'blog' },
    'blog-contibellinzona2025risultati': { name: 'Conti Bellinzona', path: '/articoli-frontaliere/contibellinzona2025risultati', parent: 'blog' },
    'blog-disoccupazione-ticino-usi-2026': { name: 'Novità', path: '/articoli-frontaliere/disoccupazione-ticino-usi-2026', parent: 'blog' },
    'blog-cessione-bper-bcc-varese-2026': { name: 'Cessione Bper-BCC', path: '/articoli-frontaliere/cessione-bper-bcc-varese-2026', parent: 'blog' },
    'blog-innalzamento-livello-verbano-impatti-economici': { name: 'Novità', path: '/articoli-frontaliere/innalzamento-livello-verbano-impatti-economici', parent: 'blog' },
    'blog-barometro-kof-ripresa-modesta-2026': { name: 'Economia Svizzera', path: '/articoli-frontaliere/barometro-kof-ripresa-modesta-2026', parent: 'blog' },
    'blog-inflazione-aprile-2026-italia': { name: 'Inflazione Italia', path: '/articoli-frontaliere/inflazione-aprile-2026-italia', parent: 'blog' },
    'blog-azienda-bardello-cerca-operatore-cnc': { name: 'Lavoro Bardello', path: '/articoli-frontaliere/azienda-bardello-cerca-operatore-cnc', parent: 'blog' },
    'blog-divario-irpef-pensionati-2026': { name: 'Fiscale', path: '/articoli-frontaliere/divario-irpef-pensionati-2026', parent: 'blog' },
    'blog-comco-inchieste-keyword-bidding-2026': { name: 'Novità', path: '/articoli-frontaliere/comco-inchieste-keyword-bidding-2026', parent: 'blog' },
    'blog-dezonamenti-ticino-2026-confronti': { name: 'Dezonamenti Ticino', path: '/articoli-frontaliere/dezonamenti-ticino-2026-confronti', parent: 'blog' },
    'blog-pizza-bibita-costi-citta': { name: 'Pizza e bibita', path: '/articoli-frontaliere/pizza-bibita-costi-citta', parent: 'blog' },
    'blog-education-day-confindustria-varese-2026': { name: 'Education Day', path: '/articoli-frontaliere/education-day-confindustria-varese-2026', parent: 'blog' },
    'blog-riforma-polizia-ticino-progetto-fermo': { name: 'Riforma polizia', path: '/articoli-frontaliere/riforma-polizia-ticino-progetto-fermo', parent: 'blog' },
    'blog-ffs-siemens-nuovi-treni-ticino': { name: 'Nuovi treni FFS', path: '/articoli-frontaliere/ffs-siemens-nuovi-treni-ticino', parent: 'blog' },
    'blog-passaporto-poste-italiane-uffici': { name: 'Novità', path: '/articoli-frontaliere/passaporto-poste-italiane-uffici', parent: 'blog' },
    'blog-comco-indaga-pubblicita-motori-ricerca': { name: 'Novità', path: '/articoli-frontaliere/comco-indaga-pubblicita-motori-ricerca', parent: 'blog' },
    'blog-record-passeggeri-treni-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/record-passeggeri-treni-svizzera-2026', parent: 'blog' },
    'blog-ferrovia-svizzera-300-progetti-2026': { name: 'Novità', path: '/articoli-frontaliere/ferrovia-svizzera-300-progetti-2026', parent: 'blog' },
    'blog-bce-tassi-invariati-30-aprile-2026': { name: 'Bce tassi', path: '/articoli-frontaliere/bce-tassi-invariati-30-aprile-2026', parent: 'blog' },
    'blog-aumenti-tariffe-sunrise-2026': { name: 'Novità', path: '/articoli-frontaliere/aumenti-tariffe-sunrise-2026', parent: 'blog' },
    'blog-settore-ict-ticino-riconoscimento-istituzioni': { name: 'Novità', path: '/articoli-frontaliere/settore-ict-ticino-riconoscimento-istituzioni', parent: 'blog' },
    'blog-bce-tassi-inflazione-ticino-2026': { name: 'Bce tassi', path: '/articoli-frontaliere/bce-tassi-inflazione-ticino-2026', parent: 'blog' },
    'blog-microterremoto-artificiale-ticino-2026': { name: 'Microterremoto artificiale', path: '/articoli-frontaliere/microterremoto-artificiale-ticino-2026', parent: 'blog' },
    'blog-flotilla-svizzera-gaza-2026': { name: 'Novità', path: '/articoli-frontaliere/flotilla-svizzera-gaza-2026', parent: 'blog' },
    'blog-clausole-sunrise-illegittime-2026': { name: 'Novità', path: '/articoli-frontaliere/clausole-sunrise-illegittime-2026', parent: 'blog' },
    'blog-lidl-formazione-duale-gdo-ticino': { name: 'Novità', path: '/articoli-frontaliere/lidl-formazione-duale-gdo-ticino', parent: 'blog' },
    'blog-lugano-red-carpet-contribuenti-2026': { name: 'Lugano contribuenti', path: '/articoli-frontaliere/lugano-red-carpet-contribuenti-2026', parent: 'blog' },
    'blog-trenord-disservizi-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/trenord-disservizi-frontalieri-2026', parent: 'blog' },
    'blog-pulmino-elettrico-granello-cislago-2026': { name: 'Novità', path: '/articoli-frontaliere/pulmino-elettrico-granello-cislago-2026', parent: 'blog' },
    'blog-ambrogio-castiglioni-digital-industries-world': { name: 'Novità', path: '/articoli-frontaliere/ambrogio-castiglioni-digital-industries-world', parent: 'blog' },
    'blog-aumento-spese-carburante-air-france-2026': { name: 'Air France', path: '/articoli-frontaliere/aumento-spese-carburante-air-france-2026', parent: 'blog' },
    'blog-trenord-ritardi-frontalieri-2026': { name: 'Trenord ritardi', path: '/articoli-frontaliere/trenord-ritardi-frontalieri-2026', parent: 'blog' },
    'blog-polizia-ticinese-progetto-concluso': { name: 'Novità', path: '/articoli-frontaliere/polizia-ticinese-progetto-concluso', parent: 'blog' },
    'blog-bike-sharing-como-gratis-giugno': { name: 'Bike sharing Como', path: '/articoli-frontaliere/bike-sharing-como-gratis-giugno', parent: 'blog' },
    'blog-guerra-iran-industria-alimentare-2026': { name: 'Novità', path: '/articoli-frontaliere/guerra-iran-industria-alimentare-2026', parent: 'blog' },
    'blog-rientro-a2-incubo-30-aprile-2026': { name: 'Traffico A2', path: '/articoli-frontaliere/rientro-a2-incubo-30-aprile-2026', parent: 'blog' },
    'blog-ultimo-giorno-funivia-santis-2026': { name: 'Funivia Säntis', path: '/articoli-frontaliere/ultimo-giorno-funivia-santis-2026', parent: 'blog' },
    'blog-primo-maggio-varese-acli-lavoro-dignitoso': { name: 'Primo Maggio', path: '/articoli-frontaliere/primo-maggio-varese-acli-lavoro-dignitoso', parent: 'blog' },
    'blog-crans-montana-700-dossier-consultori': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-700-dossier-consultori', parent: 'blog' },
    'blog-perequazione-ticino-frontalieri-2026': { name: 'Perequazione finanziaria', path: '/articoli-frontaliere/perequazione-ticino-frontalieri-2026', parent: 'blog' },
    'blog-viabilita-camion-travedona-2026': { name: 'Novità', path: '/articoli-frontaliere/viabilita-camion-travedona-2026', parent: 'blog' },
    'blog-casa-comunita-luino-punto-unico-accesso': { name: 'Novità', path: '/articoli-frontaliere/casa-comunita-luino-punto-unico-accesso', parent: 'blog' },
    'blog-bellinzona-2025-consuntivo-risultati': { name: 'Bellinzona 2025', path: '/articoli-frontaliere/bellinzona-2025-consuntivo-risultati', parent: 'blog' },
    'blog-iniziativa-democrazia-respinta-2026': { name: 'Iniziativa democrazia', path: '/articoli-frontaliere/iniziativa-democrazia-respinta-2026', parent: 'blog' },
    'blog-primo-maggio-varese-2026-storia-e-trasformazioni': { name: 'Primo Maggio', path: '/articoli-frontaliere/primo-maggio-varese-2026-storia-e-trasformazioni', parent: 'blog' },
    'blog-primo-bilancio-centri-violenza-2026': { name: 'Centri violenza', path: '/articoli-frontaliere/primo-bilancio-centri-violenza-2026', parent: 'blog' },
    'blog-addio-giovanni-salandin-cgil-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/addio-giovanni-salandin-cgil-frontalieri', parent: 'blog' },
    'blog-guardia-medica-como-ponte-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/guardia-medica-como-ponte-maggio-2026', parent: 'blog' },
    'blog-bilancio-provincia-varese-1-5-milioni': { name: 'Bilancio Provincia', path: '/articoli-frontaliere/bilancio-provincia-varese-1-5-milioni', parent: 'blog' },
    'blog-varese-citta-piu-verde-2026': { name: 'Varese verde', path: '/articoli-frontaliere/varese-citta-piu-verde-2026', parent: 'blog' },
    'blog-denuncia-strisce-pedonali-como-2026': { name: 'Denuncia Como', path: '/articoli-frontaliere/denuncia-strisce-pedonali-como-2026', parent: 'blog' },
    'blog-emergenza-acqua-lombardia-2026': { name: 'Novità', path: '/articoli-frontaliere/emergenza-acqua-lombardia-2026', parent: 'blog' },
    'blog-bambino-annegato-morcote-30-aprile-2026': { name: 'Novità', path: '/articoli-frontaliere/bambino-annegato-morcote-30-aprile-2026', parent: 'blog' },
    'blog-solaro-chiude-ambulatorio-medico': { name: 'Novità', path: '/articoli-frontaliere/solaro-chiude-ambulatorio-medico', parent: 'blog' },
    'blog-piano-pandemico-2025-2029-approvato': { name: 'Novità Sanità', path: '/articoli-frontaliere/piano-pandemico-2025-2029-approvato', parent: 'blog' },
    'blog-polizia-ticino-progetto-zali-comuni': { name: 'Polizia Ticino', path: '/articoli-frontaliere/polizia-ticino-progetto-zali-comuni', parent: 'blog' },
    'blog-ffs-siemens-116-treni-suburbani-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/ffs-siemens-116-treni-suburbani-ticino-2026', parent: 'blog' },
    'blog-chiusure-melide-autostrada-2026': { name: 'Chiusure notturne', path: '/articoli-frontaliere/chiusure-melide-autostrada-2026', parent: 'blog' },
    'blog-webuild-csc-rinnovo-sede-onu-ginevra': { name: 'Novità', path: '/articoli-frontaliere/webuild-csc-rinnovo-sede-onu-ginevra', parent: 'blog' },
    'blog-migranti-pasture-progetto-congelato': { name: 'Novità', path: '/articoli-frontaliere/migranti-pasture-progetto-congelato', parent: 'blog' },
    'blog-ricavi-alberghi-ticino-2025-crescita': { name: 'Novità', path: '/articoli-frontaliere/ricavi-alberghi-ticino-2025-crescita', parent: 'blog' },
    'blog-controllo-finanze-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/controllo-finanze-ticino-2026', parent: 'blog' },
    'blog-swiss-market-index-verde-2026': { name: 'Novità', path: '/articoli-frontaliere/swiss-market-index-verde-2026', parent: 'blog' },
    'blog-bcc-crowdfunding-100mila-euro': { name: 'Crowdfunding BCC', path: '/articoli-frontaliere/bcc-crowdfunding-100mila-euro', parent: 'blog' },
    'blog-truffatrice-seriale-como-lecco-2026': { name: 'Truffa Como', path: '/articoli-frontaliere/truffatrice-seriale-como-lecco-2026', parent: 'blog' },
    'blog-passaporto-musei-svizzera-30-anni-record': { name: 'Novità', path: '/articoli-frontaliere/passaporto-musei-svizzera-30-anni-record', parent: 'blog' },
    'blog-confindustria-como-arte-cultura-salute-13-maggio': { name: 'Evento Confindustria', path: '/articoli-frontaliere/confindustria-como-arte-cultura-salute-13-maggio', parent: 'blog' },
    'blog-sunrise-pratiche-abusive-fermate-2026': { name: 'Novità', path: '/articoli-frontaliere/sunrise-pratiche-abusive-fermate-2026', parent: 'blog' },
    'blog-proroga-accise-carburanti-2026': { name: 'Novità', path: '/articoli-frontaliere/proroga-accise-carburanti-2026', parent: 'blog' },
    'blog-polizia-ticinese-progetto-abbandonato-2026': { name: 'Novità', path: '/articoli-frontaliere/polizia-ticinese-progetto-abbandonato-2026', parent: 'blog' },
    'blog-summer-camp-malnate-tenuta-novella': { name: 'Summer camp', path: '/articoli-frontaliere/summer-camp-malnate-tenuta-novella', parent: 'blog' },
    'blog-liuc-golf-frontalieri-accordo-2026': { name: 'Novità', path: '/articoli-frontaliere/liuc-golf-frontalieri-accordo-2026', parent: 'blog' },
    'blog-pillola-giorno-dopo-vendita-libera-2026': { name: 'Novità', path: '/articoli-frontaliere/pillola-giorno-dopo-vendita-libera-2026', parent: 'blog' },
    'blog-isolino-virginia-riapre-2026': { name: 'Novità', path: '/articoli-frontaliere/isolino-virginia-riapre-2026', parent: 'blog' },
    'blog-sostenibilita-salone-csr-varese-2026': { name: 'Salone CSR Varese', path: '/articoli-frontaliere/sostenibilita-salone-csr-varese-2026', parent: 'blog' },
    'blog-film-the-sea-varese-gaza-2026': { name: 'Eventi culturali', path: '/articoli-frontaliere/film-the-sea-varese-gaza-2026', parent: 'blog' },
    'blog-crans-montana-nuovo-solco-italia-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-nuovo-solco-italia-svizzera-2026', parent: 'blog' },
    'blog-eurodreams-vincita-rendita-22mila-franchi': { name: 'Novità', path: '/articoli-frontaliere/eurodreams-vincita-rendita-22mila-franchi', parent: 'blog' },
    'blog-piano-casa-meloni-emergenza-abitativa': { name: 'Piano Casa', path: '/articoli-frontaliere/piano-casa-meloni-emergenza-abitativa', parent: 'blog' },
    'blog-targhe-personalizzabili-quadri-approvazione': { name: 'Novità', path: '/articoli-frontaliere/targhe-personalizzabili-quadri-approvazione', parent: 'blog' },
    'blog-trenord-indennizzi-pendolari-como-2026': { name: 'Novità', path: '/articoli-frontaliere/trenord-indennizzi-pendolari-como-2026', parent: 'blog' },
    'blog-ponte-brivio-cantiere-14-milioni': { name: 'Novità', path: '/articoli-frontaliere/ponte-brivio-cantiere-14-milioni', parent: 'blog' },
    'blog-ponte-maggio-villa-panza-laboratori-bambini': { name: 'Eventi culturali', path: '/articoli-frontaliere/ponte-maggio-villa-panza-laboratori-bambini', parent: 'blog' },
    'blog-furti-luoghi-culto-bellinzonese': { name: 'Furti nei luoghi di culto', path: '/articoli-frontaliere/furti-luoghi-culto-bellinzonese', parent: 'blog' },
    'blog-hockey-nl-psicodramma-davos-2025-2026-friborgogotteron': { name: 'Hockey Nl, Psicodramma Davos', path: '/articoli-frontaliere/hockey-nl-psicodramma-davos-2025-2026-friborgogotteron', parent: 'blog' },
    'blog-made-in-switzerland-2026': { name: 'Novità', path: '/articoli-frontaliere/made-in-switzerland-2026', parent: 'blog' },
    'blog-dialogo-popoli-colori-mondo-busto-arsizio': { name: 'Eventi interculturali', path: '/articoli-frontaliere/dialogo-popoli-colori-mondo-busto-arsizio', parent: 'blog' },
    'blog-cavalli-droni-esercito-svizzero-2026': { name: 'Novità', path: '/articoli-frontaliere/cavalli-droni-esercito-svizzero-2026', parent: 'blog' },
    'blog-raiffeisen-bioggio-rinnovo-2026': { name: 'Novità', path: '/articoli-frontaliere/raiffeisen-bioggio-rinnovo-2026', parent: 'blog' },
    'blog-percorso-giubiasco-qui-allora-2026': { name: 'Novità', path: '/articoli-frontaliere/percorso-giubiasco-qui-allora-2026', parent: 'blog' },
    'blog-nomina-docenti-comunali-ticino-2026': { name: 'Nomina docenti', path: '/articoli-frontaliere/nomina-docenti-comunali-ticino-2026', parent: 'blog' },
    'blog-cardano-settimana-ecologica-raee-2026': { name: 'Settimana Ecologica', path: '/articoli-frontaliere/cardano-settimana-ecologica-raee-2026', parent: 'blog' },
    'blog-grassi-liuc-sfide-complesse': { name: 'Novità', path: '/articoli-frontaliere/grassi-liuc-sfide-complesse', parent: 'blog' },
    'blog-ciclabile-saronno-rovello-porro-2026': { name: 'Ciclabile Saronno-Rovello Porro', path: '/articoli-frontaliere/ciclabile-saronno-rovello-porro-2026', parent: 'blog' },
    'blog-fiera-asparago-cantello-2026': { name: 'Eventi', path: '/articoli-frontaliere/fiera-asparago-cantello-2026', parent: 'blog' },
    'blog-cinque-cose-asparago-cantello-2026': { name: 'Asparago di Cantello', path: '/articoli-frontaliere/cinque-cose-asparago-cantello-2026', parent: 'blog' },
    'blog-sigarette-elettroniche-adolescenti-ticino-2026': { name: 'Sigarette elettroniche', path: '/articoli-frontaliere/sigarette-elettroniche-adolescenti-ticino-2026', parent: 'blog' },
    'blog-processo-bellinzona-merci-russia-2026': { name: 'Novità', path: '/articoli-frontaliere/processo-bellinzona-merci-russia-2026', parent: 'blog' },
    'blog-trump-riduce-truppe-italia-spagna': { name: 'Novità', path: '/articoli-frontaliere/trump-riduce-truppe-italia-spagna', parent: 'blog' },
    'blog-whisky-scozzese-dazi-trump-carlo-camilla': { name: 'Novità', path: '/articoli-frontaliere/whisky-scozzese-dazi-trump-carlo-camilla', parent: 'blog' },
    'blog-incidente-fino-mornasco-30-aprile-2026': { name: 'Incidente Fino Mornasco', path: '/articoli-frontaliere/incidente-fino-mornasco-30-aprile-2026', parent: 'blog' },
    'blog-galleria-gottardo-secondo-tubo-2026': { name: 'Novità', path: '/articoli-frontaliere/galleria-gottardo-secondo-tubo-2026', parent: 'blog' },
    'blog-varese-bilancio-2026-avanzo-record': { name: 'Bilancio Varese', path: '/articoli-frontaliere/varese-bilancio-2026-avanzo-record', parent: 'blog' },
    'blog-nuovo-direttore-controllo-finanze-ticino': { name: 'Novità', path: '/articoli-frontaliere/nuovo-direttore-controllo-finanze-ticino', parent: 'blog' },
    'blog-riapre-ufficio-postale-casale-litta': { name: 'Novità', path: '/articoli-frontaliere/riapre-ufficio-postale-casale-litta', parent: 'blog' },
    'blog-furti-chiese-negozi-ticino-arresti': { name: 'Novità', path: '/articoli-frontaliere/furti-chiese-negozi-ticino-arresti', parent: 'blog' },
    'blog-audit-polizia-ticino-2026': { name: 'Audit Polizia', path: '/articoli-frontaliere/audit-polizia-ticino-2026', parent: 'blog' },
    'blog-tassa-salute-frontalieri-lombardia-piemonte': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-frontalieri-lombardia-piemonte', parent: 'blog' },
    'blog-zonaprotetta-40-anni-sessualita-consapevole': { name: 'Novità', path: '/articoli-frontaliere/zonaprotetta-40-anni-sessualita-consapevole', parent: 'blog' },
    'blog-cina-turismo-interno-2026': { name: 'Novità', path: '/articoli-frontaliere/cina-turismo-interno-2026', parent: 'blog' },
    'blog-mondiali-2026-iran-italia-fifa': { name: 'Mondiali 2026', path: '/articoli-frontaliere/mondiali-2026-iran-italia-fifa', parent: 'blog' },
    'blog-crystal-palace-finale-conference-rayo': { name: 'Novità', path: '/articoli-frontaliere/crystal-palace-finale-conference-rayo', parent: 'blog' },
    'blog-trump-cina-russia-patto-2026': { name: 'Novità', path: '/articoli-frontaliere/trump-cina-russia-patto-2026', parent: 'blog' },
    'blog-primo-maggio-unita-sindacale-marghera': { name: 'Primo Maggio', path: '/articoli-frontaliere/primo-maggio-unita-sindacale-marghera', parent: 'blog' },
    'blog-primo-maggio-sindacati-piazza-2026': { name: 'Primo maggio', path: '/articoli-frontaliere/primo-maggio-sindacati-piazza-2026', parent: 'blog' },
    'blog-spasso-weekend-1-maggio-varese-2026': { name: 'Eventi Varese', path: '/articoli-frontaliere/spasso-weekend-1-maggio-varese-2026', parent: 'blog' },
    'blog-prevenzione-dipendenze-ticino-2026': { name: 'Prevenzione dipendenze', path: '/articoli-frontaliere/prevenzione-dipendenze-ticino-2026', parent: 'blog' },
    'blog-concertone-primo-maggio-roma-artisti-2026': { name: 'Concertone Primo Maggio', path: '/articoli-frontaliere/concertone-primo-maggio-roma-artisti-2026', parent: 'blog' },
    'blog-mondo-radio-piange-alberto-davoli': { name: 'Novità', path: '/articoli-frontaliere/mondo-radio-piange-alberto-davoli', parent: 'blog' },
    'blog-rendiconto-banca-interpretazione-2026': { name: 'Rendiconto banca', path: '/articoli-frontaliere/rendiconto-banca-interpretazione-2026', parent: 'blog' },
    'blog-inchiesta-arbitri-roccchi-inter-roma': { name: 'Inchiesta arbitri', path: '/articoli-frontaliere/inchiesta-arbitri-roccchi-inter-roma', parent: 'blog' },
    'blog-dramma-canton-ticino-bimbo-annega-piscina': { name: 'Dramma Ticino', path: '/articoli-frontaliere/dramma-canton-ticino-bimbo-annega-piscina', parent: 'blog' },
    'blog-gioco-oca-giornico-rischi-disastri': { name: 'Novità', path: '/articoli-frontaliere/gioco-oca-giornico-rischi-disastri', parent: 'blog' },
    'blog-primo-maggio-2026-ticino-solidarieta': { name: 'Primo Maggio 2026', path: '/articoli-frontaliere/primo-maggio-2026-ticino-solidarieta', parent: 'blog' },
    'blog-piano-freddo-como-200-persone-172-notti': { name: 'Piano Freddo Como', path: '/articoli-frontaliere/piano-freddo-como-200-persone-172-notti', parent: 'blog' },
    'blog-como-studenti-polizia-on-road-2026': { name: 'Novità', path: '/articoli-frontaliere/como-studenti-polizia-on-road-2026', parent: 'blog' },
    'blog-ticinosentieri-nuove-nomine-2026': { name: 'Novità TicinoSentieri', path: '/articoli-frontaliere/ticinosentieri-nuove-nomine-2026', parent: 'blog' },
    'blog-ufficio-postale-val-mara-chiusura': { name: 'Novità', path: '/articoli-frontaliere/ufficio-postale-val-mara-chiusura', parent: 'blog' },
    'blog-controversia-bandiera-svizzera-scarpe-on': { name: 'Novità', path: '/articoli-frontaliere/controversia-bandiera-svizzera-scarpe-on', parent: 'blog' },
    'blog-giovani-sigarette-elettroniche-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/giovani-sigarette-elettroniche-ticino-2026', parent: 'blog' },
    'blog-frontalieri-disoccupazione-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-disoccupazione-svizzera-2026', parent: 'blog' },
    'blog-cbt-italia-ciclisti-mercato': { name: 'Novità', path: '/articoli-frontaliere/cbt-italia-ciclisti-mercato', parent: 'blog' },
    'blog-maserati-tridente-centenario-2026': { name: 'Novità', path: '/articoli-frontaliere/maserati-tridente-centenario-2026', parent: 'blog' },
    'blog-iniziativa-10-milioni-sostenibile': { name: 'Iniziativa UDC', path: '/articoli-frontaliere/iniziativa-10-milioni-sostenibile', parent: 'blog' },
    'blog-click-fatture-servizio-hot': { name: 'Fatture ingiustificate', path: '/articoli-frontaliere/click-fatture-servizio-hot', parent: 'blog' },
    'blog-festa-fragole-camorino-beneficenza': { name: 'Festa fragole', path: '/articoli-frontaliere/festa-fragole-camorino-beneficenza', parent: 'blog' },
    'blog-lite-notturna-brogeda-2026': { name: 'Lite notturna', path: '/articoli-frontaliere/lite-notturna-brogeda-2026', parent: 'blog' },
    'blog-crans-montana-fatture-ospedali-2026': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-fatture-ospedali-2026', parent: 'blog' },
    'blog-crans-montana-aiuto-vittime-700-dossier': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-aiuto-vittime-700-dossier', parent: 'blog' },
    'blog-zanzara-tigre-losone-2026': { name: 'Novità', path: '/articoli-frontaliere/zanzara-tigre-losone-2026', parent: 'blog' },
    'blog-rive-libere-minusio-tenero-2026': { name: 'Rive libere', path: '/articoli-frontaliere/rive-libere-minusio-tenero-2026', parent: 'blog' },
    'blog-berna-senza-pubblicita-iniziativa-2026': { name: 'Iniziativa Berna senza pubblicità', path: '/articoli-frontaliere/berna-senza-pubblicita-iniziativa-2026', parent: 'blog' },
    'blog-lago-maggiore-sale-ambiente-2026': { name: 'Novità', path: '/articoli-frontaliere/lago-maggiore-sale-ambiente-2026', parent: 'blog' },
    'blog-25-centimetri-lago-maggiore-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/25-centimetri-lago-maggiore-frontalieri', parent: 'blog' },
    'blog-lungolago-como-parapetti-rapinese-sertori': { name: 'Lungolago Como', path: '/articoli-frontaliere/lungolago-como-parapetti-rapinese-sertori', parent: 'blog' },
    'blog-como-napoli-sinigaglia-divieti-posteggi': { name: 'Novità', path: '/articoli-frontaliere/como-napoli-sinigaglia-divieti-posteggi', parent: 'blog' },
    'blog-primo-maggio-varese-2026-lavoro-diritti': { name: 'Primo Maggio Varese', path: '/articoli-frontaliere/primo-maggio-varese-2026-lavoro-diritti', parent: 'blog' },
    'blog-algerini-libici-auto-polizia-arresti': { name: 'Notizie', path: '/articoli-frontaliere/algerini-libici-auto-polizia-arresti', parent: 'blog' },
    'blog-rete-stradale-mendrisio-interventi-urgenti': { name: 'Novità', path: '/articoli-frontaliere/rete-stradale-mendrisio-interventi-urgenti', parent: 'blog' },
    'blog-lavori-autostradali-a8-milano-varese': { name: 'Novità', path: '/articoli-frontaliere/lavori-autostradali-a8-milano-varese', parent: 'blog' },
    'blog-primo-maggio-2026-ticino-sindacati': { name: 'Primo Maggio 2026', path: '/articoli-frontaliere/primo-maggio-2026-ticino-sindacati', parent: 'blog' },
    'blog-como-arresto-frontaliere-tunisino': { name: 'Novità', path: '/articoli-frontaliere/como-arresto-frontaliere-tunisino', parent: 'blog' },
    'blog-indagine-soccorsi-crans-montana-2026': { name: 'Indagine soccorsi', path: '/articoli-frontaliere/indagine-soccorsi-crans-montana-2026', parent: 'blog' },
    'blog-crans-montana-italia-parte-civile-2026': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-italia-parte-civile-2026', parent: 'blog' },
    'blog-gysin-candidata-capogruppo-verdi': { name: 'Novità', path: '/articoli-frontaliere/gysin-candidata-capogruppo-verdi', parent: 'blog' },
    'blog-sesto-calende-strade-cantieri-2026': { name: 'Pratico', path: '/articoli-frontaliere/sesto-calende-strade-cantieri-2026', parent: 'blog' },
    'blog-jans-udc-iniziativa-10-milioni': { name: 'Novità', path: '/articoli-frontaliere/jans-udc-iniziativa-10-milioni', parent: 'blog' },
    'blog-lago-maggiore-135-metri-frontalieri': { name: 'Lago Maggiore', path: '/articoli-frontaliere/lago-maggiore-135-metri-frontalieri', parent: 'blog' },
    'blog-anziani-truffati-arresto-como-ticino': { name: 'Anziani truffati', path: '/articoli-frontaliere/anziani-truffati-arresto-como-ticino', parent: 'blog' },
    'blog-bellinzonesi-germania-karate-2026': { name: 'Novità', path: '/articoli-frontaliere/bellinzonesi-germania-karate-2026', parent: 'blog' },
    'blog-chiusura-notturna-a9-lomazzo-chiasso': { name: 'Chiusura notturna A9', path: '/articoli-frontaliere/chiusura-notturna-a9-lomazzo-chiasso', parent: 'blog' },
    'blog-como-festa-lavoro-diritti-salari': { name: 'Festa del Lavoro', path: '/articoli-frontaliere/como-festa-lavoro-diritti-salari', parent: 'blog' },
    'blog-denuncia-soccorsi-crans-montana-2026': { name: 'Denuncia soccorsi', path: '/articoli-frontaliere/denuncia-soccorsi-crans-montana-2026', parent: 'blog' },
    'blog-incidente-cantu-due-feriti': { name: 'Incidente Cantù', path: '/articoli-frontaliere/incidente-cantu-due-feriti', parent: 'blog' },
    'blog-primo-maggio-torino-tensioni-askatasuna': { name: 'Novità', path: '/articoli-frontaliere/primo-maggio-torino-tensioni-askatasuna', parent: 'blog' },
    'blog-142-violenza-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/142-violenza-ticino-2026', parent: 'blog' },
    'blog-primo-maggio-2026-traffico-gottardo': { name: 'Primo Maggio 2026', path: '/articoli-frontaliere/primo-maggio-2026-traffico-gottardo', parent: 'blog' },
    'blog-incidente-e-roller-lugano-2026': { name: 'Incidente Lugano', path: '/articoli-frontaliere/incidente-e-roller-lugano-2026', parent: 'blog' },
    'blog-processo-campione-dicembre-2026': { name: 'Processo Casino', path: '/articoli-frontaliere/processo-campione-dicembre-2026', parent: 'blog' },
    'blog-ingresso-gratuito-museo-costume-bagno': { name: 'Novità', path: '/articoli-frontaliere/ingresso-gratuito-museo-costume-bagno', parent: 'blog' },
    'blog-lavori-autostradali-a8-chiusure': { name: 'Novità', path: '/articoli-frontaliere/lavori-autostradali-a8-chiusure', parent: 'blog' },
    'blog-festa-danzante-ticino-2026-spettacoli': { name: 'Eventi Ticino', path: '/articoli-frontaliere/festa-danzante-ticino-2026-spettacoli', parent: 'blog' },
    'blog-pregassona-festa-400-fonio-iniziativa-udc': { name: 'Festa Pregassona', path: '/articoli-frontaliere/pregassona-festa-400-fonio-iniziativa-udc', parent: 'blog' },
    'blog-142-numero-aiuto-vittime-ticino': { name: '142 Ticino', path: '/articoli-frontaliere/142-numero-aiuto-vittime-ticino', parent: 'blog' },
    'blog-ponte-l-acqua-ticino-2026': { name: 'Meteo Ticino', path: '/articoli-frontaliere/ponte-l-acqua-ticino-2026', parent: 'blog' },
    'blog-nuovo-canile-varese-duni-2026': { name: 'Nuovo canile Varese', path: '/articoli-frontaliere/nuovo-canile-varese-duni-2026', parent: 'blog' },
    'blog-festa-fritti-glam-varese-2026': { name: 'Eventi Varese', path: '/articoli-frontaliere/festa-fritti-glam-varese-2026', parent: 'blog' },
    'blog-alta-mesolcina-sfida-movimento-2026': { name: 'Novità', path: '/articoli-frontaliere/alta-mesolcina-sfida-movimento-2026', parent: 'blog' },
    'blog-flotilla-gaza-varese-presidio-montegrappa': { name: 'Novità', path: '/articoli-frontaliere/flotilla-gaza-varese-presidio-montegrappa', parent: 'blog' },
    'blog-orso-valposchiavo-2026-ritorno': { name: 'Novità', path: '/articoli-frontaliere/orso-valposchiavo-2026-ritorno', parent: 'blog' },
    'blog-gallarate-borse-studio-2026': { name: 'Borse di studio', path: '/articoli-frontaliere/gallarate-borse-studio-2026', parent: 'blog' },
    'blog-primo-maggio-2026-ticino-sindacati-iniziativa-udc': { name: 'Novità', path: '/articoli-frontaliere/primo-maggio-2026-ticino-sindacati-iniziativa-udc', parent: 'blog' },
    'blog-lavoro-scende-piazza-lugano-2026': { name: '1° Maggio Lugano', path: '/articoli-frontaliere/lavoro-scende-piazza-lugano-2026', parent: 'blog' },
    'blog-radar-ticino-velocita-2026': { name: 'Controlli velocità', path: '/articoli-frontaliere/radar-ticino-velocita-2026', parent: 'blog' },
    'blog-primo-maggio-zurigo-basilea-2026': { name: 'Primo maggio 2026', path: '/articoli-frontaliere/primo-maggio-zurigo-basilea-2026', parent: 'blog' },
    'blog-rive-libere-ascona-2026': { name: 'Rive libere', path: '/articoli-frontaliere/rive-libere-ascona-2026', parent: 'blog' },
    'blog-mezzi-pesanti-biandronno-2026': { name: 'Novità', path: '/articoli-frontaliere/mezzi-pesanti-biandronno-2026', parent: 'blog' },
    'blog-trump-dazi-ue-frontalieri-ticino': { name: 'Dazi Trump', path: '/articoli-frontaliere/trump-dazi-ue-frontalieri-ticino', parent: 'blog' },
    'blog-balerna-consiglio-comunale-centenario': { name: 'Novità', path: '/articoli-frontaliere/balerna-consiglio-comunale-centenario', parent: 'blog' },
    'blog-confsal-manifesto-lavoro-dignita-salari': { name: 'Manifesto Confsal', path: '/articoli-frontaliere/confsal-manifesto-lavoro-dignita-salari', parent: 'blog' },
    'blog-usa-iran-nucleare-sanzioni-2026': { name: 'Novità', path: '/articoli-frontaliere/usa-iran-nucleare-sanzioni-2026', parent: 'blog' },
    'blog-sicurezza-locali-pubblici-convegno-ville-ponti': { name: 'Convegno sicurezza', path: '/articoli-frontaliere/sicurezza-locali-pubblici-convegno-ville-ponti', parent: 'blog' },
    'blog-sospetta-fuga-gas-londra-metro-chiusa': { name: 'Novità', path: '/articoli-frontaliere/sospetta-fuga-gas-londra-metro-chiusa', parent: 'blog' },
    'blog-cassis-aragchi-colloquio-iran': { name: 'Novità', path: '/articoli-frontaliere/cassis-aragchi-colloquio-iran', parent: 'blog' },
    'blog-colosso-35-tonnellate-legnano': { name: 'Novità', path: '/articoli-frontaliere/colosso-35-tonnellate-legnano', parent: 'blog' },
    'blog-riapre-villa-visconti-lainate-2026': { name: 'Villa Visconti Borromeo Litta', path: '/articoli-frontaliere/riapre-villa-visconti-lainate-2026', parent: 'blog' },
    'blog-teheran-proposta-pakistan-mediatori': { name: 'Novità', path: '/articoli-frontaliere/teheran-proposta-pakistan-mediatori', parent: 'blog' },
    'blog-inflazione-svizzera-frontalieri-ticino': { name: 'Inflazione Svizzera', path: '/articoli-frontaliere/inflazione-svizzera-frontalieri-ticino', parent: 'blog' },
    'blog-142-linea-aiuto-vittime-violenza-ticino': { name: 'Novità', path: '/articoli-frontaliere/142-linea-aiuto-vittime-violenza-ticino', parent: 'blog' },
    'blog-collisione-cadegliano-varese-ferito-54enne': { name: 'Incidente Cadegliano Viconago', path: '/articoli-frontaliere/collisione-cadegliano-varese-ferito-54enne', parent: 'blog' },
    'blog-congresso-lugano-cancro-prostata-2024': { name: 'Novità', path: '/articoli-frontaliere/congresso-lugano-cancro-prostata-2024', parent: 'blog' },
    'blog-circolo-albate-riapertura-2026': { name: 'Novità', path: '/articoli-frontaliere/circolo-albate-riapertura-2026', parent: 'blog' },
    'blog-aranno-incidente-moto-ricoverato-uomo': { name: 'Incidente Aranno', path: '/articoli-frontaliere/aranno-incidente-moto-ricoverato-uomo', parent: 'blog' },
    'blog-como-viaggio-nel-tempo-2026': { name: 'Como, viaggio nel tempo', path: '/articoli-frontaliere/como-viaggio-nel-tempo-2026', parent: 'blog' },
    'blog-como-volta-faro-rapinese-6-milioni': { name: 'Novità', path: '/articoli-frontaliere/como-volta-faro-rapinese-6-milioni', parent: 'blog' },
    'blog-controlli-velocita-ticino-maggio-2024': { name: 'Controlli velocità Ticino', path: '/articoli-frontaliere/controlli-velocita-ticino-maggio-2024', parent: 'blog' },
    'blog-primo-maggio-ticino-salari-2024': { name: 'Primo maggio Ticino', path: '/articoli-frontaliere/primo-maggio-ticino-salari-2024', parent: 'blog' },
    'blog-sosta-selvaggia-moltrasio-2026': { name: 'Sosta selvaggia', path: '/articoli-frontaliere/sosta-selvaggia-moltrasio-2026', parent: 'blog' },
    'blog-svizzera-hockey-sconfitta-svezia': { name: 'Novità', path: '/articoli-frontaliere/svizzera-hockey-sconfitta-svezia', parent: 'blog' },
    'blog-lambrugo-incidente-74enne-ospedale': { name: 'Incidente Lambrugo', path: '/articoli-frontaliere/lambrugo-incidente-74enne-ospedale', parent: 'blog' },
    'blog-delia-bella-ciao-concertone-2026': { name: 'Novità', path: '/articoli-frontaliere/delia-bella-ciao-concertone-2026', parent: 'blog' },
    'blog-funivia-santis-ammodernamento-2026': { name: 'Novità', path: '/articoli-frontaliere/funivia-santis-ammodernamento-2026', parent: 'blog' },
    'blog-cinque-curiosita-brevetti-svizzeri-2026': { name: 'Novità', path: '/articoli-frontaliere/cinque-curiosita-brevetti-svizzeri-2026', parent: 'blog' },
    'blog-liberta-stampa-minimi-25-anni': { name: 'Libertà stampa', path: '/articoli-frontaliere/liberta-stampa-minimi-25-anni', parent: 'blog' },
    'blog-villaggio-angelo-busto-arsizio': { name: 'Novità', path: '/articoli-frontaliere/villaggio-angelo-busto-arsizio', parent: 'blog' },
    'blog-chiese-ticino-derubate-2026': { name: 'Novità', path: '/articoli-frontaliere/chiese-ticino-derubate-2026', parent: 'blog' },
    'blog-sindacati-ticino-1-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/sindacati-ticino-1-maggio-2026', parent: 'blog' },
    'blog-polizia-ticino-abbandono-progetto-2026': { name: 'Novità', path: '/articoli-frontaliere/polizia-ticino-abbandono-progetto-2026', parent: 'blog' },
    'blog-tragedia-vico-morcote-bimbo-piscina': { name: 'Tragedia Vico Morcote', path: '/articoli-frontaliere/tragedia-vico-morcote-bimbo-piscina', parent: 'blog' },
    'blog-crans-montana-soccorso-denunciato': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-soccorso-denunciato', parent: 'blog' },
    'blog-ia-meteo-eventi-estremi': { name: 'Novità', path: '/articoli-frontaliere/ia-meteo-eventi-estremi', parent: 'blog' },
    'blog-tentato-assassinio-chiasso-2026': { name: 'Novità', path: '/articoli-frontaliere/tentato-assassinio-chiasso-2026', parent: 'blog' },
    'blog-primo-maggio-2026-svizzera-cortei': { name: 'Primo Maggio 2026', path: '/articoli-frontaliere/primo-maggio-2026-svizzera-cortei', parent: 'blog' },
    'blog-guardie-svizzere-2025-intenso': { name: 'Guardie svizzere', path: '/articoli-frontaliere/guardie-svizzere-2025-intenso', parent: 'blog' },
    'blog-siccit-estate-2026-ticino': { name: 'Novità', path: '/articoli-frontaliere/siccit-estate-2026-ticino', parent: 'blog' },
    'blog-polizia-ticino-progetto-abbandono-2026': { name: 'Polizia Ticino', path: '/articoli-frontaliere/polizia-ticino-progetto-abbandono-2026', parent: 'blog' },
    'blog-iniziativa-democrazia-respinta-nazionale': { name: 'Iniziativa respinta', path: '/articoli-frontaliere/iniziativa-democrazia-respinta-nazionale', parent: 'blog' },
    'blog-uisp-scuola-dante-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/uisp-scuola-dante-varese-2026', parent: 'blog' },
    'blog-ricostruzione-capanna-soveltra-avanza': { name: 'Novità', path: '/articoli-frontaliere/ricostruzione-capanna-soveltra-avanza', parent: 'blog' },
    'blog-processo-quadroni-ex-capo-posto-contesta-accuse': { name: 'Processo Quadroni', path: '/articoli-frontaliere/processo-quadroni-ex-capo-posto-contesta-accuse', parent: 'blog' },
    'blog-docente-arrestato-giubiasco-proroga': { name: 'Novità', path: '/articoli-frontaliere/docente-arrestato-giubiasco-proroga', parent: 'blog' },
    'blog-angelo-custode-ia-colpo-sonno': { name: 'Novità', path: '/articoli-frontaliere/angelo-custode-ia-colpo-sonno', parent: 'blog' },
    'blog-agenzia-formativa-varese-dimissioni-2026': { name: 'Novità', path: '/articoli-frontaliere/agenzia-formativa-varese-dimissioni-2026', parent: 'blog' },
    'blog-presentazione-libro-odio-massacro-varese': { name: 'Eventi culturali', path: '/articoli-frontaliere/presentazione-libro-odio-massacro-varese', parent: 'blog' },
    'blog-fattura-miliardaria-energia-2026': { name: 'Novità', path: '/articoli-frontaliere/fattura-miliardaria-energia-2026', parent: 'blog' },
    'blog-arco-e-frecce-per-far-centro': { name: 'Arco e frecce per far centro nel cuore', path: '/articoli-frontaliere/arco-e-frecce-per-far-centro', parent: 'blog' },
    'blog-museo-paesaggio-verbania-gratis-2026': { name: 'Museo del Paesaggio', path: '/articoli-frontaliere/museo-paesaggio-verbania-gratis-2026', parent: 'blog' },
    'blog-biandronno-incontro-astuti-licata-2026': { name: 'Incontro pubblico Biandronno', path: '/articoli-frontaliere/biandronno-incontro-astuti-licata-2026', parent: 'blog' },
    'blog-gratis-museo-costume-bagno-2026': { name: 'Novità', path: '/articoli-frontaliere/gratis-museo-costume-bagno-2026', parent: 'blog' },
    'blog-ippodromo-varese-svicc-allenatori': { name: 'Novità', path: '/articoli-frontaliere/ippodromo-varese-svicc-allenatori', parent: 'blog' },
    'blog-luigi-bignami-insubria-scienza-2026': { name: 'Novità', path: '/articoli-frontaliere/luigi-bignami-insubria-scienza-2026', parent: 'blog' },
    'blog-busto-arsizio-carcere-denuncia-strada': { name: 'Denuncia carcere', path: '/articoli-frontaliere/busto-arsizio-carcere-denuncia-strada', parent: 'blog' },
    'blog-bracconaggio-ittico-lago-maggiore-ispra-2026': { name: 'Bracconaggio ittico', path: '/articoli-frontaliere/bracconaggio-ittico-lago-maggiore-ispra-2026', parent: 'blog' },
    'blog-maggiolone-social-park-cassano-magnago': { name: 'Novità', path: '/articoli-frontaliere/maggiolone-social-park-cassano-magnago', parent: 'blog' },
    'blog-grassi-1925-marchio-storico': { name: 'Novità', path: '/articoli-frontaliere/grassi-1925-marchio-storico', parent: 'blog' },
    'blog-lati-industria-termoplastici-premiata-intesanpaolo': { name: 'Novità', path: '/articoli-frontaliere/lati-industria-termoplastici-premiata-intesanpaolo', parent: 'blog' },
    'blog-progettare-sala-riunioni-ufficio': { name: 'Progettazione sala riunioni', path: '/articoli-frontaliere/progettare-sala-riunioni-ufficio', parent: 'blog' },
    'blog-giovani-agenti-como-polizia-locale': { name: 'Novità', path: '/articoli-frontaliere/giovani-agenti-como-polizia-locale', parent: 'blog' },
    'blog-gallarate-fondazione-scuole-materne-2026': { name: 'Novità', path: '/articoli-frontaliere/gallarate-fondazione-scuole-materne-2026', parent: 'blog' },
    'blog-formula-1-riparte-rischi-polemiche': { name: 'Formula 1', path: '/articoli-frontaliere/formula-1-riparte-rischi-polemiche', parent: 'blog' },
    'blog-unitalsi-busto-varese-malati-spiritualita': { name: 'Unitalsi Busto e Varese', path: '/articoli-frontaliere/unitalsi-busto-varese-malati-spiritualita', parent: 'blog' },
    'blog-isola-artica-islanda-pugliese': { name: 'Novità', path: '/articoli-frontaliere/isola-artica-islanda-pugliese', parent: 'blog' },
    'blog-cioccolato-illumina-bellinzona-2026': { name: 'Novità Bellinzona', path: '/articoli-frontaliere/cioccolato-illumina-bellinzona-2026', parent: 'blog' },
    'blog-varese-luna-park-schiranna-2026': { name: 'Luna Park Schiranna', path: '/articoli-frontaliere/varese-luna-park-schiranna-2026', parent: 'blog' },
    'blog-mera-longhi-130-anni-dolcezza-varese': { name: 'Novità', path: '/articoli-frontaliere/mera-longhi-130-anni-dolcezza-varese', parent: 'blog' },
    'blog-girometta-doro-andrea-chiodi-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/girometta-doro-andrea-chiodi-varese-2026', parent: 'blog' },
    'blog-concerto-luino-vivaldi-bach-2026': { name: 'Concerto Luino', path: '/articoli-frontaliere/concerto-luino-vivaldi-bach-2026', parent: 'blog' },
    'blog-musica-antica-san-cassiano-2026': { name: 'Eventi Culturali', path: '/articoli-frontaliere/musica-antica-san-cassiano-2026', parent: 'blog' },
    'blog-cinque-mostre-maggio-gallarate-verbania-2026': { name: 'Mostre maggio 2026', path: '/articoli-frontaliere/cinque-mostre-maggio-gallarate-verbania-2026', parent: 'blog' },
    'blog-mal-dislanda-materia-castronno-2026': { name: 'Eventi', path: '/articoli-frontaliere/mal-dislanda-materia-castronno-2026', parent: 'blog' },
    'blog-frontaliere-pensione-avs-inps-2026-errori-comuni': { name: 'Pensione Frontalieri', path: '/articoli-frontaliere/frontaliere-pensione-avs-inps-2026-errori-comuni', parent: 'blog' },
    'blog-attivisti-flotilla-israele-interrogati': { name: 'Novità', path: '/articoli-frontaliere/attivisti-flotilla-israele-interrogati', parent: 'blog' },
    'blog-massiccio-intervento-polizia-lugano-2026': { name: 'Intervento polizia', path: '/articoli-frontaliere/massiccio-intervento-polizia-lugano-2026', parent: 'blog' },
    'blog-giovani-rematori-ceresio-2026': { name: 'Novità', path: '/articoli-frontaliere/giovani-rematori-ceresio-2026', parent: 'blog' },
    'blog-permesso-g-b-2026-20km-frontalieri': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/permesso-g-b-2026-20km-frontalieri', parent: 'blog' },
    'blog-cure-domicilio-pensionati-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/cure-domicilio-pensionati-ticino-2026', parent: 'blog' },
    'blog-libriamoci-varese-studenti-2026': { name: 'Concorso Libriamoci', path: '/articoli-frontaliere/libriamoci-varese-studenti-2026', parent: 'blog' },
    'blog-vino-alto-ticino-scudellate-2026': { name: 'Novità Ticino', path: '/articoli-frontaliere/vino-alto-ticino-scudellate-2026', parent: 'blog' },
    'blog-corteo-pro-palestina-lungolago-lugano': { name: 'Manifestazione Lugano', path: '/articoli-frontaliere/corteo-pro-palestina-lungolago-lugano', parent: 'blog' },
    'blog-divieti-social-media-minori': { name: 'Social media e minori', path: '/articoli-frontaliere/divieti-social-media-minori', parent: 'blog' },
    'blog-primo-maggio-baume-schneider-sanita-avs': { name: '1° maggio', path: '/articoli-frontaliere/primo-maggio-baume-schneider-sanita-avs', parent: 'blog' },
    'blog-migros-immigrazione-necessaria-offerta': { name: 'Novità', path: '/articoli-frontaliere/migros-immigrazione-necessaria-offerta', parent: 'blog' },
    'blog-vico-morcote-tragedia-bambino-pool': { name: 'Novità', path: '/articoli-frontaliere/vico-morcote-tragedia-bambino-pool', parent: 'blog' },
    'blog-limiti-eta-smartphone-social-media': { name: 'Novità', path: '/articoli-frontaliere/limiti-eta-smartphone-social-media', parent: 'blog' },
    'blog-volandia-battesimo-volo-elicottero-2026': { name: 'Volandia 2026', path: '/articoli-frontaliere/volandia-battesimo-volo-elicottero-2026', parent: 'blog' },
    'blog-banche-golfo-preparano-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/banche-golfo-preparano-frontalieri', parent: 'blog' },
    'blog-papa-paperino-cuasso-monte': { name: 'Novità', path: '/articoli-frontaliere/papa-paperino-cuasso-monte', parent: 'blog' },
    'blog-venezia-serie-a-promozione-2026': { name: 'Novità', path: '/articoli-frontaliere/venezia-serie-a-promozione-2026', parent: 'blog' },
    'blog-meloni-governo-longevo-2026': { name: 'Novità', path: '/articoli-frontaliere/meloni-governo-longevo-2026', parent: 'blog' },
    'blog-abbonamento-newsletter-ticino': { name: 'Newsletter Ticino', path: '/articoli-frontaliere/abbonamento-newsletter-ticino', parent: 'blog' },
    'blog-varese-arrampicata-salewa-cube-2026': { name: 'Novità', path: '/articoli-frontaliere/varese-arrampicata-salewa-cube-2026', parent: 'blog' },
    'blog-migros-immigrazione-necessaria-2026': { name: 'Novità', path: '/articoli-frontaliere/migros-immigrazione-necessaria-2026', parent: 'blog' },
    'blog-nuova-viabilit-travedona-monate-2026': { name: 'Viabilità Travedona Monate', path: '/articoli-frontaliere/nuova-viabilit-travedona-monate-2026', parent: 'blog' },
    'blog-graudio-flash-2-maggio-2026': { name: 'Notizie Canton Ticino', path: '/articoli-frontaliere/graudio-flash-2-maggio-2026', parent: 'blog' },
    'blog-investimenti-immobiliari-italia-estero-2026': { name: 'Investimenti immobiliari', path: '/articoli-frontaliere/investimenti-immobiliari-italia-estero-2026', parent: 'blog' },
    'blog-carenza-carburante-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/carenza-carburante-svizzera-2026', parent: 'blog' },
    'blog-ermotti-respinge-accuse-lobbying-ubs': { name: 'Novità', path: '/articoli-frontaliere/ermotti-respinge-accuse-lobbying-ubs', parent: 'blog' },
    'blog-addio-alex-zanardi-2001-incidente-vita': { name: 'Novità', path: '/articoli-frontaliere/addio-alex-zanardi-2001-incidente-vita', parent: 'blog' },
    'blog-caronno-varesino-campetto-dante-mercanti-2026': { name: 'Novità', path: '/articoli-frontaliere/caronno-varesino-campetto-dante-mercanti-2026', parent: 'blog' },
    'blog-confederazione-valuta-sistemi-difesa-aerea': { name: 'Novità', path: '/articoli-frontaliere/confederazione-valuta-sistemi-difesa-aerea', parent: 'blog' },
    'blog-penuria-carburante-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/penuria-carburante-svizzera-2026', parent: 'blog' },
    'blog-vittoria-bagatin-tappa-turchia': { name: 'Sport', path: '/articoli-frontaliere/vittoria-bagatin-tappa-turchia', parent: 'blog' },
    'blog-taglio-accise-carburanti-22-maggio': { name: 'Novità', path: '/articoli-frontaliere/taglio-accise-carburanti-22-maggio', parent: 'blog' },
    'blog-aiuti-svizzera-ucraina-2026': { name: 'Novità', path: '/articoli-frontaliere/aiuti-svizzera-ucraina-2026', parent: 'blog' },
    'blog-bus-elettrici-lugano-problemi-utenti': { name: 'Novità', path: '/articoli-frontaliere/bus-elettrici-lugano-problemi-utenti', parent: 'blog' },
    'blog-gala-sorriso-solidarieta-ospedale-del-ponte': { name: 'Galà del Sorriso', path: '/articoli-frontaliere/gala-sorriso-solidarieta-ospedale-del-ponte', parent: 'blog' },
    'blog-varese-incendio-palazzo-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/varese-incendio-palazzo-frontalieri', parent: 'blog' },
    'blog-carenza-carburante-svizzera-frontalieri': { name: 'Carenza carburante', path: '/articoli-frontaliere/carenza-carburante-svizzera-frontalieri', parent: 'blog' },
    'blog-scontro-polizia-lugano-spray-urticante': { name: 'Novità', path: '/articoli-frontaliere/scontro-polizia-lugano-spray-urticante', parent: 'blog' },
    'blog-saronno-bar-licenza-sospesa-rissa': { name: 'Novità', path: '/articoli-frontaliere/saronno-bar-licenza-sospesa-rissa', parent: 'blog' },
    'blog-movieri-traffico-ss340-2026': { name: 'Novità', path: '/articoli-frontaliere/movieri-traffico-ss340-2026', parent: 'blog' },
    'blog-doppietta-frontalieri-santonino-2026': { name: 'Doppietta frontalieri', path: '/articoli-frontaliere/doppietta-frontalieri-santonino-2026', parent: 'blog' },
    'blog-taglio-accise-carburanti-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/taglio-accise-carburanti-maggio-2026', parent: 'blog' },
    'blog-yoga-meditazione-villa-lago-como': { name: 'Yoga e meditazione', path: '/articoli-frontaliere/yoga-meditazione-villa-lago-como', parent: 'blog' },
    'blog-como-cantu-creativity-week-2026': { name: 'Novità', path: '/articoli-frontaliere/como-cantu-creativity-week-2026', parent: 'blog' },
    'blog-commercio-al-dettaglio-mini-flessione-marzo-2026': { name: 'Novità', path: '/articoli-frontaliere/commercio-al-dettaglio-mini-flessione-marzo-2026', parent: 'blog' },
    'blog-rissa-lugano-pensilina-botta-feriti-2026': { name: 'Novità', path: '/articoli-frontaliere/rissa-lugano-pensilina-botta-feriti-2026', parent: 'blog' },
    'blog-rissa-lugano-primo-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/rissa-lugano-primo-maggio-2026', parent: 'blog' },
    'blog-protezione-vittime-142-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/protezione-vittime-142-ticino-2026', parent: 'blog' },
    'blog-golasecca-esplorazione-passeggiata-2026': { name: 'Golasecca', path: '/articoli-frontaliere/golasecca-esplorazione-passeggiata-2026', parent: 'blog' },
    'blog-marcia-zurigo-disabilita-uguaglianza': { name: 'Novità', path: '/articoli-frontaliere/marcia-zurigo-disabilita-uguaglianza', parent: 'blog' },
    'blog-nuovi-posti-moto-lago-como': { name: 'Nuovi posti moto', path: '/articoli-frontaliere/nuovi-posti-moto-lago-como', parent: 'blog' },
    'blog-guardia-medica-somma-lombardo-lonate-pozzolo': { name: 'Novità', path: '/articoli-frontaliere/guardia-medica-somma-lombardo-lonate-pozzolo', parent: 'blog' },
    'blog-panchina-bianca-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/panchina-bianca-varese-2026', parent: 'blog' },
    'blog-furti-chiese-bellinzonese-arresti-2026': { name: 'Furti in chiese', path: '/articoli-frontaliere/furti-chiese-bellinzonese-arresti-2026', parent: 'blog' },
    'blog-a4-milano-brescia-diviazione-obbligatoria-2026': { name: 'Viabilità', path: '/articoli-frontaliere/a4-milano-brescia-diviazione-obbligatoria-2026', parent: 'blog' },
    'blog-editto-canonizzazione-don-roberto-malgesini': { name: 'Editto canonizzazione', path: '/articoli-frontaliere/editto-canonizzazione-don-roberto-malgesini', parent: 'blog' },
    'blog-beat-jans-10-milioni-comunicazione': { name: 'Novità', path: '/articoli-frontaliere/beat-jans-10-milioni-comunicazione', parent: 'blog' },
    'blog-a4-milano-brescia-chiusura-notturna-2026': { name: 'Novità', path: '/articoli-frontaliere/a4-milano-brescia-chiusura-notturna-2026', parent: 'blog' },
    'blog-via-giannino-landoni-fagnano-olona-inaugurazione': { name: 'Novità', path: '/articoli-frontaliere/via-giannino-landoni-fagnano-olona-inaugurazione', parent: 'blog' },
    'blog-scontri-lugano-pensilina-2024': { name: 'Scontri Lugano', path: '/articoli-frontaliere/scontri-lugano-pensilina-2024', parent: 'blog' },
    'blog-gordola-santa-maria-ricorso-2026': { name: 'Novità Gordola', path: '/articoli-frontaliere/gordola-santa-maria-ricorso-2026', parent: 'blog' },
    'blog-vino-amaro-vallese-2026': { name: 'Vino amaro in Vallese', path: '/articoli-frontaliere/vino-amaro-vallese-2026', parent: 'blog' },
    'blog-beatificazione-don-roberto-malgesini-2026': { name: 'Beatificazione don Roberto Malgesini', path: '/articoli-frontaliere/beatificazione-don-roberto-malgesini-2026', parent: 'blog' },
    'blog-lago-segrino-camper-2026': { name: 'Novità', path: '/articoli-frontaliere/lago-segrino-camper-2026', parent: 'blog' },
    'blog-cavalli-esercito-svizzero-costi': { name: 'Novità', path: '/articoli-frontaliere/cavalli-esercito-svizzero-costi', parent: 'blog' },
    'blog-svizzera-hockey-sconfitta-finlandia': { name: 'Novità', path: '/articoli-frontaliere/svizzera-hockey-sconfitta-finlandia', parent: 'blog' },
    'blog-pd-como-sfiducia-maccabeo-2026': { name: 'Novità', path: '/articoli-frontaliere/pd-como-sfiducia-maccabeo-2026', parent: 'blog' },
    'blog-patriot-ritardo-svizzera-valuta-alternative': { name: 'Novità', path: '/articoli-frontaliere/patriot-ritardo-svizzera-valuta-alternative', parent: 'blog' },
    'blog-bambini-carabinieri-como-2026': { name: 'Novità', path: '/articoli-frontaliere/bambini-carabinieri-como-2026', parent: 'blog' },
    'blog-incendio-malpensa-terminal-1-2-maggio-2026': { name: 'Incendio Malpensa', path: '/articoli-frontaliere/incendio-malpensa-terminal-1-2-maggio-2026', parent: 'blog' },
    'blog-parcheggio-abusivo-como-villa-olmo': { name: 'Novità', path: '/articoli-frontaliere/parcheggio-abusivo-como-villa-olmo', parent: 'blog' },
    'blog-svizzera-caccia-evasori-fiscali-2026': { name: 'Fiscale', path: '/articoli-frontaliere/svizzera-caccia-evasori-fiscali-2026', parent: 'blog' },
    'blog-landsgemeinde-glarona-2026': { name: 'Landsgemeinde Glarona', path: '/articoli-frontaliere/landsgemeinde-glarona-2026', parent: 'blog' },
    'blog-aeroporto-lugano-costi-interpellanza': { name: 'Interpellanza Municipio', path: '/articoli-frontaliere/aeroporto-lugano-costi-interpellanza', parent: 'blog' },
    'blog-agricoltura-ticino-allarme-2024': { name: 'Novità', path: '/articoli-frontaliere/agricoltura-ticino-allarme-2024', parent: 'blog' },
    'blog-seco-dazi-segreti-washington': { name: 'Novità', path: '/articoli-frontaliere/seco-dazi-segreti-washington', parent: 'blog' },
    'blog-frontaliere-cambio-chf-eur-strategia-2026-simulazione-pratica': { name: 'Strategia cambio CHF-EUR', path: '/articoli-frontaliere/frontaliere-cambio-chf-eur-strategia-2026-simulazione-pratica', parent: 'blog' },
    'blog-laghi-lombardi-sicurezza-estate-2026': { name: 'Novità', path: '/articoli-frontaliere/laghi-lombardi-sicurezza-estate-2026', parent: 'blog' },
    'blog-riforma-commissioni-federali-2026': { name: 'Riforma commissioni', path: '/articoli-frontaliere/riforma-commissioni-federali-2026', parent: 'blog' },
    'blog-piogge-intense-ceresio-2026': { name: 'Novità', path: '/articoli-frontaliere/piogge-intense-ceresio-2026', parent: 'blog' },
    'blog-incendio-langnau-due-case-garage': { name: 'Incendio Langnau', path: '/articoli-frontaliere/incendio-langnau-due-case-garage', parent: 'blog' },
    'blog-domenica-corriere-piccaluga-lavoro-salari-economia': { name: 'Novità', path: '/articoli-frontaliere/domenica-corriere-piccaluga-lavoro-salari-economia', parent: 'blog' },
    'blog-campagna-iraniana-allarma-svizzera': { name: 'Novità', path: '/articoli-frontaliere/campagna-iraniana-allarma-svizzera', parent: 'blog' },
    'blog-area-sosta-fantasma-sicurezza-autostrada': { name: 'Novità', path: '/articoli-frontaliere/area-sosta-fantasma-sicurezza-autostrada', parent: 'blog' },
    'blog-aumento-prezzi-carburanti-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/aumento-prezzi-carburanti-maggio-2026', parent: 'blog' },
    'blog-incendio-bellinzona-appartamento-evacuato': { name: 'Incendio Bellinzona', path: '/articoli-frontaliere/incendio-bellinzona-appartamento-evacuato', parent: 'blog' },
    'blog-permesso-g-vs-b-2026-famiglia-figli': { name: 'Permesso G vs B', path: '/articoli-frontaliere/permesso-g-vs-b-2026-famiglia-figli', parent: 'blog' },
    'blog-incendio-bellinzona-via-borromini-evacuati': { name: 'Incendio Bellinzona', path: '/articoli-frontaliere/incendio-bellinzona-via-borromini-evacuati', parent: 'blog' },
    'blog-polizia-bandi-4500-posti-2026': { name: 'Novità', path: '/articoli-frontaliere/polizia-bandi-4500-posti-2026', parent: 'blog' },
    'blog-casse-malati-alloggi-landsgemeinde-2026': { name: 'Novità', path: '/articoli-frontaliere/casse-malati-alloggi-landsgemeinde-2026', parent: 'blog' },
    'blog-dancing-shoes-albertoni-cinelli-collaboration': { name: 'Novità', path: '/articoli-frontaliere/dancing-shoes-albertoni-cinelli-collaboration', parent: 'blog' },
    'blog-landsgemeinde-glarona-2026-finanze-alloggi': { name: 'Landsgemeinde Glarona', path: '/articoli-frontaliere/landsgemeinde-glarona-2026-finanze-alloggi', parent: 'blog' },
    'blog-como-vivibile-frontalieri-2026': { name: 'Como vivibile', path: '/articoli-frontaliere/como-vivibile-frontalieri-2026', parent: 'blog' },
    'blog-calcio-dnb-bellinzona-ultimo-appello': { name: 'Calcio Dnb', path: '/articoli-frontaliere/calcio-dnb-bellinzona-ultimo-appello', parent: 'blog' },
    'blog-parcheggi-cernobbio-ticino-residenti': { name: 'Parcheggi Cernobbio', path: '/articoli-frontaliere/parcheggi-cernobbio-ticino-residenti', parent: 'blog' },
    'blog-vandalismo-bar-bellinzona-2026': { name: 'Vandalismo Bellinzona', path: '/articoli-frontaliere/vandalismo-bar-bellinzona-2026', parent: 'blog' },
    'blog-brebbia-19enne-grave-incidente-fabbrica': { name: 'Incidente Brebbia', path: '/articoli-frontaliere/brebbia-19enne-grave-incidente-fabbrica', parent: 'blog' },
    'blog-aeroporto-lugano-costi-interpellanza-2025': { name: 'Aeroporto Lugano', path: '/articoli-frontaliere/aeroporto-lugano-costi-interpellanza-2025', parent: 'blog' },
    'blog-incendio-malpensa-terminal-1-risolto': { name: 'Incendio Malpensa', path: '/articoli-frontaliere/incendio-malpensa-terminal-1-risolto', parent: 'blog' },
    'blog-maillard-uss-udc-iniziativa-1-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/maillard-uss-udc-iniziativa-1-maggio-2026', parent: 'blog' },
    'blog-cervelat-salsiccia-nazionale-svizzera': { name: 'Cervelat', path: '/articoli-frontaliere/cervelat-salsiccia-nazionale-svizzera', parent: 'blog' },
    'blog-amare-politica-luino-2026': { name: 'Novità', path: '/articoli-frontaliere/amare-politica-luino-2026', parent: 'blog' },
    'blog-cassis-araghchi-colloquio-2026': { name: 'Novità', path: '/articoli-frontaliere/cassis-araghchi-colloquio-2026', parent: 'blog' },
    'blog-corsi-vela-adulti-luino-avav-2026': { name: 'Novità', path: '/articoli-frontaliere/corsi-vela-adulti-luino-avav-2026', parent: 'blog' },
    'blog-incendio-bellinzona-via-borromini-evacuati-10-persone': { name: 'Incendio Bellinzona', path: '/articoli-frontaliere/incendio-bellinzona-via-borromini-evacuati-10-persone', parent: 'blog' },
    'blog-agricoltura-ticino-prodotti-locali-eventi-2026': { name: 'Novità', path: '/articoli-frontaliere/agricoltura-ticino-prodotti-locali-eventi-2026', parent: 'blog' },
    'blog-turismo-como-frontalieri-2026': { name: 'Turismo e Periferie', path: '/articoli-frontaliere/turismo-como-frontalieri-2026', parent: 'blog' },
    'blog-omegna-ciclista-precipita-scarpata-ricovero-rosso': { name: 'Novità', path: '/articoli-frontaliere/omegna-ciclista-precipita-scarpata-ricovero-rosso', parent: 'blog' },
    'blog-usa-missili-germania-2026': { name: 'Novità', path: '/articoli-frontaliere/usa-missili-germania-2026', parent: 'blog' },
    'blog-mensa-solidarieta-degrado-sicurezza-2026': { name: 'Mensa solidarietà', path: '/articoli-frontaliere/mensa-solidarieta-degrado-sicurezza-2026', parent: 'blog' },
    'blog-laboratorio-estivo-museo-moesano-2026': { name: 'Laboratorio estivo', path: '/articoli-frontaliere/laboratorio-estivo-museo-moesano-2026', parent: 'blog' },
    'blog-varese-lago-perduto-memoria-comunita': { name: 'Mostra Fotografica', path: '/articoli-frontaliere/varese-lago-perduto-memoria-comunita', parent: 'blog' },
    'blog-rischi-petrolio-lugano-3-maggio-2026': { name: 'Marcia lenta a Lugano', path: '/articoli-frontaliere/rischi-petrolio-lugano-3-maggio-2026', parent: 'blog' },
    'blog-lavori-a9-lomazzo-saronno-chiusura-notte': { name: 'A9 chiusura notturna', path: '/articoli-frontaliere/lavori-a9-lomazzo-saronno-chiusura-notte', parent: 'blog' },
    'blog-petrolio-uccide-protesta-vezia-2026': { name: 'Protesta Vezia', path: '/articoli-frontaliere/petrolio-uccide-protesta-vezia-2026', parent: 'blog' },
    'blog-sun-valley-festival-malvaglia-2026': { name: 'Sun Valley Festival', path: '/articoli-frontaliere/sun-valley-festival-malvaglia-2026', parent: 'blog' },
    'blog-pulizia-lago-lemano-2026': { name: 'Pulizia Lago Lemano', path: '/articoli-frontaliere/pulizia-lago-lemano-2026', parent: 'blog' },
    'blog-crans-montana-fondi-avvocati-vittime': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-fondi-avvocati-vittime', parent: 'blog' },
    'blog-disordini-pensilina-botta-lugano-2026': { name: 'Disordini Lugano', path: '/articoli-frontaliere/disordini-pensilina-botta-lugano-2026', parent: 'blog' },
    'blog-scontri-pensilina-lugano-violenza': { name: 'Scontri Lugano', path: '/articoli-frontaliere/scontri-pensilina-lugano-violenza', parent: 'blog' },
    'blog-neutalia-bilancio-2025-crescita-ricavi': { name: 'Novità', path: '/articoli-frontaliere/neutalia-bilancio-2025-crescita-ricavi', parent: 'blog' },
    'blog-life-run-gallarate-2026-successo': { name: 'Life Run 2026', path: '/articoli-frontaliere/life-run-gallarate-2026-successo', parent: 'blog' },
    'blog-usa-petrolio-export-hormuz-impatti-ticino': { name: 'Novità', path: '/articoli-frontaliere/usa-petrolio-export-hormuz-impatti-ticino', parent: 'blog' },
    'blog-marchirolo-primo-maggio-2026': { name: 'Eventi locali', path: '/articoli-frontaliere/marchirolo-primo-maggio-2026', parent: 'blog' },
    'blog-schianto-a9-turate-feriti-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/schianto-a9-turate-feriti-frontalieri', parent: 'blog' },
    'blog-inter-scudetto-chivu-2026': { name: 'Inter campione', path: '/articoli-frontaliere/inter-scudetto-chivu-2026', parent: 'blog' },
    'blog-tragedia-lago-como-frontalieri': { name: 'Tragedia lago di Como', path: '/articoli-frontaliere/tragedia-lago-como-frontalieri', parent: 'blog' },
    'blog-incidente-autolaghi-donna-ferita': { name: 'Incidente Autolaghi', path: '/articoli-frontaliere/incidente-autolaghi-donna-ferita', parent: 'blog' },
    'blog-incidente-a9-turate-feriti-frontalieri': { name: 'Incidente A9 Turate', path: '/articoli-frontaliere/incidente-a9-turate-feriti-frontalieri', parent: 'blog' },
    'blog-varese-trento-playoff-basket-2026': { name: 'Basket playoff', path: '/articoli-frontaliere/varese-trento-playoff-basket-2026', parent: 'blog' },
    'blog-varese-caduta-canale-frontaliere': { name: 'Novità', path: '/articoli-frontaliere/varese-caduta-canale-frontaliere', parent: 'blog' },
    'blog-incidente-a2-lodrino-frontalieri': { name: 'Incidente A2 Lodrino', path: '/articoli-frontaliere/incidente-a2-lodrino-frontalieri', parent: 'blog' },
    'blog-league-ticino-border-closure-proposal-2026': { name: 'Novità', path: '/articoli-frontaliere/league-ticino-border-closure-proposal-2026', parent: 'blog' },
    'blog-petrolio-gas-sicuro-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/petrolio-gas-sicuro-ticino-2026', parent: 'blog' },
    'blog-negoziati-stallo-iran-usa-2026': { name: 'Novità', path: '/articoli-frontaliere/negoziati-stallo-iran-usa-2026', parent: 'blog' },
    'blog-inter-scudetto-2026-frontalieri': { name: 'Inter campione', path: '/articoli-frontaliere/inter-scudetto-2026-frontalieri', parent: 'blog' },
    'blog-austriaci-ferma-verifica-2026': { name: 'Novità', path: '/articoli-frontaliere/austriaci-ferma-verifica-2026', parent: 'blog' },
    'blog-statua-volta-como-2026': { name: 'Novità', path: '/articoli-frontaliere/statua-volta-como-2026', parent: 'blog' },
    'blog-scia-luminosa-ticino-2026': { name: 'Scia luminosa', path: '/articoli-frontaliere/scia-luminosa-ticino-2026', parent: 'blog' },
    'blog-fiaccola-sacconago-speranza-amicizia': { name: 'Novità', path: '/articoli-frontaliere/fiaccola-sacconago-speranza-amicizia', parent: 'blog' },
    'blog-ingorgo-taxi-boat-como-2026': { name: 'Novità', path: '/articoli-frontaliere/ingorgo-taxi-boat-como-2026', parent: 'blog' },
    'blog-controlli-cantu-movida-nero-2026': { name: 'Novità', path: '/articoli-frontaliere/controlli-cantu-movida-nero-2026', parent: 'blog' },
    'blog-como-napoli-pareggio-2026': { name: 'Como-Napoli 2026', path: '/articoli-frontaliere/como-napoli-pareggio-2026', parent: 'blog' },
    'blog-varese-incontro-violenza-psicologica-disturbi-alimentari': { name: 'Incontro Varese', path: '/articoli-frontaliere/varese-incontro-violenza-psicologica-disturbi-alimentari', parent: 'blog' },
    'blog-retromarcia-contromano-faido-chiggiogna-2026': { name: 'Sicurezza stradale', path: '/articoli-frontaliere/retromarcia-contromano-faido-chiggiogna-2026', parent: 'blog' },
    'blog-lugano-young-boys-cornaredo-2026': { name: 'Calcio Ticino', path: '/articoli-frontaliere/lugano-young-boys-cornaredo-2026', parent: 'blog' },
    'blog-tragedia-falleatsche-frontalieri': { name: 'Tragedia Fallätsche', path: '/articoli-frontaliere/tragedia-falleatsche-frontalieri', parent: 'blog' },
    'blog-verbania-clandestino-espulsione-2026': { name: 'Novità', path: '/articoli-frontaliere/verbania-clandestino-espulsione-2026', parent: 'blog' },
    'blog-cof-lanzo-igiene-mani-2026': { name: 'Novità', path: '/articoli-frontaliere/cof-lanzo-igiene-mani-2026', parent: 'blog' },
    'blog-grasshopper-zeidler-allenatore-2026': { name: 'Novità', path: '/articoli-frontaliere/grasshopper-zeidler-allenatore-2026', parent: 'blog' },
    'blog-disordini-pensilina-lugano-intervento-veloce': { name: 'Disordini Lugano', path: '/articoli-frontaliere/disordini-pensilina-lugano-intervento-veloce', parent: 'blog' },
    'blog-disordini-pensilina-lugano-intervento-veloce-2026': { name: 'Novità', path: '/articoli-frontaliere/disordini-pensilina-lugano-intervento-veloce-2026', parent: 'blog' },
    'blog-teresina-cerini-100-anni-coglio': { name: 'Novità', path: '/articoli-frontaliere/teresina-cerini-100-anni-coglio', parent: 'blog' },
    'blog-svizzera-cechia-rigori-4-maggio-2026': { name: 'Sport', path: '/articoli-frontaliere/svizzera-cechia-rigori-4-maggio-2026', parent: 'blog' },
    'blog-orso-valposchiavo-frontalieri-2026': { name: 'Orso Valposchiavo', path: '/articoli-frontaliere/orso-valposchiavo-frontalieri-2026', parent: 'blog' },
    'blog-thun-campionato-calcio-2026': { name: 'Novità', path: '/articoli-frontaliere/thun-campionato-calcio-2026', parent: 'blog' },
    'blog-scudetto-varese-frontalieri-2026': { name: 'Scudetto Inter', path: '/articoli-frontaliere/scudetto-varese-frontalieri-2026', parent: 'blog' },
    'blog-anguria-pannelli-incendio-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/anguria-pannelli-incendio-ticino-2026', parent: 'blog' },
    'blog-tiro-sportivo-veterani-junghi-2026': { name: 'Tiro Sportivo', path: '/articoli-frontaliere/tiro-sportivo-veterani-junghi-2026', parent: 'blog' },
    'blog-fc-thun-campionato-2026-ticino': { name: 'Novità', path: '/articoli-frontaliere/fc-thun-campionato-2026-ticino', parent: 'blog' },
    'blog-incidente-maloja-frontaliere-2026': { name: 'Novità', path: '/articoli-frontaliere/incidente-maloja-frontaliere-2026', parent: 'blog' },
    'blog-thun-campionato-calcio-2026-festa-thun': { name: 'Novità', path: '/articoli-frontaliere/thun-campionato-calcio-2026-festa-thun', parent: 'blog' },
    'blog-varese-playoff-lavagnese-2026': { name: 'Varese playoff', path: '/articoli-frontaliere/varese-playoff-lavagnese-2026', parent: 'blog' },
    'blog-casa-hockey-ticino-novita': { name: 'Novità Hockey Ticino', path: '/articoli-frontaliere/casa-hockey-ticino-novita', parent: 'blog' },
    'blog-tessile-arte-giovani-generazioni-como': { name: 'Novità', path: '/articoli-frontaliere/tessile-arte-giovani-generazioni-como', parent: 'blog' },
    'blog-crans-montana-incendio-riciclaggio-2026': { name: 'Crans-Montana', path: '/articoli-frontaliere/crans-montana-incendio-riciclaggio-2026', parent: 'blog' },
    'blog-antonelli-vince-gp-miami-2026': { name: 'Formula 1', path: '/articoli-frontaliere/antonelli-vince-gp-miami-2026', parent: 'blog' },
    'blog-tre-morti-hantavirus-nave-atlantico': { name: 'Novità', path: '/articoli-frontaliere/tre-morti-hantavirus-nave-atlantico', parent: 'blog' },
    'blog-juve-verona-1-1-frontalieri-2026': { name: 'Calcio e Frontalieri', path: '/articoli-frontaliere/juve-verona-1-1-frontalieri-2026', parent: 'blog' },
    'blog-immigrazione-modello-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/immigrazione-modello-svizzera-2026', parent: 'blog' },
    'blog-csoa-molino-rimozione-macerie-lugano': { name: 'Novità', path: '/articoli-frontaliere/csoa-molino-rimozione-macerie-lugano', parent: 'blog' },
    'blog-incidente-riazzino-ciclista-condanna': { name: 'Novità', path: '/articoli-frontaliere/incidente-riazzino-ciclista-condanna', parent: 'blog' },
    'blog-sergi-presidenza-basket-ticino-2026': { name: 'Basket Ticino', path: '/articoli-frontaliere/sergi-presidenza-basket-ticino-2026', parent: 'blog' },
    'blog-ginnastica-artistica-ticino-2026': { name: 'Ginnastica artistica', path: '/articoli-frontaliere/ginnastica-artistica-ticino-2026', parent: 'blog' },
    'blog-italia-sospetti-var-minetti-quirinale': { name: 'Novità', path: '/articoli-frontaliere/italia-sospetti-var-minetti-quirinale', parent: 'blog' },
    'blog-azzate-koningsdag-console-olandese-2026': { name: 'Eventi', path: '/articoli-frontaliere/azzate-koningsdag-console-olandese-2026', parent: 'blog' },
    'blog-confine-vacallo-clandestini-2026': { name: 'Confine Vacallo', path: '/articoli-frontaliere/confine-vacallo-clandestini-2026', parent: 'blog' },
    'blog-morte-alex-zanardi-impatti-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/morte-alex-zanardi-impatti-frontalieri', parent: 'blog' },
    'blog-premio-walo-2026-frontalieri': { name: 'Premio Walo', path: '/articoli-frontaliere/premio-walo-2026-frontalieri', parent: 'blog' },
    'blog-stresa-espulsione-egiziano-2026': { name: 'Novità', path: '/articoli-frontaliere/stresa-espulsione-egiziano-2026', parent: 'blog' },
    'blog-stati-canaglia-2026-aggiornamento-lista': { name: 'Novità', path: '/articoli-frontaliere/stati-canaglia-2026-aggiornamento-lista', parent: 'blog' },
    'blog-melenchon-candidatura-presidenziali-2027': { name: 'Politica', path: '/articoli-frontaliere/melenchon-candidatura-presidenziali-2027', parent: 'blog' },
    'blog-lugano-renato-steffen-goal-staffa': { name: 'Sport', path: '/articoli-frontaliere/lugano-renato-steffen-goal-staffa', parent: 'blog' },
    'blog-tribunale-federale-giudici-conviventi-2026': { name: 'Novità', path: '/articoli-frontaliere/tribunale-federale-giudici-conviventi-2026', parent: 'blog' },
    'blog-varese-celebra-san-vittore-girometta-oro-2026': { name: 'Varese celebra San Vittore', path: '/articoli-frontaliere/varese-celebra-san-vittore-girometta-oro-2026', parent: 'blog' },
    'blog-iran-invita-sacrificio-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/iran-invita-sacrificio-frontalieri-2026', parent: 'blog' },
    'blog-piccaluga-udc-dialogo-apertura': { name: 'Novità', path: '/articoli-frontaliere/piccaluga-udc-dialogo-apertura', parent: 'blog' },
    'blog-bonifici-ritardo-frontalieri-ticino': { name: 'Guida pratica', path: '/articoli-frontaliere/bonifici-ritardo-frontalieri-ticino', parent: 'blog' },
    'blog-noleggio-auto-frontalieri-ticino-2026': { name: 'Noleggio auto', path: '/articoli-frontaliere/noleggio-auto-frontalieri-ticino-2026', parent: 'blog' },
    'blog-aargau-festnahmen-2-mag-2026': { name: 'Novità', path: '/articoli-frontaliere/aargau-festnahmen-2-mag-2026', parent: 'blog' },
    'blog-gambarogno-contributi-costruzione-ricorrenti': { name: 'Contributi costruzione', path: '/articoli-frontaliere/gambarogno-contributi-costruzione-ricorrenti', parent: 'blog' },
    'blog-lavena-brano-musicale-leone-xiv': { name: 'Evento musicale', path: '/articoli-frontaliere/lavena-brano-musicale-leone-xiv', parent: 'blog' },
    'blog-giornata-liberta-stampa-unesco-minacce-autocensura': { name: 'Novità', path: '/articoli-frontaliere/giornata-liberta-stampa-unesco-minacce-autocensura', parent: 'blog' },
    'blog-russotto-bellinzona-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/russotto-bellinzona-frontalieri-2026', parent: 'blog' },
    'blog-democrazia-finisce-quando-ticino': { name: 'Novità', path: '/articoli-frontaliere/democrazia-finisce-quando-ticino', parent: 'blog' },
    'blog-belotti-sport-test-scarpe-trail-running-2026': { name: 'Eventi sportivi', path: '/articoli-frontaliere/belotti-sport-test-scarpe-trail-running-2026', parent: 'blog' },
    'blog-pericoli-minori-iniziativa-10-milioni': { name: 'Novità', path: '/articoli-frontaliere/pericoli-minori-iniziativa-10-milioni', parent: 'blog' },
    'blog-agrinatura-sold-out-2026': { name: 'Agrinatura 2026', path: '/articoli-frontaliere/agrinatura-sold-out-2026', parent: 'blog' },
    'blog-mezzo-milione-luganese-sviluppo-2026': { name: 'Novità', path: '/articoli-frontaliere/mezzo-milione-luganese-sviluppo-2026', parent: 'blog' },
    'blog-raccolti-2000-euro-parco-matteo': { name: 'Raccolta fondi', path: '/articoli-frontaliere/raccolti-2000-euro-parco-matteo', parent: 'blog' },
    'blog-moleno-piazza-green-chiesa-migliorata': { name: 'Novità', path: '/articoli-frontaliere/moleno-piazza-green-chiesa-migliorata', parent: 'blog' },
    'blog-arresto-frauenfeld-30enne-barricato': { name: 'Novità', path: '/articoli-frontaliere/arresto-frauenfeld-30enne-barricato', parent: 'blog' },
    'blog-mercato-lavoro-kof-ripresa-2026': { name: 'Novità', path: '/articoli-frontaliere/mercato-lavoro-kof-ripresa-2026', parent: 'blog' },
    'blog-vendite-auto-ticino-2026-stabili-elettrico': { name: 'Novità', path: '/articoli-frontaliere/vendite-auto-ticino-2026-stabili-elettrico', parent: 'blog' },
    'blog-indice-pmi-svizzera-ottimismo-2026': { name: 'Novità', path: '/articoli-frontaliere/indice-pmi-svizzera-ottimismo-2026', parent: 'blog' },
    'blog-campo-talenti-tenero-25-anni': { name: 'Novità', path: '/articoli-frontaliere/campo-talenti-tenero-25-anni', parent: 'blog' },
    'blog-aeroporto-zurigo-traffico-crescita-2026': { name: 'Novità', path: '/articoli-frontaliere/aeroporto-zurigo-traffico-crescita-2026', parent: 'blog' },
    'blog-ffs-ascensione-pentecoste-2026': { name: 'Novità', path: '/articoli-frontaliere/ffs-ascensione-pentecoste-2026', parent: 'blog' },
    'blog-stralugano-percorsi-frontalieri-2026': { name: 'StraLugano 2026', path: '/articoli-frontaliere/stralugano-percorsi-frontalieri-2026', parent: 'blog' },
    'blog-camelie-locarno-record-visitatori-2026': { name: 'Eventi Ticino', path: '/articoli-frontaliere/camelie-locarno-record-visitatori-2026', parent: 'blog' },
    'blog-disastri-museo-leventina-gioco-oca': { name: 'Novità', path: '/articoli-frontaliere/disastri-museo-leventina-gioco-oca', parent: 'blog' },
    'blog-ndrangheta-ticino-antimafia-italiana': { name: 'Novità', path: '/articoli-frontaliere/ndrangheta-ticino-antimafia-italiana', parent: 'blog' },
    'blog-nuove-accise-carburanti-2026': { name: 'Nuove accise carburanti', path: '/articoli-frontaliere/nuove-accise-carburanti-2026', parent: 'blog' },
    'blog-ponti-primaverili-traffico-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/ponti-primaverili-traffico-ticino-2026', parent: 'blog' },
    'blog-lidl-svizzera-ceo-elvetico': { name: 'Novità', path: '/articoli-frontaliere/lidl-svizzera-ceo-elvetico', parent: 'blog' },
    'blog-calcio-alpino-ticino-2026': { name: 'Torneo Alge Alp Sport', path: '/articoli-frontaliere/calcio-alpino-ticino-2026', parent: 'blog' },
    'blog-ponti-primaverili-traffico-2026': { name: 'Ponti primaverili', path: '/articoli-frontaliere/ponti-primaverili-traffico-2026', parent: 'blog' },
    'blog-perbacco-bianchi-bellinzona-2026': { name: 'Eventi Ticino', path: '/articoli-frontaliere/perbacco-bianchi-bellinzona-2026', parent: 'blog' },
    'blog-bianconeri-corto-muso-2026': { name: 'Novità', path: '/articoli-frontaliere/bianconeri-corto-muso-2026', parent: 'blog' },
    'blog-stangata-nascosta-tasse-immobiliari': { name: 'Tasse immobiliari', path: '/articoli-frontaliere/stangata-nascosta-tasse-immobiliari', parent: 'blog' },
    'blog-caro-benzina-varese-accise-2026': { name: 'Caro benzina', path: '/articoli-frontaliere/caro-benzina-varese-accise-2026', parent: 'blog' },
    'blog-meloni-cooperazione-mediterraneo-immigrazione': { name: 'Novità', path: '/articoli-frontaliere/meloni-cooperazione-mediterraneo-immigrazione', parent: 'blog' },
    'blog-nuovo-questore-varese-sicurezza-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/nuovo-questore-varese-sicurezza-frontalieri', parent: 'blog' },
    'blog-nuovo-questore-varese-sicurezza-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/nuovo-questore-varese-sicurezza-frontalieri-2026', parent: 'blog' },
    'blog-franzolini-fenealuil-piano-casa': { name: 'Novità', path: '/articoli-frontaliere/franzolini-fenealuil-piano-casa', parent: 'blog' },
    'blog-parco-biumo-inaugurazione-2026': { name: 'Inaugurazione parco Biumo', path: '/articoli-frontaliere/parco-biumo-inaugurazione-2026', parent: 'blog' },
    'blog-parcheggi-blu-como-residenti': { name: 'Parcheggi blu Como', path: '/articoli-frontaliere/parcheggi-blu-como-residenti', parent: 'blog' },
    'blog-proposte-cernobbio-2026-tessile': { name: 'Proposte 2026', path: '/articoli-frontaliere/proposte-cernobbio-2026-tessile', parent: 'blog' },
    'blog-confisca-preventiva-mafie-svizzera': { name: 'Novità', path: '/articoli-frontaliere/confisca-preventiva-mafie-svizzera', parent: 'blog' },
    'blog-ospedale-erba-cura-oncologiche-2026': { name: 'Novità', path: '/articoli-frontaliere/ospedale-erba-cura-oncologiche-2026', parent: 'blog' },
    'blog-mezzo-milione-franchi-progetti-luganese-2026': { name: 'Novità', path: '/articoli-frontaliere/mezzo-milione-franchi-progetti-luganese-2026', parent: 'blog' },
    'blog-tragedia-bellinzona-folgorazione-2026': { name: 'Novità', path: '/articoli-frontaliere/tragedia-bellinzona-folgorazione-2026', parent: 'blog' },
    'blog-sicurezza-varese-monte-santo-intervento-comune': { name: 'Novità Varese', path: '/articoli-frontaliere/sicurezza-varese-monte-santo-intervento-comune', parent: 'blog' },
    'blog-arresto-albanese-cocaina-capolago': { name: 'Novità', path: '/articoli-frontaliere/arresto-albanese-cocaina-capolago', parent: 'blog' },
    'blog-banca-grigionese-denuncia-centinaia-milioni': { name: 'Novità', path: '/articoli-frontaliere/banca-grigionese-denuncia-centinaia-milioni', parent: 'blog' },
    'blog-parcheggi-blu-como-residenti-difficolta': { name: 'Parcheggi Como', path: '/articoli-frontaliere/parcheggi-blu-como-residenti-difficolta', parent: 'blog' },
    'blog-gallarate-fs-security-2027': { name: 'Novità sicurezza', path: '/articoli-frontaliere/gallarate-fs-security-2027', parent: 'blog' },
    'blog-incendio-chiasso-palazzina-evacuati-30': { name: 'Incendio Chiasso', path: '/articoli-frontaliere/incendio-chiasso-palazzina-evacuati-30', parent: 'blog' },
    'blog-mcdonalds-lamone-apertura-2026': { name: 'Novità', path: '/articoli-frontaliere/mcdonalds-lamone-apertura-2026', parent: 'blog' },
    'blog-maxi-piano-traffico-lago-como-2026': { name: 'Novità', path: '/articoli-frontaliere/maxi-piano-traffico-lago-como-2026', parent: 'blog' },
    'blog-incendio-chiasso-evacuati-trentina-persone': { name: 'Incendio Chiasso', path: '/articoli-frontaliere/incendio-chiasso-evacuati-trentina-persone', parent: 'blog' },
    'blog-lotta-zanzara-tigre-mendrisio': { name: 'Lotta zanzara tigre', path: '/articoli-frontaliere/lotta-zanzara-tigre-mendrisio', parent: 'blog' },
    'blog-inaugurato-nuovo-cardiocentro-ticino': { name: 'Novità', path: '/articoli-frontaliere/inaugurato-nuovo-cardiocentro-ticino', parent: 'blog' },
    'blog-guardia-finanza-carburanti-como-2026': { name: 'Novità', path: '/articoli-frontaliere/guardia-finanza-carburanti-como-2026', parent: 'blog' },
    'blog-nuovo-centenario-chiasso-luciano-bordignon': { name: 'Novità', path: '/articoli-frontaliere/nuovo-centenario-chiasso-luciano-bordignon', parent: 'blog' },
    'blog-g7-evian-frontiere-chiuse-2026': { name: 'G7 Evian', path: '/articoli-frontaliere/g7-evian-frontiere-chiuse-2026', parent: 'blog' },
    'blog-distributori-carburante-ticino-2026': { name: 'Pratico', path: '/articoli-frontaliere/distributori-carburante-ticino-2026', parent: 'blog' },
    'blog-dona-spesa-nova-coop-2026': { name: 'Solidarietà', path: '/articoli-frontaliere/dona-spesa-nova-coop-2026', parent: 'blog' },
    'blog-littizzetto-critica-svizzera-crans-montana': { name: 'Novità', path: '/articoli-frontaliere/littizzetto-critica-svizzera-crans-montana', parent: 'blog' },
    'blog-fondazione-cariplo-varese-5-milioni-2025': { name: 'Novità', path: '/articoli-frontaliere/fondazione-cariplo-varese-5-milioni-2025', parent: 'blog' },
    'blog-varese-milano-rallentamenti-treni-maggio-2026': { name: 'Trasporti', path: '/articoli-frontaliere/varese-milano-rallentamenti-treni-maggio-2026', parent: 'blog' },
    'blog-controlli-carburanti-como-guardia-finanza': { name: 'Novità', path: '/articoli-frontaliere/controlli-carburanti-como-guardia-finanza', parent: 'blog' },
    'blog-banca-piazza-petruzzella-abt-2026': { name: 'Novità', path: '/articoli-frontaliere/banca-piazza-petruzzella-abt-2026', parent: 'blog' },
    'blog-swiss-market-index-crescita-2026': { name: 'Novità', path: '/articoli-frontaliere/swiss-market-index-crescita-2026', parent: 'blog' },
    'blog-comco-keyword-bidding-inchieste': { name: 'Novità', path: '/articoli-frontaliere/comco-keyword-bidding-inchieste', parent: 'blog' },
    'blog-autolaghi-chiusura-barriere-antirumore-2026': { name: 'Novità', path: '/articoli-frontaliere/autolaghi-chiusura-barriere-antirumore-2026', parent: 'blog' },
    'blog-festa-mamma-solidarieta-2026': { name: 'Festa della mamma', path: '/articoli-frontaliere/festa-mamma-solidarieta-2026', parent: 'blog' },
    'blog-a8-chiusure-gallarate-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/a8-chiusure-gallarate-frontalieri', parent: 'blog' },
    'blog-costi-aeroporto-lugano-2026': { name: 'Aeroporto Lugano', path: '/articoli-frontaliere/costi-aeroporto-lugano-2026', parent: 'blog' },
    'blog-ladies-run-lugano-2026': { name: 'Ladies Run Ticino 2026', path: '/articoli-frontaliere/ladies-run-lugano-2026', parent: 'blog' },
    'blog-crans-montana-meloni-parmelin-2026': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-meloni-parmelin-2026', parent: 'blog' },
    'blog-gabbiano-bonaparte-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/gabbiano-bonaparte-ticino-2026', parent: 'blog' },
    'blog-buoni-ristorante-mamme-monoparentali-ticino': { name: 'Buoni ristoranti', path: '/articoli-frontaliere/buoni-ristorante-mamme-monoparentali-ticino', parent: 'blog' },
    'blog-incendio-chiasso-operai-ricoverati': { name: 'Incendio Chiasso', path: '/articoli-frontaliere/incendio-chiasso-operai-ricoverati', parent: 'blog' },
    'blog-hodler-dipinto-eredita-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/hodler-dipinto-eredita-frontalieri', parent: 'blog' },
    'blog-staffette-rossocrociate-pechino-2027': { name: 'Novità', path: '/articoli-frontaliere/staffette-rossocrociate-pechino-2027', parent: 'blog' },
    'blog-ecolight-camarda-presidente-2026-2028': { name: 'Novità', path: '/articoli-frontaliere/ecolight-camarda-presidente-2026-2028', parent: 'blog' },
    'blog-boom-viaggiatori-treni-2026-ticino': { name: 'Novità', path: '/articoli-frontaliere/boom-viaggiatori-treni-2026-ticino', parent: 'blog' },
    'blog-neutralizzazione-stime-immobiliari-2026': { name: 'Neutralizzazione stime immobiliari', path: '/articoli-frontaliere/neutralizzazione-stime-immobiliari-2026', parent: 'blog' },
    'blog-neutralizzazione-stime-immobiliari-2026-ticino': { name: 'Neutralizzazione stime', path: '/articoli-frontaliere/neutralizzazione-stime-immobiliari-2026-ticino', parent: 'blog' },
    'blog-barometro-kof-aprile-2026-prospettive-modeste': { name: 'Novità', path: '/articoli-frontaliere/barometro-kof-aprile-2026-prospettive-modeste', parent: 'blog' },
    'blog-elicottero-mezzovico-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/elicottero-mezzovico-frontalieri', parent: 'blog' },
    'blog-ospedale-universitario-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/ospedale-universitario-ticino-2026', parent: 'blog' },
    'blog-legge-quadro-florovivaismo-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/legge-quadro-florovivaismo-varese-2026', parent: 'blog' },
    'blog-policonsumo-ticino-2026': { name: 'Policonsumo droga', path: '/articoli-frontaliere/policonsumo-ticino-2026', parent: 'blog' },
    'blog-crack-house-ingrado-2026': { name: 'Crack house Ticino', path: '/articoli-frontaliere/crack-house-ingrado-2026', parent: 'blog' },
    'blog-jashari-milan-bocciatura': { name: 'Novità', path: '/articoli-frontaliere/jashari-milan-bocciatura', parent: 'blog' },
    'blog-mendrisio-senso-citta-rossini-lorenzon': { name: 'Novità', path: '/articoli-frontaliere/mendrisio-senso-citta-rossini-lorenzon', parent: 'blog' },
    'blog-incendio-chiasso-operai-feriti': { name: 'Novità', path: '/articoli-frontaliere/incendio-chiasso-operai-feriti', parent: 'blog' },
    'blog-luino-bilancio-2025-avanzo-26-milioni': { name: 'Bilancio Luino', path: '/articoli-frontaliere/luino-bilancio-2025-avanzo-26-milioni', parent: 'blog' },
    'blog-nuovo-cardiocentro-lugano-realta': { name: 'Novità sanità', path: '/articoli-frontaliere/nuovo-cardiocentro-lugano-realta', parent: 'blog' },
    'blog-spazi-autogestione-lugano-ghisletta': { name: 'Spazi autogestione', path: '/articoli-frontaliere/spazi-autogestione-lugano-ghisletta', parent: 'blog' },
    'blog-svizzera-volare-aviazione-civile': { name: 'Aviazione civile', path: '/articoli-frontaliere/svizzera-volare-aviazione-civile', parent: 'blog' },
    'blog-tangenziale-verde-somma-lombardo-2026': { name: 'Novità', path: '/articoli-frontaliere/tangenziale-verde-somma-lombardo-2026', parent: 'blog' },
    'blog-inaugurazione-parchetto-biumo-via-arconati': { name: 'Inaugurazione parchetto', path: '/articoli-frontaliere/inaugurazione-parchetto-biumo-via-arconati', parent: 'blog' },
    'blog-mendrisio-capitale-culturale-2026': { name: 'Novità', path: '/articoli-frontaliere/mendrisio-capitale-culturale-2026', parent: 'blog' },
    'blog-falsi-preti-barasso-truffe-anziani': { name: 'Novità', path: '/articoli-frontaliere/falsi-preti-barasso-truffe-anziani', parent: 'blog' },
    'blog-bando-restauro-beni-culturali-lombardia': { name: 'Bando restauro', path: '/articoli-frontaliere/bando-restauro-beni-culturali-lombardia', parent: 'blog' },
    'blog-insieme-ad-andrea-si-puo-ricerca-leucemie-infantili': { name: 'Novità', path: '/articoli-frontaliere/insieme-ad-andrea-si-puo-ricerca-leucemie-infantili', parent: 'blog' },
    'blog-scuola-chiude-fino-mornasco-2026': { name: 'Novità', path: '/articoli-frontaliere/scuola-chiude-fino-mornasco-2026', parent: 'blog' },
    'blog-como-turismo-sostenibile-10-maggio': { name: 'Turismo sostenibile', path: '/articoli-frontaliere/como-turismo-sostenibile-10-maggio', parent: 'blog' },
    'blog-nuovo-allenatore-orsi-serge-aubin': { name: 'Novità', path: '/articoli-frontaliere/nuovo-allenatore-orsi-serge-aubin', parent: 'blog' },
    'blog-asta-villa-geno-como-400mila-euro': { name: 'Villa Geno asta', path: '/articoli-frontaliere/asta-villa-geno-como-400mila-euro', parent: 'blog' },
    'blog-mercato-agricolo-besozzo-superiore': { name: 'Mercato agricolo', path: '/articoli-frontaliere/mercato-agricolo-besozzo-superiore', parent: 'blog' },
    'blog-intelligenza-artificiale-robotica-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/intelligenza-artificiale-robotica-varese-2026', parent: 'blog' },
    'blog-frontalieri-rifiuti-lac-lemano': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-rifiuti-lac-lemano', parent: 'blog' },
    'blog-cazzago-brabbia-camminan-mangiando-2026': { name: 'Eventi Ticino', path: '/articoli-frontaliere/cazzago-brabbia-camminan-mangiando-2026', parent: 'blog' },
    'blog-lot-polish-60-anni-malpensa-varsavia': { name: 'Novità', path: '/articoli-frontaliere/lot-polish-60-anni-malpensa-varsavia', parent: 'blog' },
    'blog-auto-truccate-polizia-zugo-2026': { name: 'Novità', path: '/articoli-frontaliere/auto-truccate-polizia-zugo-2026', parent: 'blog' },
    'blog-spirometrie-gratuite-bambini-varese-2026': { name: 'Novità', path: '/articoli-frontaliere/spirometrie-gratuite-bambini-varese-2026', parent: 'blog' },
    'blog-blackdamp-memoria-sacrificio-ed-emigrazione-nuovo-romanzo-storico-lucia-tiziani': { name: 'Blackdamp: memoria, sacrificio ed', path: '/articoli-frontaliere/blackdamp-memoria-sacrificio-ed-emigrazione-nuovo-romanzo-storico-lucia-tiziani', parent: 'blog' },
    'blog-incidente-a8-castellanza-busto-arsizio-2026': { name: 'Incidente A8', path: '/articoli-frontaliere/incidente-a8-castellanza-busto-arsizio-2026', parent: 'blog' },
    'blog-elicottero-mezzovico-incidente-2026': { name: 'Incidente elicottero', path: '/articoli-frontaliere/elicottero-mezzovico-incidente-2026', parent: 'blog' },
    'blog-inarzo-festa-oasi-palude-brabbia-2026': { name: 'Eventi', path: '/articoli-frontaliere/inarzo-festa-oasi-palude-brabbia-2026', parent: 'blog' },
    'blog-mondiali-hockey-svizzera-2026': { name: 'Mondiali Hockey', path: '/articoli-frontaliere/mondiali-hockey-svizzera-2026', parent: 'blog' },
    'blog-comanorun-record-801-iscritti': { name: 'ComanoRun 2026', path: '/articoli-frontaliere/comanorun-record-801-iscritti', parent: 'blog' },
    'blog-comano-run-record-2026': { name: 'Comano Run', path: '/articoli-frontaliere/comano-run-record-2026', parent: 'blog' },
    'blog-moria-pesci-berneck-2026': { name: 'Novità', path: '/articoli-frontaliere/moria-pesci-berneck-2026', parent: 'blog' },
    'blog-festival-meraviglia-laveno-luino-2026': { name: 'Festival della Meraviglia', path: '/articoli-frontaliere/festival-meraviglia-laveno-luino-2026', parent: 'blog' },
    'blog-meraviglia-festival-laveno-luino-2026': { name: 'Festival Meraviglia', path: '/articoli-frontaliere/meraviglia-festival-laveno-luino-2026', parent: 'blog' },
    'blog-udc-cultura-indipendente-spesa-giustificata': { name: 'Novità', path: '/articoli-frontaliere/udc-cultura-indipendente-spesa-giustificata', parent: 'blog' },
    'blog-scontri-lugano-politica-toni': { name: 'Novità', path: '/articoli-frontaliere/scontri-lugano-politica-toni', parent: 'blog' },
    'blog-svizzera-istruzioni-uso-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/svizzera-istruzioni-uso-frontalieri', parent: 'blog' },
    'blog-prigioni-ticino-sovraffollate-2026': { name: 'Prigioni Ticino', path: '/articoli-frontaliere/prigioni-ticino-sovraffollate-2026', parent: 'blog' },
    'blog-folgorato-stazione-bellinzona-morto-uomo': { name: 'Novità', path: '/articoli-frontaliere/folgorato-stazione-bellinzona-morto-uomo', parent: 'blog' },
    'blog-lupo-tempo-attesa-finito-agire': { name: 'Novità', path: '/articoli-frontaliere/lupo-tempo-attesa-finito-agire', parent: 'blog' },
    'blog-processo-binningen-morte-moglie-2026': { name: 'Processo Binningen', path: '/articoli-frontaliere/processo-binningen-morte-moglie-2026', parent: 'blog' },
    'blog-gianni-morandi-locarno-2026': { name: 'Concerto Gianni Morandi', path: '/articoli-frontaliere/gianni-morandi-locarno-2026', parent: 'blog' },
    'blog-tensioni-geopolitiche-elettrico-ticino': { name: 'Novità', path: '/articoli-frontaliere/tensioni-geopolitiche-elettrico-ticino', parent: 'blog' },
    'blog-crans-montana-disgelo-italia-svizzera': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-disgelo-italia-svizzera', parent: 'blog' },
    'blog-thun-vince-calcio-programmazione': { name: 'Novità', path: '/articoli-frontaliere/thun-vince-calcio-programmazione', parent: 'blog' },
    'blog-cliche-politici-giovani-ticino': { name: 'Cliché politici', path: '/articoli-frontaliere/cliche-politici-giovani-ticino', parent: 'blog' },
    'blog-lugano-ingaggia-olle-lycksell-2026': { name: 'Novità Lugano', path: '/articoli-frontaliere/lugano-ingaggia-olle-lycksell-2026', parent: 'blog' },
    'blog-questionario-scuole-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/questionario-scuole-ticino-2026', parent: 'blog' },
    'blog-scuola-como-chiusura-socco': { name: 'Scuola Como', path: '/articoli-frontaliere/scuola-como-chiusura-socco', parent: 'blog' },
    'blog-rischio-benzina-svizzera-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/rischio-benzina-svizzera-frontalieri', parent: 'blog' },
    'blog-mense-scolastiche-ticino-prezzi-2026': { name: 'Mense scolastiche', path: '/articoli-frontaliere/mense-scolastiche-ticino-prezzi-2026', parent: 'blog' },
    'blog-inflazione-ticino-aprile-2026': { name: 'Inflazione Svizzera', path: '/articoli-frontaliere/inflazione-ticino-aprile-2026', parent: 'blog' },
    'blog-pubblicita-ambiente-amsterdam-svizzera': { name: 'Novità', path: '/articoli-frontaliere/pubblicita-ambiente-amsterdam-svizzera', parent: 'blog' },
    'blog-como-tunisino-denunciato-aggressione': { name: 'Novità', path: '/articoli-frontaliere/como-tunisino-denunciato-aggressione', parent: 'blog' },
    'blog-internazionali-ticino-2026': { name: 'Internazionali d\'Italia', path: '/articoli-frontaliere/internazionali-ticino-2026', parent: 'blog' },
    'blog-il-valore-del-vicino-ciclo-incontri-economia-prossimita': { name: 'Economia della prossimità', path: '/articoli-frontaliere/il-valore-del-vicino-ciclo-incontri-economia-prossimita', parent: 'blog' },
    'blog-carburante-svizzera-scorte-2026': { name: 'Carburante Svizzera', path: '/articoli-frontaliere/carburante-svizzera-scorte-2026', parent: 'blog' },
    'blog-como-nuoto-750mila-euro-tribunale': { name: 'Novità', path: '/articoli-frontaliere/como-nuoto-750mila-euro-tribunale', parent: 'blog' },
    'blog-arresto-cocaina-mendrisio-albanese': { name: 'Novità', path: '/articoli-frontaliere/arresto-cocaina-mendrisio-albanese', parent: 'blog' },
    'blog-guerra-frena-viaggi-estero-2026': { name: 'Novità', path: '/articoli-frontaliere/guerra-frena-viaggi-estero-2026', parent: 'blog' },
    'blog-lavori-soddisfazione-svizzeri-ticino': { name: 'Lavoro e soddisfazione', path: '/articoli-frontaliere/lavori-soddisfazione-svizzeri-ticino', parent: 'blog' },
    'blog-benzina-19-euro-5-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/benzina-19-euro-5-maggio-2026', parent: 'blog' },
    'blog-passo-gottardo-riaperto-ascensione': { name: 'Novità', path: '/articoli-frontaliere/passo-gottardo-riaperto-ascensione', parent: 'blog' },
    'blog-passo-gottardo-riapre-anticipo-8-maggio': { name: 'Novità', path: '/articoli-frontaliere/passo-gottardo-riapre-anticipo-8-maggio', parent: 'blog' },
    'blog-furti-auto-ticino-2026': { name: 'Furti auto Ticino', path: '/articoli-frontaliere/furti-auto-ticino-2026', parent: 'blog' },
    'blog-lamone-nono-mcdonalds-ticino': { name: 'Novità', path: '/articoli-frontaliere/lamone-nono-mcdonalds-ticino', parent: 'blog' },
    'blog-stagflazione-imprese-varesine-2026': { name: 'Stagflazione', path: '/articoli-frontaliere/stagflazione-imprese-varesine-2026', parent: 'blog' },
    'blog-permessi-dimora-grigioni-mafie': { name: 'Permessi Grigioni', path: '/articoli-frontaliere/permessi-dimora-grigioni-mafie', parent: 'blog' },
    'blog-caseifici-aperti-ticino-2026': { name: 'Caseifici aperti', path: '/articoli-frontaliere/caseifici-aperti-ticino-2026', parent: 'blog' },
    'blog-campagna-dss-appropriatezza-sanitaria': { name: 'Novità', path: '/articoli-frontaliere/campagna-dss-appropriatezza-sanitaria', parent: 'blog' },
    'blog-parco-ticino-controlli-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/parco-ticino-controlli-maggio-2026', parent: 'blog' },
    'blog-pasto-vegetale-gratis-ticino-2026': { name: 'Eventi Ticino', path: '/articoli-frontaliere/pasto-vegetale-gratis-ticino-2026', parent: 'blog' },
    'blog-mercatino-rancate-mendrisio-2026': { name: 'Novità', path: '/articoli-frontaliere/mercatino-rancate-mendrisio-2026', parent: 'blog' },
    'blog-kof-prospettive-lavoro-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/kof-prospettive-lavoro-ticino-2026', parent: 'blog' },
    'blog-cornaredo-miliardo-promesse-cemento': { name: 'Cornaredo Lugano', path: '/articoli-frontaliere/cornaredo-miliardo-promesse-cemento', parent: 'blog' },
    'blog-ladies-run-lugano-chiusure-stradali-2026': { name: 'Chiusure stradali', path: '/articoli-frontaliere/ladies-run-lugano-chiusure-stradali-2026', parent: 'blog' },
    'blog-furti-auto-ticino-2026-axa': { name: 'Furti auto Ticino', path: '/articoli-frontaliere/furti-auto-ticino-2026-axa', parent: 'blog' },
    'blog-malpensafiere-hub-imprese-2026': { name: 'Focus Day Nuove Imprese', path: '/articoli-frontaliere/malpensafiere-hub-imprese-2026', parent: 'blog' },
    'blog-olgiate-olona-alloggio-domotico-disabili-2026': { name: 'Novità', path: '/articoli-frontaliere/olgiate-olona-alloggio-domotico-disabili-2026', parent: 'blog' },
    'blog-swiss-voice-tour-tenero-2026': { name: 'Swiss Voice Tour', path: '/articoli-frontaliere/swiss-voice-tour-tenero-2026', parent: 'blog' },
    'blog-guida-svizzera-frontalieri-2026': { name: 'Guida Svizzera', path: '/articoli-frontaliere/guida-svizzera-frontalieri-2026', parent: 'blog' },
    'blog-iniziativa-caos-comitato-ticino-2026': { name: 'Iniziativa del caos', path: '/articoli-frontaliere/iniziativa-caos-comitato-ticino-2026', parent: 'blog' },
    'blog-ospedale-zurigo-mancanze-cardiochirurgia': { name: 'Novità', path: '/articoli-frontaliere/ospedale-zurigo-mancanze-cardiochirurgia', parent: 'blog' },
    'blog-libretto-digitale-militare-ticino-2026': { name: 'Libretto digitale', path: '/articoli-frontaliere/libretto-digitale-militare-ticino-2026', parent: 'blog' },
    'blog-bici-bellinzona-valli-strategia': { name: 'Novità', path: '/articoli-frontaliere/bici-bellinzona-valli-strategia', parent: 'blog' },
    'blog-dipendenti-statali-ticino-soddisfazione-2026': { name: 'Dipendenti statali Ticino', path: '/articoli-frontaliere/dipendenti-statali-ticino-soddisfazione-2026', parent: 'blog' },
    'blog-fitness-ticino-record-2026': { name: 'Fitness Ticino', path: '/articoli-frontaliere/fitness-ticino-record-2026', parent: 'blog' },
    'blog-education-day-varese-studenti': { name: 'Education Day', path: '/articoli-frontaliere/education-day-varese-studenti', parent: 'blog' },
    'blog-truck-lavoro-etico-varese-studenti-visori-3d': { name: 'Truck lavoro Varese', path: '/articoli-frontaliere/truck-lavoro-etico-varese-studenti-visori-3d', parent: 'blog' },
    'blog-bici-miliardi-varese-percorsi-ciclabili': { name: 'Novità', path: '/articoli-frontaliere/bici-miliardi-varese-percorsi-ciclabili', parent: 'blog' },
    'blog-assicurazione-dentaria-obbligatoria-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/assicurazione-dentaria-obbligatoria-ticino-2026', parent: 'blog' },
    'blog-incidente-fornasette-2026': { name: 'Incidente Fornasette', path: '/articoli-frontaliere/incidente-fornasette-2026', parent: 'blog' },
    'blog-lavoro-agenzia-lombardia-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/lavoro-agenzia-lombardia-frontalieri', parent: 'blog' },
    'blog-condizioni-utilizzo-tvsvizzera': { name: 'Nuove regole TV Svizzera', path: '/articoli-frontaliere/condizioni-utilizzo-tvsvizzera', parent: 'blog' },
    'blog-nuovo-ccnl-assolavoro-welfare-lavoratori': { name: 'Novità', path: '/articoli-frontaliere/nuovo-ccnl-assolavoro-welfare-lavoratori', parent: 'blog' },
    'blog-dipendenti-cantonali-soddisfazione-erre-dipi': { name: 'Dipendenti cantonali', path: '/articoli-frontaliere/dipendenti-cantonali-soddisfazione-erre-dipi', parent: 'blog' },
    'blog-frontalieri-disoccupati-svizzera-indennita': { name: 'Frontalieri', path: '/articoli-frontaliere/frontalieri-disoccupati-svizzera-indennita', parent: 'blog' },
    'blog-somministrazione-occupazione-qualita-bottini': { name: 'Novità', path: '/articoli-frontaliere/somministrazione-occupazione-qualita-bottini', parent: 'blog' },
    'blog-misoexperience-festival-sport-2024': { name: 'Festival sportivi', path: '/articoli-frontaliere/misoexperience-festival-sport-2024', parent: 'blog' },
    'blog-servizio-civile-legge-nefasta-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/servizio-civile-legge-nefasta-frontalieri', parent: 'blog' },
    'blog-furto-carrefour-como-marocchini-arrestati': { name: 'Novità', path: '/articoli-frontaliere/furto-carrefour-como-marocchini-arrestati', parent: 'blog' },
    'blog-svizzera-italia-nuova-fase-relazioni': { name: 'Novità', path: '/articoli-frontaliere/svizzera-italia-nuova-fase-relazioni', parent: 'blog' },
    'blog-moschea-cantu-frontalieri-2026': { name: 'Moschea Cantù', path: '/articoli-frontaliere/moschea-cantu-frontalieri-2026', parent: 'blog' },
    'blog-lago-como-monte-san-primo-5-milioni': { name: 'Ambiente', path: '/articoli-frontaliere/lago-como-monte-san-primo-5-milioni', parent: 'blog' },
    'blog-mistero-palazzo-como-7-milioni': { name: 'Novità', path: '/articoli-frontaliere/mistero-palazzo-como-7-milioni', parent: 'blog' },
    'blog-palestre-svizzera-record-2026': { name: 'Novità', path: '/articoli-frontaliere/palestre-svizzera-record-2026', parent: 'blog' },
    'blog-aarau-arresto-somalier-auto-delitto': { name: 'Aarau: 23enne somalo arrestato', path: '/articoli-frontaliere/aarau-arresto-somalier-auto-delitto', parent: 'blog' },
    'blog-expat-ticino-sventa-truffa-hacker': { name: 'Truffe online', path: '/articoli-frontaliere/expat-ticino-sventa-truffa-hacker', parent: 'blog' },
    'blog-tragedia-braunwald-camminatore-disperso': { name: 'Novità', path: '/articoli-frontaliere/tragedia-braunwald-camminatore-disperso', parent: 'blog' },
    'blog-20mila-firme-autostrada-pedaggio': { name: 'Novità', path: '/articoli-frontaliere/20mila-firme-autostrada-pedaggio', parent: 'blog' },
    'blog-incendio-casciago-varese-2026': { name: 'Incendio Casciago', path: '/articoli-frontaliere/incendio-casciago-varese-2026', parent: 'blog' },
    'blog-varese-spacciatore-arresto-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/varese-spacciatore-arresto-frontalieri', parent: 'blog' },
    'blog-incendio-cassano-magnago-sgombero': { name: 'Novità', path: '/articoli-frontaliere/incendio-cassano-magnago-sgombero', parent: 'blog' },
    'blog-furti-auto-ticino-2026-axa-segnalazioni': { name: 'Furti auto', path: '/articoli-frontaliere/furti-auto-ticino-2026-axa-segnalazioni', parent: 'blog' },
    'blog-minoteries-chiude-zollbruck-28-dipendenti': { name: 'Novità', path: '/articoli-frontaliere/minoteries-chiude-zollbruck-28-dipendenti', parent: 'blog' },
    'blog-gottardo-riapre-8-maggio-2026': { name: 'Passo Gottardo', path: '/articoli-frontaliere/gottardo-riapre-8-maggio-2026', parent: 'blog' },
    'blog-agricoltura-precisione-pesticidi-2026': { name: 'Agricoltura di precisione', path: '/articoli-frontaliere/agricoltura-precisione-pesticidi-2026', parent: 'blog' },
    'blog-hondius-hantavirus-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/hondius-hantavirus-frontalieri', parent: 'blog' },
    'blog-tajani-parmelin-crans-montana-2026': { name: 'Novità', path: '/articoli-frontaliere/tajani-parmelin-crans-montana-2026', parent: 'blog' },
    'blog-carburante-ticino-guerra-2026': { name: 'Carburante in Ticino', path: '/articoli-frontaliere/carburante-ticino-guerra-2026', parent: 'blog' },
    'blog-udc-sostenibilita-lavoro-ticino-2026': { name: 'UDC sostenibilità', path: '/articoli-frontaliere/udc-sostenibilita-lavoro-ticino-2026', parent: 'blog' },
    'blog-a13-lumino-san-vittore-compensazione-ambientale': { name: 'Novità', path: '/articoli-frontaliere/a13-lumino-san-vittore-compensazione-ambientale', parent: 'blog' },
    'blog-divieto-petardi-svizzera-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/divieto-petardi-svizzera-frontalieri', parent: 'blog' },
    'blog-salotto-ciani-lugano-2026': { name: 'Eventi culturali', path: '/articoli-frontaliere/salotto-ciani-lugano-2026', parent: 'blog' },
    'blog-hockey-lugano-nuovi-giocatori-2026': { name: 'Novità Hockey', path: '/articoli-frontaliere/hockey-lugano-nuovi-giocatori-2026', parent: 'blog' },
    'blog-incidente-fornasette-2026-ribaltamento-auto': { name: 'Incidente Fornasette', path: '/articoli-frontaliere/incidente-fornasette-2026-ribaltamento-auto', parent: 'blog' },
    'blog-accesso-dossier-mengele': { name: 'Dossier Mengele', path: '/articoli-frontaliere/accesso-dossier-mengele', parent: 'blog' },
    'blog-tragedia-stazione-bellinzona-frontalieri': { name: 'Tragedia in stazione a Bellinzona', path: '/articoli-frontaliere/tragedia-stazione-bellinzona-frontalieri', parent: 'blog' },
    'blog-pompieri-lugano-24-ore-2026': { name: 'Novità', path: '/articoli-frontaliere/pompieri-lugano-24-ore-2026', parent: 'blog' },
    'blog-nathan-borradori-ambri-2030': { name: 'Novità', path: '/articoli-frontaliere/nathan-borradori-ambri-2030', parent: 'blog' },
    'blog-conducente-folla-ricoverato-psichiatria-2026': { name: 'Novità', path: '/articoli-frontaliere/conducente-folla-ricoverato-psichiatria-2026', parent: 'blog' },
    'blog-dipendenti-cantonali-soddisfazione-2026': { name: 'Dipendenti cantonali', path: '/articoli-frontaliere/dipendenti-cantonali-soddisfazione-2026', parent: 'blog' },
    'blog-casse-malati-ticino-leghista-socialista': { name: 'Casse malati Ticino', path: '/articoli-frontaliere/casse-malati-ticino-leghista-socialista', parent: 'blog' },
    'blog-morto-rene-groebli-fotografo-98-anni': { name: 'Novità', path: '/articoli-frontaliere/morto-rene-groebli-fotografo-98-anni', parent: 'blog' },
    'blog-food-truck-festival-locarno-2026': { name: 'Eventi Ticino', path: '/articoli-frontaliere/food-truck-festival-locarno-2026', parent: 'blog' },
    'blog-hendsichen-arresto-francese-autodiebstahl': { name: 'Novità', path: '/articoli-frontaliere/hendsichen-arresto-francese-autodiebstahl', parent: 'blog' },
    'blog-bper-risiko-bancario-crescita-mercato': { name: 'Bper e i lupi', path: '/articoli-frontaliere/bper-risiko-bancario-crescita-mercato', parent: 'blog' },
    'blog-svizzeri-felici-salute-mentale-costi': { name: 'Salute mentale', path: '/articoli-frontaliere/svizzeri-felici-salute-mentale-costi', parent: 'blog' },
    'blog-liuc-innovazione-2026-frontalieri': { name: 'Settimana dell\'Innovazione', path: '/articoli-frontaliere/liuc-innovazione-2026-frontalieri', parent: 'blog' },
    'blog-colombi-addio-corriere-ticino': { name: 'Novità', path: '/articoli-frontaliere/colombi-addio-corriere-ticino', parent: 'blog' },
    'blog-ospedale-zurigo-cardiochirurgia-scandalo': { name: 'Scandalo cardiochirurgia', path: '/articoli-frontaliere/ospedale-zurigo-cardiochirurgia-scandalo', parent: 'blog' },
    'blog-locarno-abitanti-domiciliati-2026': { name: 'Locarno abitanti', path: '/articoli-frontaliere/locarno-abitanti-domiciliati-2026', parent: 'blog' },
    'blog-cure-dentarie-ticino-2026': { name: 'Cure dentarie Ticino', path: '/articoli-frontaliere/cure-dentarie-ticino-2026', parent: 'blog' },
    'blog-bilancio-voto-canone-ssr-2026': { name: 'Novità', path: '/articoli-frontaliere/bilancio-voto-canone-ssr-2026', parent: 'blog' },
    'blog-votazioni-cure-dentarie-ticino-2024': { name: 'Iniziativa cure dentarie', path: '/articoli-frontaliere/votazioni-cure-dentarie-ticino-2024', parent: 'blog' },
    'blog-casa-artigianato-dongio-sostegno': { name: 'Novità', path: '/articoli-frontaliere/casa-artigianato-dongio-sostegno', parent: 'blog' },
    'blog-cnhi-mendrisio-dipendenti-allarme': { name: 'Novità', path: '/articoli-frontaliere/cnhi-mendrisio-dipendenti-allarme', parent: 'blog' },
    'blog-swiss-made-regole-frontalieri': { name: 'Swiss Made', path: '/articoli-frontaliere/swiss-made-regole-frontalieri', parent: 'blog' },
    'blog-cucina-tipica-lombarda-legge-2026': { name: 'Novità', path: '/articoli-frontaliere/cucina-tipica-lombarda-legge-2026', parent: 'blog' },
    'blog-estate-chiasso-2026-eventi': { name: 'Estate Chiasso', path: '/articoli-frontaliere/estate-chiasso-2026-eventi', parent: 'blog' },
    'blog-petrolio-inflazione-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/petrolio-inflazione-svizzera-2026', parent: 'blog' },
    'blog-negozi-varese-frontalieri-occupazione': { name: 'Novità', path: '/articoli-frontaliere/negozi-varese-frontalieri-occupazione', parent: 'blog' },
    'blog-app-guida-ticino-silicon-valley-2026': { name: 'Novità', path: '/articoli-frontaliere/app-guida-ticino-silicon-valley-2026', parent: 'blog' },
    'blog-mesolcina-festival-sport-2026': { name: 'Festival Sportivo', path: '/articoli-frontaliere/mesolcina-festival-sport-2026', parent: 'blog' },
    'blog-goldbarren-zurigo-zoll-confiscati': { name: 'Novità', path: '/articoli-frontaliere/goldbarren-zurigo-zoll-confiscati', parent: 'blog' },
    'blog-negozio-danese-arese-2026': { name: 'Novità', path: '/articoli-frontaliere/negozio-danese-arese-2026', parent: 'blog' },
    'blog-varese-summer-experience-2026-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/varese-summer-experience-2026-frontalieri', parent: 'blog' },
    'blog-malpensa-rumore-casorate-sempione-2026': { name: 'Novità', path: '/articoli-frontaliere/malpensa-rumore-casorate-sempione-2026', parent: 'blog' },
    'blog-primo-maggio-monito-svizzera-10-milioni': { name: '1° maggio UDC', path: '/articoli-frontaliere/primo-maggio-monito-svizzera-10-milioni', parent: 'blog' },
    'blog-bambini-tecnologia-varese-2026': { name: 'Bambini e tecnologia', path: '/articoli-frontaliere/bambini-tecnologia-varese-2026', parent: 'blog' },
    'blog-ticino-benzina-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/ticino-benzina-frontalieri-2026', parent: 'blog' },
    'blog-nomine-meloni-consob-antitrust-2026': { name: 'Novità', path: '/articoli-frontaliere/nomine-meloni-consob-antitrust-2026', parent: 'blog' },
    'blog-crociere-ticino-rodano-senna-2026': { name: 'Viaggi & Turismo', path: '/articoli-frontaliere/crociere-ticino-rodano-senna-2026', parent: 'blog' },
    'blog-tunesier-algerier-autoknacker-wuerenlos': { name: 'Novità', path: '/articoli-frontaliere/tunesier-algerier-autoknacker-wuerenlos', parent: 'blog' },
    'blog-servizio-civile-errore-voto-2026': { name: 'Servizio civile', path: '/articoli-frontaliere/servizio-civile-errore-voto-2026', parent: 'blog' },
    'blog-parita-salariale-ticino-2026': { name: 'Parità salariale', path: '/articoli-frontaliere/parita-salariale-ticino-2026', parent: 'blog' },
    'blog-lavori-chiasso-franscini-2026': { name: 'Lavori a Chiasso', path: '/articoli-frontaliere/lavori-chiasso-franscini-2026', parent: 'blog' },
    'blog-posta-castel-san-pietro-negozio-alimentari': { name: 'Novità', path: '/articoli-frontaliere/posta-castel-san-pietro-negozio-alimentari', parent: 'blog' },
    'blog-sicuritalia-assunzioni-lombardia-veneto-2026': { name: 'Novità', path: '/articoli-frontaliere/sicuritalia-assunzioni-lombardia-veneto-2026', parent: 'blog' },
    'blog-volandia-record-presenze-maggio-2026': { name: 'Novità', path: '/articoli-frontaliere/volandia-record-presenze-maggio-2026', parent: 'blog' },
    'blog-swissquote-trading-day-lugano-2026': { name: 'Swissquote Trading Day', path: '/articoli-frontaliere/swissquote-trading-day-lugano-2026', parent: 'blog' },
    'blog-liberalizzazione-cannabis-minori-tutelati': { name: 'Novità', path: '/articoli-frontaliere/liberalizzazione-cannabis-minori-tutelati', parent: 'blog' },
    'blog-afghano-arresto-zug-chiasso': { name: 'Notizie dal Ticino', path: '/articoli-frontaliere/afghano-arresto-zug-chiasso', parent: 'blog' },
    'blog-sicurezza-commerciali-locarno-2026': { name: 'Sicurezza commerciale', path: '/articoli-frontaliere/sicurezza-commerciali-locarno-2026', parent: 'blog' },
    'blog-roveredo-carnevale-tutti-2026': { name: 'Iniziativa Carnevale', path: '/articoli-frontaliere/roveredo-carnevale-tutti-2026', parent: 'blog' },
    'blog-fnma-recruiting-day-saronno-2026': { name: 'Novità', path: '/articoli-frontaliere/fnma-recruiting-day-saronno-2026', parent: 'blog' },
    'blog-sportello-energetico-verbano-2026': { name: 'Sportello energetico', path: '/articoli-frontaliere/sportello-energetico-verbano-2026', parent: 'blog' },
    'blog-vittima-folgorata-bellinzona-2026': { name: 'Vittima folgorata', path: '/articoli-frontaliere/vittima-folgorata-bellinzona-2026', parent: 'blog' },
    'blog-bilaterali-iii-doppia-maggioranza': { name: 'Bilaterali III', path: '/articoli-frontaliere/bilaterali-iii-doppia-maggioranza', parent: 'blog' },
    'blog-tassa-immigrazione-frontalieri-2026': { name: 'Tassa immigrazione', path: '/articoli-frontaliere/tassa-immigrazione-frontalieri-2026', parent: 'blog' },
    'blog-bilaterali-iii-modifica-costituzionale': { name: 'Bilaterali III', path: '/articoli-frontaliere/bilaterali-iii-modifica-costituzionale', parent: 'blog' },
    'blog-screening-senologico-45-anni-ticino': { name: 'Screening mammografico', path: '/articoli-frontaliere/screening-senologico-45-anni-ticino', parent: 'blog' },
    'blog-g7-evian-controlli-frontiere-ticino': { name: 'G7 Evian', path: '/articoli-frontaliere/g7-evian-controlli-frontiere-ticino', parent: 'blog' },
    'blog-menaggio-test-automobilisti-guai': { name: 'Menaggio Test', path: '/articoli-frontaliere/menaggio-test-automobilisti-guai', parent: 'blog' },
    'blog-votazioni-ticino-14-giugno-2024': { name: 'Votazioni Ticino', path: '/articoli-frontaliere/votazioni-ticino-14-giugno-2024', parent: 'blog' },
    'blog-borse-ticino-londra-verde': { name: 'Borse e frontalieri', path: '/articoli-frontaliere/borse-ticino-londra-verde', parent: 'blog' },
    'blog-bagni-bellinzona-riaprono-novita-2026': { name: 'Novità Bagni Bellinzona', path: '/articoli-frontaliere/bagni-bellinzona-riaprono-novita-2026', parent: 'blog' },
    'blog-swiss-market-index-entusiasmo-2026': { name: 'Novità', path: '/articoli-frontaliere/swiss-market-index-entusiasmo-2026', parent: 'blog' },
    'blog-trump-export-limits-petrol-2026': { name: 'Novità', path: '/articoli-frontaliere/trump-export-limits-petrol-2026', parent: 'blog' },
    'blog-riapertura-bagno-bellinzona-2026': { name: 'Novità Bellinzona', path: '/articoli-frontaliere/riapertura-bagno-bellinzona-2026', parent: 'blog' },
    'blog-partita-cornaredo-blocchi-stradali-2026': { name: 'Novità', path: '/articoli-frontaliere/partita-cornaredo-blocchi-stradali-2026', parent: 'blog' },
    'blog-fondi-europei-ticino-2026': { name: 'Fondi europei', path: '/articoli-frontaliere/fondi-europei-ticino-2026', parent: 'blog' },
    'blog-friborgo-hockey-mondiale-2026': { name: 'Novità', path: '/articoli-frontaliere/friborgo-hockey-mondiale-2026', parent: 'blog' },
    'blog-pagare-vittime-crans-montana-2026': { name: 'Novità', path: '/articoli-frontaliere/pagare-vittime-crans-montana-2026', parent: 'blog' },
    'blog-e-bike-parcheggi-sicuri-losanna-2026': { name: 'Novità', path: '/articoli-frontaliere/e-bike-parcheggi-sicuri-losanna-2026', parent: 'blog' },
    'blog-furti-serie-automobili-luganese-arrestato': { name: 'Furti in auto', path: '/articoli-frontaliere/furti-serie-automobili-luganese-arrestato', parent: 'blog' },
    'blog-como-taccheggio-rapina-doppio-arresto': { name: 'Novità', path: '/articoli-frontaliere/como-taccheggio-rapina-doppio-arresto', parent: 'blog' },
    'blog-bellinzona-bagno-pubblico-riapre-2026': { name: 'Novità', path: '/articoli-frontaliere/bellinzona-bagno-pubblico-riapre-2026', parent: 'blog' },
    'blog-udc-bilaterali-2026-frontalieri': { name: 'Iniziativa UDC', path: '/articoli-frontaliere/udc-bilaterali-2026-frontalieri', parent: 'blog' },
    'blog-centro-pasture-balerna-asilo': { name: 'Novità', path: '/articoli-frontaliere/centro-pasture-balerna-asilo', parent: 'blog' },
    'blog-300-persone-pasto-vegetale-lugano-2026': { name: 'Novità', path: '/articoli-frontaliere/300-persone-pasto-vegetale-lugano-2026', parent: 'blog' },
    'blog-svizzera-treno-multa-20000-franchi': { name: 'Novità', path: '/articoli-frontaliere/svizzera-treno-multa-20000-franchi', parent: 'blog' },
    'blog-decreto-lavoro-coldiretti-varese-2026': { name: 'Decreto Lavoro', path: '/articoli-frontaliere/decreto-lavoro-coldiretti-varese-2026', parent: 'blog' },
    'blog-swiss-300-uscite-volontarie-2026': { name: 'Novità', path: '/articoli-frontaliere/swiss-300-uscite-volontarie-2026', parent: 'blog' },
    'blog-parmelin-stop-fatture-mediche-crans-montana': { name: 'Novità', path: '/articoli-frontaliere/parmelin-stop-fatture-mediche-crans-montana', parent: 'blog' },
    'blog-luino-sanita-massarenti-2026': { name: 'Sanità Pubblica', path: '/articoli-frontaliere/luino-sanita-massarenti-2026', parent: 'blog' },
    'blog-siss-problemi-lombardia-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/siss-problemi-lombardia-frontalieri', parent: 'blog' },
    'blog-swiss-risultati-trimestre-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/swiss-risultati-trimestre-frontalieri', parent: 'blog' },
    'blog-poliani-digital-innovation-hub-2026': { name: 'Novità', path: '/articoli-frontaliere/poliani-digital-innovation-hub-2026', parent: 'blog' },
    'blog-nespresso-svizzera-dazi-2026': { name: 'Novità', path: '/articoli-frontaliere/nespresso-svizzera-dazi-2026', parent: 'blog' },
    'blog-fondazione-bignasca-aiuti-2025': { name: 'Novità', path: '/articoli-frontaliere/fondazione-bignasca-aiuti-2025', parent: 'blog' },
    'blog-assegni-figli-frontalieri-2026': { name: 'Assegni figli', path: '/articoli-frontaliere/assegni-figli-frontalieri-2026', parent: 'blog' },
    'blog-integrazione-studenti-gaza-italia-2026': { name: 'Novità', path: '/articoli-frontaliere/integrazione-studenti-gaza-italia-2026', parent: 'blog' },
    'blog-ladro-seriale-ticino-arresto-carte-credito': { name: 'Cronaca Ticino', path: '/articoli-frontaliere/ladro-seriale-ticino-arresto-carte-credito', parent: 'blog' },
    'blog-varese-solidale-convegno-poverta-sanitaria-alimentare-2026': { name: 'Varese Solidale', path: '/articoli-frontaliere/varese-solidale-convegno-poverta-sanitaria-alimentare-2026', parent: 'blog' },
    'blog-centri-famiglia-altovaresotto-2026': { name: 'Centri famiglia', path: '/articoli-frontaliere/centri-famiglia-altovaresotto-2026', parent: 'blog' },
    'blog-immigrazione-svizzera-invecchiamento-2026': { name: 'Novità', path: '/articoli-frontaliere/immigrazione-svizzera-invecchiamento-2026', parent: 'blog' },
    'blog-bocconi-avvelenati-ticino-segnalazioni': { name: 'Novità', path: '/articoli-frontaliere/bocconi-avvelenati-ticino-segnalazioni', parent: 'blog' },
    'blog-nuova-vita-albergo-corecco-quinto': { name: 'Nuova vita Albergo Corecco', path: '/articoli-frontaliere/nuova-vita-albergo-corecco-quinto', parent: 'blog' },
    'blog-alessandro-logistica-swissskills-2025': { name: 'Novità', path: '/articoli-frontaliere/alessandro-logistica-swissskills-2025', parent: 'blog' },
    'blog-ladri-auto-lusso-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/ladri-auto-lusso-ticino-2026', parent: 'blog' },
    'blog-tuberkulose-caso-saint-maurice-2024': { name: 'Novità', path: '/articoli-frontaliere/tuberkulose-caso-saint-maurice-2024', parent: 'blog' },
    'blog-fondazione-bignasca-aiuti-2026': { name: 'Fondazione Bignasca', path: '/articoli-frontaliere/fondazione-bignasca-aiuti-2026', parent: 'blog' },
    'blog-lusso-immobiliare-svizzera-2026': { name: 'Lusso Immobiliare Svizzera', path: '/articoli-frontaliere/lusso-immobiliare-svizzera-2026', parent: 'blog' },
    'blog-chiasso-valore-economico-aggregazione': { name: 'Novità', path: '/articoli-frontaliere/chiasso-valore-economico-aggregazione', parent: 'blog' },
    'blog-governance-partecipativa-ssn-2026': { name: 'Novità', path: '/articoli-frontaliere/governance-partecipativa-ssn-2026', parent: 'blog' },
    'blog-ssn-accessibile-frontalieri-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/ssn-accessibile-frontalieri-ticino-2026', parent: 'blog' },
    'blog-hantavirus-crociera-isolamento': { name: 'Novità', path: '/articoli-frontaliere/hantavirus-crociera-isolamento', parent: 'blog' },
    'blog-nuovo-tunnel-lukmanier-sicurezza': { name: 'Tunnel Lukmanier', path: '/articoli-frontaliere/nuovo-tunnel-lukmanier-sicurezza', parent: 'blog' },
    'blog-hantavirus-oms-passeggeri-sudafrica': { name: 'Hantavirus', path: '/articoli-frontaliere/hantavirus-oms-passeggeri-sudafrica', parent: 'blog' },
    'blog-contrabbandiera-ciclostorica-2026': { name: 'Eventi', path: '/articoli-frontaliere/contrabbandiera-ciclostorica-2026', parent: 'blog' },
    'blog-liberta-dovery-autocensura-mendrisio': { name: 'Novità', path: '/articoli-frontaliere/liberta-dovery-autocensura-mendrisio', parent: 'blog' },
    'blog-case-lusso-svizzera-2026': { name: 'Immobiliare', path: '/articoli-frontaliere/case-lusso-svizzera-2026', parent: 'blog' },
    'blog-chiasso-conti-2025-disavanzo-avanzo': { name: 'Finanze comunali', path: '/articoli-frontaliere/chiasso-conti-2025-disavanzo-avanzo', parent: 'blog' },
    'blog-quartiere-gera-iragna-pianificazione': { name: 'Pianificazione quartiere Gera', path: '/articoli-frontaliere/quartiere-gera-iragna-pianificazione', parent: 'blog' },
    'blog-crans-montana-italia-risarcimento-300000-euro': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-italia-risarcimento-300000-euro', parent: 'blog' },
    'blog-mariano-comense-assale-ferisce-barista-denunciato': { name: 'Mariano Comense (Como): assale e ferisce', path: '/articoli-frontaliere/mariano-comense-assale-ferisce-barista-denunciato', parent: 'blog' },
    'blog-roveredo-patriziato-sciopera-gestione-criminalit': { name: 'Roveredo', path: '/articoli-frontaliere/roveredo-patriziato-sciopera-gestione-criminalit', parent: 'blog' },
    'blog-varese-friuli-solidarieta-2026': { name: 'Varese e il Friuli', path: '/articoli-frontaliere/varese-friuli-solidarieta-2026', parent: 'blog' },
    'blog-natura-tavola-cucina-vegetale-lugano-2024': { name: 'Novità', path: '/articoli-frontaliere/natura-tavola-cucina-vegetale-lugano-2024', parent: 'blog' },
    'blog-cambiamenti-commissione-magistrati-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/cambiamenti-commissione-magistrati-ticino-2026', parent: 'blog' },
    'blog-ticinese-timone-afro-pfingsten': { name: 'Afro-Pfingsten', path: '/articoli-frontaliere/ticinese-timone-afro-pfingsten', parent: 'blog' },
    'blog-varese-corsi-nuovi-orizzonti-2026': { name: 'Varese Corsi', path: '/articoli-frontaliere/varese-corsi-nuovi-orizzonti-2026', parent: 'blog' },
    'blog-due-ticinesi-guardie-svizzere-2026': { name: 'Novità', path: '/articoli-frontaliere/due-ticinesi-guardie-svizzere-2026', parent: 'blog' },
    'blog-hantavirus-zurigo-ricovero-crocerista': { name: 'Sanità', path: '/articoli-frontaliere/hantavirus-zurigo-ricovero-crocerista', parent: 'blog' },
    'blog-bellinzona-valli-bici-velocita': { name: 'Novità', path: '/articoli-frontaliere/bellinzona-valli-bici-velocita', parent: 'blog' },
    'blog-varese-riapre-via-mulini-grassi': { name: 'Varese', path: '/articoli-frontaliere/varese-riapre-via-mulini-grassi', parent: 'blog' },
    'blog-addio-passaporto-usa-berna': { name: 'Novità', path: '/articoli-frontaliere/addio-passaporto-usa-berna', parent: 'blog' },
    'blog-odermatt-dottorato-honoris-causa': { name: 'Novità', path: '/articoli-frontaliere/odermatt-dottorato-honoris-causa', parent: 'blog' },
    'blog-cottarelli-liceo-manzoni-geopolitica': { name: 'Novità', path: '/articoli-frontaliere/cottarelli-liceo-manzoni-geopolitica', parent: 'blog' },
    'blog-teletext-ticino-fuori-uso-2024': { name: 'Teletext fuori uso', path: '/articoli-frontaliere/teletext-ticino-fuori-uso-2024', parent: 'blog' },
    'blog-bayern-bayer-differenze-champions-2026': { name: 'Calcio Ticino', path: '/articoli-frontaliere/bayern-bayer-differenze-champions-2026', parent: 'blog' },
    'blog-9-maggio-europa-bandiera-unione': { name: '9 maggio Europa', path: '/articoli-frontaliere/9-maggio-europa-bandiera-unione', parent: 'blog' },
    'blog-scuole-materne-gallarate-crisi-piano-2026': { name: 'Scuole Materne Gallarate', path: '/articoli-frontaliere/scuole-materne-gallarate-crisi-piano-2026', parent: 'blog' },
    'blog-regazzi-rieletto-usam-burocrazia-udc': { name: 'Novità', path: '/articoli-frontaliere/regazzi-rieletto-usam-burocrazia-udc', parent: 'blog' },
    'blog-ex-casa-comunale-lopagno-vendita': { name: 'Vendita immobili', path: '/articoli-frontaliere/ex-casa-comunale-lopagno-vendita', parent: 'blog' },
    'blog-ascensione-pentecoste-viaggi-2026': { name: 'Viaggi e Turismo', path: '/articoli-frontaliere/ascensione-pentecoste-viaggi-2026', parent: 'blog' },
    'blog-veglia-preghiera-omofobia-ticino-2026': { name: 'Veglia di preghiera', path: '/articoli-frontaliere/veglia-preghiera-omofobia-ticino-2026', parent: 'blog' },
    'blog-parcheggi-digitali-lugano-2024': { name: 'Parcheggi digitali', path: '/articoli-frontaliere/parcheggi-digitali-lugano-2024', parent: 'blog' },
    'blog-rimpatrio-famiglia-curda-riazzino': { name: 'Novità', path: '/articoli-frontaliere/rimpatrio-famiglia-curda-riazzino', parent: 'blog' },
    'blog-varese-strisce-pedonali-invisibili-2026': { name: 'Novità', path: '/articoli-frontaliere/varese-strisce-pedonali-invisibili-2026', parent: 'blog' },
    'blog-furti-self-service-ticino-2026': { name: 'Furti self-service', path: '/articoli-frontaliere/furti-self-service-ticino-2026', parent: 'blog' },
    'blog-varese-arresto-spacciatore-frontaliere': { name: 'Varese arresto', path: '/articoli-frontaliere/varese-arresto-spacciatore-frontaliere', parent: 'blog' },
    'blog-uboldo-tetto-scoperchiato-maltempo-2026': { name: 'Maltempo a Uboldo', path: '/articoli-frontaliere/uboldo-tetto-scoperchiato-maltempo-2026', parent: 'blog' },
    'blog-spreco-alimentare-giovani-social': { name: 'Pratico', path: '/articoli-frontaliere/spreco-alimentare-giovani-social', parent: 'blog' },
    'blog-nuova-axenstrasse-svitto-2026': { name: 'Nuova Axenstrasse', path: '/articoli-frontaliere/nuova-axenstrasse-svitto-2026', parent: 'blog' },
    'blog-spreco-alimentare-svizzera-obiettivo-fallito': { name: 'Spreco alimentare', path: '/articoli-frontaliere/spreco-alimentare-svizzera-obiettivo-fallito', parent: 'blog' },
    'blog-elon-musk-svizzero-processo-friburgo': { name: 'Novità', path: '/articoli-frontaliere/elon-musk-svizzero-processo-friburgo', parent: 'blog' },
    'blog-fedpol-talpa-accesso-dossier-inchiesta': { name: 'Novità', path: '/articoli-frontaliere/fedpol-talpa-accesso-dossier-inchiesta', parent: 'blog' },
    'blog-frode-reddito-cittadinanza-varese-2026': { name: 'Frode reddito cittadinanza', path: '/articoli-frontaliere/frode-reddito-cittadinanza-varese-2026', parent: 'blog' },
    'blog-frontalieri-ticino-calo-2026': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/frontalieri-ticino-calo-2026', parent: 'blog' },
    'blog-temporali-ticino-traffico-2024': { name: 'Temporali Ticino', path: '/articoli-frontaliere/temporali-ticino-traffico-2024', parent: 'blog' },
    'blog-progetto-prossimita-locarno-2026': { name: 'Progetto di Prossimità', path: '/articoli-frontaliere/progetto-prossimita-locarno-2026', parent: 'blog' },
    'blog-media-svizzera-codice-condotta-ia': { name: 'Novità', path: '/articoli-frontaliere/media-svizzera-codice-condotta-ia', parent: 'blog' },
    'blog-cassis-italia-cornado-risarcimento': { name: 'Novità', path: '/articoli-frontaliere/cassis-italia-cornado-risarcimento', parent: 'blog' },
    'blog-disoccupazione-ticino-aprile-2026': { name: 'Novità', path: '/articoli-frontaliere/disoccupazione-ticino-aprile-2026', parent: 'blog' },
    'blog-ticino-pernottamenti-controtendenza-2026': { name: 'Novità Ticino', path: '/articoli-frontaliere/ticino-pernottamenti-controtendenza-2026', parent: 'blog' },
    'blog-lonza-cede-micro-macinazione-stabio': { name: 'Novità', path: '/articoli-frontaliere/lonza-cede-micro-macinazione-stabio', parent: 'blog' },
    'blog-agricoltura-sociale-ticino-strategie-2026': { name: 'Agricoltura sociale', path: '/articoli-frontaliere/agricoltura-sociale-ticino-strategie-2026', parent: 'blog' },
    'blog-arresto-droga-capolago-2026': { name: 'Arresto droga', path: '/articoli-frontaliere/arresto-droga-capolago-2026', parent: 'blog' },
    'blog-lugano-saluta-stadio-cornaredo-2024': { name: 'Eventi Ticino', path: '/articoli-frontaliere/lugano-saluta-stadio-cornaredo-2024', parent: 'blog' },
    'blog-giro-ditalia-ticino-strade-chiuse': { name: 'Giro d\'Italia', path: '/articoli-frontaliere/giro-ditalia-ticino-strade-chiuse', parent: 'blog' },
    'blog-montagne-neve-riapertura-passo-novena': { name: 'Mobilità', path: '/articoli-frontaliere/montagne-neve-riapertura-passo-novena', parent: 'blog' },
    'blog-lucerna-paradiso-fiscale-frontalieri': { name: 'Fiscale', path: '/articoli-frontaliere/lucerna-paradiso-fiscale-frontalieri', parent: 'blog' },
    'blog-spring-pride-saronno-2026': { name: 'Spring Pride 2026', path: '/articoli-frontaliere/spring-pride-saronno-2026', parent: 'blog' },
    'blog-mengele-svizzera-1961-verifica': { name: 'Novità', path: '/articoli-frontaliere/mengele-svizzera-1961-verifica', parent: 'blog' },
    'blog-hantavirus-zurigo-crocerista-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/hantavirus-zurigo-crocerista-frontalieri', parent: 'blog' },
    'blog-cassis-cornado-crans-montana-risarcimento': { name: 'Novità', path: '/articoli-frontaliere/cassis-cornado-crans-montana-risarcimento', parent: 'blog' },
    'blog-liberta-riunione-cedu-condanna-svizzera': { name: 'Novità', path: '/articoli-frontaliere/liberta-riunione-cedu-condanna-svizzera', parent: 'blog' },
    'blog-galleria-italo-svizzera-enigmista': { name: 'Galleria Italo-Svizzera', path: '/articoli-frontaliere/galleria-italo-svizzera-enigmista', parent: 'blog' },
    'blog-svizzera-deroghe-costi-sanitari-crans-montana': { name: 'Fiscale', path: '/articoli-frontaliere/svizzera-deroghe-costi-sanitari-crans-montana', parent: 'blog' },
    'blog-svizzera-2100-scenari-frontalieri': { name: 'Svizzera 2100', path: '/articoli-frontaliere/svizzera-2100-scenari-frontalieri', parent: 'blog' },
    'blog-sbb-controllers-bonuses-fines-ticino-2026': { name: 'SBB Controllers', path: '/articoli-frontaliere/sbb-controllers-bonuses-fines-ticino-2026', parent: 'blog' },
    'blog-nuovo-farmaco-leucemia-linfatica-cronica': { name: 'Novità sanitarie', path: '/articoli-frontaliere/nuovo-farmaco-leucemia-linfatica-cronica', parent: 'blog' },
    'blog-registro-imprese-varese-30-anni': { name: 'Registro Imprese', path: '/articoli-frontaliere/registro-imprese-varese-30-anni', parent: 'blog' },
    'blog-castellanza-investimenti-2025': { name: 'Investimenti Castellanza', path: '/articoli-frontaliere/castellanza-investimenti-2025', parent: 'blog' },
    'blog-svizzera-elettricita-inverno-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzera-elettricita-inverno-2026', parent: 'blog' },
    'blog-hantavirus-svizzera-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/hantavirus-svizzera-frontalieri-2026', parent: 'blog' },
    'blog-cedu-condanna-svizzera-diritti-manifestante': { name: 'Novità', path: '/articoli-frontaliere/cedu-condanna-svizzera-diritti-manifestante', parent: 'blog' },
    'blog-autista-stellato-fabio-giorgianni-premio': { name: 'Premio Autista Stellato', path: '/articoli-frontaliere/autista-stellato-fabio-giorgianni-premio', parent: 'blog' },
    'blog-accordo-editori-sindacati-svizzera-tedesca': { name: 'Novità', path: '/articoli-frontaliere/accordo-editori-sindacati-svizzera-tedesca', parent: 'blog' },
    'blog-svizzera-minaccia-ibrida-russa-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzera-minaccia-ibrida-russa-2026', parent: 'blog' },
    'blog-nottambuli-ticino-orari-societa': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/nottambuli-ticino-orari-societa', parent: 'blog' },
    'blog-economia-circolare-lavoro-carcere-varese': { name: 'Economia circolare', path: '/articoli-frontaliere/economia-circolare-lavoro-carcere-varese', parent: 'blog' },
    'blog-gavirate-incidente-frontalieri-2026': { name: 'Incidente Gavirate', path: '/articoli-frontaliere/gavirate-incidente-frontalieri-2026', parent: 'blog' },
    'blog-cedu-condanna-svizzera-liberta-manifestazione': { name: 'Novità', path: '/articoli-frontaliere/cedu-condanna-svizzera-liberta-manifestazione', parent: 'blog' },
    'blog-spaccio-droga-busto-18mila-euro': { name: 'Spaccio di droga', path: '/articoli-frontaliere/spaccio-droga-busto-18mila-euro', parent: 'blog' },
    'blog-incendio-auto-a2-camorino': { name: 'Incendio auto', path: '/articoli-frontaliere/incendio-auto-a2-camorino', parent: 'blog' },
    'blog-cultura-pari-opportunita-ticino-2024': { name: 'Cultura e inclusione', path: '/articoli-frontaliere/cultura-pari-opportunita-ticino-2024', parent: 'blog' },
    'blog-confisca-patrimoni-mafiosi-svizzera-2026': { name: 'Novità', path: '/articoli-frontaliere/confisca-patrimoni-mafiosi-svizzera-2026', parent: 'blog' },
    'blog-ia-svizzera-uso-frontalieri-2026': { name: 'Novità', path: '/articoli-frontaliere/ia-svizzera-uso-frontalieri-2026', parent: 'blog' },
    'blog-suini-svizzera-compenso-allevatori': { name: 'Novità', path: '/articoli-frontaliere/suini-svizzera-compenso-allevatori', parent: 'blog' },
    'blog-polizia-svizzera-inseguimento-italia': { name: 'Polizia svizzera', path: '/articoli-frontaliere/polizia-svizzera-inseguimento-italia', parent: 'blog' },
    'blog-disoccupazione-ticino-2026-effetti-guerra': { name: 'Disoccupazione Ticino', path: '/articoli-frontaliere/disoccupazione-ticino-2026-effetti-guerra', parent: 'blog' },
    'blog-record-organi-importati-2025': { name: 'Novità', path: '/articoli-frontaliere/record-organi-importati-2025', parent: 'blog' },
    'blog-svizzera-hockey-finlandia-2026': { name: 'Sport', path: '/articoli-frontaliere/svizzera-hockey-finlandia-2026', parent: 'blog' },
    'blog-tax-free-dirinella-orari-ridotti': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/tax-free-dirinella-orari-ridotti', parent: 'blog' },
    'blog-lombardia-chiede-completamento-alptransit': { name: 'Mobilità', path: '/articoli-frontaliere/lombardia-chiede-completamento-alptransit', parent: 'blog' },
    'blog-campagna-politica-frontalieri-15-milioni-franchi': { name: 'Campagna politica', path: '/articoli-frontaliere/campagna-politica-frontalieri-15-milioni-franchi', parent: 'blog' },
    'blog-colf-badanti-ticino-2029': { name: 'Colf e badanti', path: '/articoli-frontaliere/colf-badanti-ticino-2029', parent: 'blog' },
    'blog-turismo-varesotto-2026-frontalieri': { name: 'Turismo Varesotto', path: '/articoli-frontaliere/turismo-varesotto-2026-frontalieri', parent: 'blog' },
    'blog-filtri-pfas-san-antonino-2024': { name: 'San Antonino PFAS', path: '/articoli-frontaliere/filtri-pfas-san-antonino-2024', parent: 'blog' },
    'blog-traduzione-documenti-finanziari-visto': { name: 'Traduzione documenti', path: '/articoli-frontaliere/traduzione-documenti-finanziari-visto', parent: 'blog' },
    'blog-filtrazione-carbone-attivo-san-antonino': { name: 'Filtrazione carbone attivo', path: '/articoli-frontaliere/filtrazione-carbone-attivo-san-antonino', parent: 'blog' },
    'blog-edilizia-ticino-resiste-investimenti-geopolitica': { name: 'Edilizia Ticino', path: '/articoli-frontaliere/edilizia-ticino-resiste-investimenti-geopolitica', parent: 'blog' },
    'blog-adeguati-assetti-imprese-ticino-2026': { name: 'Adeguati assetti', path: '/articoli-frontaliere/adeguati-assetti-imprese-ticino-2026', parent: 'blog' },
    'blog-accuse-svizzera-italia-2026': { name: 'Novità', path: '/articoli-frontaliere/accuse-svizzera-italia-2026', parent: 'blog' },
    'blog-elcom-preoccupata-inverno-2026': { name: 'Novità', path: '/articoli-frontaliere/elcom-preoccupata-inverno-2026', parent: 'blog' },
    'blog-balerna-2025-cifre-nere-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/balerna-2025-cifre-nere-frontalieri', parent: 'blog' },
    'blog-nuove-regole-scambio-informazioni-ader-enti-creditori': { name: 'Nuove regole AdER', path: '/articoli-frontaliere/nuove-regole-scambio-informazioni-ader-enti-creditori', parent: 'blog' },
    'blog-varese-solidale-2026-frontalieri': { name: 'Varese Solidale', path: '/articoli-frontaliere/varese-solidale-2026-frontalieri', parent: 'blog' },
    'blog-festa-mamma-palazzo-lombardia-2026': { name: 'Eventi', path: '/articoli-frontaliere/festa-mamma-palazzo-lombardia-2026', parent: 'blog' },
    'blog-casse-malati-frontalieri-ticino': { name: 'Casse malati', path: '/articoli-frontaliere/casse-malati-frontalieri-ticino', parent: 'blog' },
    'blog-artekrea-open-days-varese-2026': { name: 'Open Days ArteKrea', path: '/articoli-frontaliere/artekrea-open-days-varese-2026', parent: 'blog' },
    'blog-sanremo-eurovision-campione-2026': { name: 'Eventi', path: '/articoli-frontaliere/sanremo-eurovision-campione-2026', parent: 'blog' },
    'blog-morbio-inferiore-raccolta-vegetali-2026': { name: 'Raccolta vegetali', path: '/articoli-frontaliere/morbio-inferiore-raccolta-vegetali-2026', parent: 'blog' },
    'blog-centromedico-bellinzona-frontalieri': { name: 'Centromedico Bellinzona', path: '/articoli-frontaliere/centromedico-bellinzona-frontalieri', parent: 'blog' },
    'blog-lugano-passteggia-iscrizioni-aperte': { name: 'Lugano Passteggia', path: '/articoli-frontaliere/lugano-passteggia-iscrizioni-aperte', parent: 'blog' },
    'blog-pfas-filtrazione-san-antonino-2026': { name: 'PFAS San Antonino', path: '/articoli-frontaliere/pfas-filtrazione-san-antonino-2026', parent: 'blog' },
    'blog-incendio-auto-bellinzona-sud-2026': { name: 'Incendio auto Bellinzona', path: '/articoli-frontaliere/incendio-auto-bellinzona-sud-2026', parent: 'blog' },
    'blog-pari-opportunita-cultura-lugano-2026': { name: 'Novità', path: '/articoli-frontaliere/pari-opportunita-cultura-lugano-2026', parent: 'blog' },
    'blog-brasile-mari-froes-leo-middea-lugano': { name: 'Eventi Lugano', path: '/articoli-frontaliere/brasile-mari-froes-leo-middea-lugano', parent: 'blog' },
    'blog-cross-border-teleworking-2026': { name: 'Telelavoro frontalieri', path: '/articoli-frontaliere/cross-border-teleworking-2026', parent: 'blog' },
    'blog-fiera-antiquariato-mendrisio-2026': { name: 'Fiera Antiquariato', path: '/articoli-frontaliere/fiera-antiquariato-mendrisio-2026', parent: 'blog' },
    'blog-cure-dentarie-accessibili-ticino-2026': { name: 'Cure dentarie', path: '/articoli-frontaliere/cure-dentarie-accessibili-ticino-2026', parent: 'blog' },
    'blog-dolores-poretti-91-anni-frontalieri': { name: 'Storia di vita', path: '/articoli-frontaliere/dolores-poretti-91-anni-frontalieri', parent: 'blog' },
    'blog-costruzioni-ticino-impresari-investimenti-rapidi': { name: 'Costruzioni Ticino', path: '/articoli-frontaliere/costruzioni-ticino-impresari-investimenti-rapidi', parent: 'blog' },
    'blog-ex-pazienti-oncologici-aiutano-malati-ticino': { name: 'Progetto innovativo', path: '/articoli-frontaliere/ex-pazienti-oncologici-aiutano-malati-ticino', parent: 'blog' },
    'blog-picnic-stadio-cornaredo': { name: 'Grande festa popolare al Cornaredo', path: '/articoli-frontaliere/picnic-stadio-cornaredo', parent: 'blog' },
    'blog-malessere-polizia-cantonale-audit': { name: 'Audit Polizia', path: '/articoli-frontaliere/malessere-polizia-cantonale-audit', parent: 'blog' },
    'blog-desiderio-non-chiede-permesso-bufera-sui-cartelloni-di-un-locale-erotico': { name: 'Il desiderio non chiede permesso: bufera', path: '/articoli-frontaliere/desiderio-non-chiede-permesso-bufera-sui-cartelloni-di-un-locale-erotico', parent: 'blog' },
    'blog-friburgo-finale-europa-manzambi': { name: 'Novità', path: '/articoli-frontaliere/friburgo-finale-europa-manzambi', parent: 'blog' },
    'blog-legal-insurance-utilita-sicurezza': { name: 'Assicurazione legale', path: '/articoli-frontaliere/legal-insurance-utilita-sicurezza', parent: 'blog' },
    'blog-trump-dazi-corte-commercio-2026': { name: 'Novità', path: '/articoli-frontaliere/trump-dazi-corte-commercio-2026', parent: 'blog' },
    'blog-lipsia-pirata-strada-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/lipsia-pirata-strada-frontalieri', parent: 'blog' },
    'blog-lula-trump-riunione-democrazia-sovranita': { name: 'Novità', path: '/articoli-frontaliere/lula-trump-riunione-democrazia-sovranita', parent: 'blog' },
    'blog-delitto-garlasco-chiara-omicidio-2026': { name: 'Delitto Garlasco', path: '/articoli-frontaliere/delitto-garlasco-chiara-omicidio-2026', parent: 'blog' },
    'blog-hondius-frontalieri-ticino-2026': { name: 'Novità', path: '/articoli-frontaliere/hondius-frontalieri-ticino-2026', parent: 'blog' },
    'blog-harrods-risarcimenti-vittime-al-fayed': { name: 'Novità', path: '/articoli-frontaliere/harrods-risarcimenti-vittime-al-fayed', parent: 'blog' },
    'blog-trump-ue-accordo-commerciale-4-luglio': { name: 'Accordo commerciale', path: '/articoli-frontaliere/trump-ue-accordo-commerciale-4-luglio', parent: 'blog' },
    'blog-ginevra-manifestazione-frontalieri-2026': { name: 'Fiscale', path: '/articoli-frontaliere/ginevra-manifestazione-frontalieri-2026', parent: 'blog' },
    'blog-josi-fischer-lettera-cuore': { name: 'Sport', path: '/articoli-frontaliere/josi-fischer-lettera-cuore', parent: 'blog' },
    'blog-votazione-popolare-lamal-frontalieri': { name: 'Votazione LAMal', path: '/articoli-frontaliere/votazione-popolare-lamal-frontalieri', parent: 'blog' },
    'blog-maxi-blitz-cocaina-atlantico-30-tonnellate': { name: 'Novità', path: '/articoli-frontaliere/maxi-blitz-cocaina-atlantico-30-tonnellate', parent: 'blog' },
    'blog-giudici-federali-indagine-2026': { name: 'Indagine giudici', path: '/articoli-frontaliere/giudici-federali-indagine-2026', parent: 'blog' },
    'blog-centromedico-castello-chirurgia-ambulatoriale': { name: 'Sanità e assicurazioni', path: '/articoli-frontaliere/centromedico-castello-chirurgia-ambulatoriale', parent: 'blog' },
    'blog-arresto-commissario-fedpol-mafia': { name: 'Novità', path: '/articoli-frontaliere/arresto-commissario-fedpol-mafia', parent: 'blog' },
    'blog-processo-broker-vip-retrocessioni': { name: 'Processo broker VIP', path: '/articoli-frontaliere/processo-broker-vip-retrocessioni', parent: 'blog' },
    'blog-durisch-dado-blocco-frontalieri-ticino': { name: 'Notizie Ticino', path: '/articoli-frontaliere/durisch-dado-blocco-frontalieri-ticino', parent: 'blog' },
    'blog-frontalieri-lugano-chiarezza-2026': { name: 'Frontalieri Lugano', path: '/articoli-frontaliere/frontalieri-lugano-chiarezza-2026', parent: 'blog' },
    'blog-sgombero-macerie-lugano-amianto': { name: 'Sgombero macerie', path: '/articoli-frontaliere/sgombero-macerie-lugano-amianto', parent: 'blog' },
    'blog-lamanotesa-ch-dolore-bene-condiviso': { name: 'Giustizia riparativa', path: '/articoli-frontaliere/lamanotesa-ch-dolore-bene-condiviso', parent: 'blog' },
    'blog-lamal-low-cost-premi-bassi-2026': { name: 'LAMal low cost', path: '/articoli-frontaliere/lamal-low-cost-premi-bassi-2026', parent: 'blog' },
    'blog-grigioni-fattura-italia-olimpiadi': { name: 'Novità', path: '/articoli-frontaliere/grigioni-fattura-italia-olimpiadi', parent: 'blog' },
    'blog-untersander-ginevra-2026': { name: 'Novità', path: '/articoli-frontaliere/untersander-ginevra-2026', parent: 'blog' },
    'blog-dati-precalcolati-isa-2026-frontalieri': { name: 'Fiscale', path: '/articoli-frontaliere/dati-precalcolati-isa-2026-frontalieri', parent: 'blog' },
    'blog-frontalieri-ticino-stabili-2026-q1': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-ticino-stabili-2026-q1', parent: 'blog' },
    'blog-ricorso-patente-lavoro-varese-2026': { name: 'Ricorso patente', path: '/articoli-frontaliere/ricorso-patente-lavoro-varese-2026', parent: 'blog' },
    'blog-aggregazione-comuni-vedeggio-2026': { name: 'Aggregazione Comuni', path: '/articoli-frontaliere/aggregazione-comuni-vedeggio-2026', parent: 'blog' },
    'blog-giardino-ferroviario-balerna-2026': { name: 'Giardino ferroviario Balerna', path: '/articoli-frontaliere/giardino-ferroviario-balerna-2026', parent: 'blog' },
    'blog-vertigini-montagna-frontalieri': { name: 'Vertigini montagna', path: '/articoli-frontaliere/vertigini-montagna-frontalieri', parent: 'blog' },
    'blog-real-madrid-caos-rissa-tchouameni-valverde': { name: 'Sport', path: '/articoli-frontaliere/real-madrid-caos-rissa-tchouameni-valverde', parent: 'blog' },
    'blog-bioblitz-groane-2026-frontalieri': { name: 'Eventi', path: '/articoli-frontaliere/bioblitz-groane-2026-frontalieri', parent: 'blog' },
    'blog-joris-begevoord-intervista-aebr-2026': { name: 'Intervista AEBR', path: '/articoli-frontaliere/joris-begevoord-intervista-aebr-2026', parent: 'blog' },
    'blog-frontalieri-ticino-pokerce-dimezzati': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/frontalieri-ticino-pokerce-dimezzati', parent: 'blog' },
    'blog-frontalieri-orari-lavorativi-residenzialita': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/frontalieri-orari-lavorativi-residenzialita', parent: 'blog' },
    'blog-lumen-claro-premiati-varese-1989': { name: 'Lumen Claro', path: '/articoli-frontaliere/lumen-claro-premiati-varese-1989', parent: 'blog' },
    'blog-grandine-cislago-protezione-civile-2026': { name: 'Grandine a Cislago', path: '/articoli-frontaliere/grandine-cislago-protezione-civile-2026', parent: 'blog' },
    'blog-edoardo-leo-teatro-intred-varese-2026': { name: 'Eventi culturali', path: '/articoli-frontaliere/edoardo-leo-teatro-intred-varese-2026', parent: 'blog' },
    'blog-locarno-zanzara-tigre-campagna-rilancia-2026': { name: 'Campagna zanzara tigre', path: '/articoli-frontaliere/locarno-zanzara-tigre-campagna-rilancia-2026', parent: 'blog' },
    'blog-legge-foti-critica-economia-ticino': { name: 'Legge Foti', path: '/articoli-frontaliere/legge-foti-critica-economia-ticino', parent: 'blog' },
    'blog-progetto-eiger-palace-lugano-2026': { name: 'Progetto Eiger Palace', path: '/articoli-frontaliere/progetto-eiger-palace-lugano-2026', parent: 'blog' },
    'blog-cartelle-pagamento-cassazione-2026': { name: 'Fiscale', path: '/articoli-frontaliere/cartelle-pagamento-cassazione-2026', parent: 'blog' },
    'blog-crd-output-floor-ii-pilastro': { name: 'Fiscale', path: '/articoli-frontaliere/crd-output-floor-ii-pilastro', parent: 'blog' },
    'blog-ultimo-svizzero-rientra-incendio-crans-montana': { name: 'Notizie', path: '/articoli-frontaliere/ultimo-svizzero-rientra-incendio-crans-montana', parent: 'blog' },
    'blog-universita-insubria-premia-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/universita-insubria-premia-frontalieri', parent: 'blog' },
    'blog-incendio-gallarate-frontalieri-2026': { name: 'Incendio Gallarate', path: '/articoli-frontaliere/incendio-gallarate-frontalieri-2026', parent: 'blog' },
    'blog-cardada-cimetta-riapre-bikers-2024': { name: 'Cardada Cimetta', path: '/articoli-frontaliere/cardada-cimetta-riapre-bikers-2024', parent: 'blog' },
    'blog-frontalieri-ticino-8-maggio-2026': { name: 'Notizie per frontalieri', path: '/articoli-frontaliere/frontalieri-ticino-8-maggio-2026', parent: 'blog' },
    'blog-adam-walder-titolo-nazionale-under-14': { name: 'Sport', path: '/articoli-frontaliere/adam-walder-titolo-nazionale-under-14', parent: 'blog' },
    'blog-fart-2025-frontalieri-transporti': { name: 'Trasporti FART', path: '/articoli-frontaliere/fart-2025-frontalieri-transporti', parent: 'blog' },
    'blog-rimborso-cure-dentarie-ticino-2026': { name: 'Rimborso cure dentarie', path: '/articoli-frontaliere/rimborso-cure-dentarie-ticino-2026', parent: 'blog' },
    'blog-bolla-immobiliare-ticino-2026': { name: 'Bolla immobiliare', path: '/articoli-frontaliere/bolla-immobiliare-ticino-2026', parent: 'blog' },
    'blog-imprinting-saggio-architettura-italiana': { name: 'Architettura Italiana', path: '/articoli-frontaliere/imprinting-saggio-architettura-italiana', parent: 'blog' },
    'blog-pagaiate-internazionali-grigioni-ticino-2026': { name: 'Eventi sportivi', path: '/articoli-frontaliere/pagaiate-internazionali-grigioni-ticino-2026', parent: 'blog' },
    'blog-aquile-mannheim-coppa-spengler-2026': { name: 'Coppa Spengler', path: '/articoli-frontaliere/aquile-mannheim-coppa-spengler-2026', parent: 'blog' },
    'blog-incentivi-assunzioni-2026-sgravi-contributivi': { name: 'Incentivi assunzioni', path: '/articoli-frontaliere/incentivi-assunzioni-2026-sgravi-contributivi', parent: 'blog' },
    'blog-ddl-caregiver-frontalieri-ticino-2026': { name: 'Caregiver e frontalieri', path: '/articoli-frontaliere/ddl-caregiver-frontalieri-ticino-2026', parent: 'blog' },
    'blog-simona-waltert-ticino-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/simona-waltert-ticino-frontalieri', parent: 'blog' },
    'blog-bonnie-tyler-coma-farmacologico-2026': { name: 'Novità', path: '/articoli-frontaliere/bonnie-tyler-coma-farmacologico-2026', parent: 'blog' },
    'blog-nuovo-accordo-immobili-frontalieri-2026': { name: 'Fiscale', path: '/articoli-frontaliere/nuovo-accordo-immobili-frontalieri-2026', parent: 'blog' },
    'blog-nuova-riforma-avs-2024-frontalieri': { name: 'Riforma AVS', path: '/articoli-frontaliere/nuova-riforma-avs-2024-frontalieri', parent: 'blog' },
    'blog-lohnausweis-frontalieri-ticino': { name: 'Lohnausweis', path: '/articoli-frontaliere/lohnausweis-frontalieri-ticino', parent: 'blog' },
    'blog-emigrazione-cassa-pensione-risparmio-imposte': { name: 'Fiscale', path: '/articoli-frontaliere/emigrazione-cassa-pensione-risparmio-imposte', parent: 'blog' },
    'blog-nuovo-accordo-frontalieri-pilastro-2026': { name: 'Nuovo accordo frontalieri', path: '/articoli-frontaliere/nuovo-accordo-frontalieri-pilastro-2026', parent: 'blog' },
    'blog-chiasso-dogana-tempi-attesa': { name: 'Dogana Chiasso', path: '/articoli-frontaliere/chiasso-dogana-tempi-attesa', parent: 'blog' },
    'blog-stipendi-neolaureati-svizzera-austria-germania': { name: 'Fiscale', path: '/articoli-frontaliere/stipendi-neolaureati-svizzera-austria-germania', parent: 'blog' },
    'blog-nuove-basi-lpp-2025-frontalieri': { name: 'Pensioni', path: '/articoli-frontaliere/nuove-basi-lpp-2025-frontalieri', parent: 'blog' },
    'blog-aumenti-stipendi-svizzera-2026': { name: 'Aumenti stipendi', path: '/articoli-frontaliere/aumenti-stipendi-svizzera-2026', parent: 'blog' },
    'blog-lista-morosi-cassa-malati-ticino': { name: 'Lista morosi', path: '/articoli-frontaliere/lista-morosi-cassa-malati-ticino', parent: 'blog' },
    'blog-falegnami-stipendi-2025': { name: 'Fiscale', path: '/articoli-frontaliere/falegnami-stipendi-2025', parent: 'blog' },
    'blog-tasse-mance-frontalieri-ticino': { name: 'Fiscale', path: '/articoli-frontaliere/tasse-mance-frontalieri-ticino', parent: 'blog' },
    'blog-tasse-aeree-kerosene-2026': { name: 'Tasse aeree e kerosene', path: '/articoli-frontaliere/tasse-aeree-kerosene-2026', parent: 'blog' },
    'blog-nuovo-accordo-cremona-fisco-2026': { name: 'Fisco Oggi', path: '/articoli-frontaliere/nuovo-accordo-cremona-fisco-2026', parent: 'blog' },
    'blog-lapo-elkann-lucerna-2024': { name: 'Novità', path: '/articoli-frontaliere/lapo-elkann-lucerna-2024', parent: 'blog' },
    'blog-impatriati-fiscalita-frontalieri': { name: 'Impatriati e frontalieri', path: '/articoli-frontaliere/impatriati-fiscalita-frontalieri', parent: 'blog' },
    'blog-svizzeri-ottimisti-finanze-2026': { name: 'Novità', path: '/articoli-frontaliere/svizzeri-ottimisti-finanze-2026', parent: 'blog' },
    'blog-emolumenti-svizzera-tassazione-italia': { name: 'Fiscale', path: '/articoli-frontaliere/emolumenti-svizzera-tassazione-italia', parent: 'blog' },
    'blog-assicurazione-malattie-pilota-ticino': { name: 'Assicurazione malattie', path: '/articoli-frontaliere/assicurazione-malattie-pilota-ticino', parent: 'blog' },
    'blog-revoca-permesso-g-steiner-ticino': { name: 'Novità', path: '/articoli-frontaliere/revoca-permesso-g-steiner-ticino', parent: 'blog' },
    'blog-rientro-lento-a2-frontalieri': { name: 'Traffico e Mobilità', path: '/articoli-frontaliere/rientro-lento-a2-frontalieri', parent: 'blog' },
    'blog-addio-tutto-compreso-ai-costi': { name: 'AI e costi', path: '/articoli-frontaliere/addio-tutto-compreso-ai-costi', parent: 'blog' },
    'blog-arcidiacono-curia-lugano-2026': { name: 'Curia Lugano', path: '/articoli-frontaliere/arcidiacono-curia-lugano-2026', parent: 'blog' },
    'blog-simone-grossi-frontaliere-visp': { name: 'Novità', path: '/articoli-frontaliere/simone-grossi-frontaliere-visp', parent: 'blog' },
    'blog-blackout-internet-iran-70-giorni': { name: 'Novità', path: '/articoli-frontaliere/blackout-internet-iran-70-giorni', parent: 'blog' },
    'blog-rafforzare-sicurezza-bellinzona-2026': { name: 'Sicurezza Bellinzona', path: '/articoli-frontaliere/rafforzare-sicurezza-bellinzona-2026', parent: 'blog' },
    'blog-austria-ticino-ambasciatori-2026': { name: 'Novità', path: '/articoli-frontaliere/austria-ticino-ambasciatori-2026', parent: 'blog' },
    'blog-isa-liquidazione-frontalieri-2026': { name: 'Fiscale', path: '/articoli-frontaliere/isa-liquidazione-frontalieri-2026', parent: 'blog' },
    'blog-malattie-renali-campagna-cl3ar-milano': { name: 'Salute renale', path: '/articoli-frontaliere/malattie-renali-campagna-cl3ar-milano', parent: 'blog' },
    'blog-hantavirus-ginevrino-isolamento-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/hantavirus-ginevrino-isolamento-frontalieri', parent: 'blog' },
    'blog-pentagono-ufo-documenti-inediti-2026': { name: 'Novità', path: '/articoli-frontaliere/pentagono-ufo-documenti-inediti-2026', parent: 'blog' },
    'blog-croce-rossa-160-anni-tagli-educatori': { name: 'Novità', path: '/articoli-frontaliere/croce-rossa-160-anni-tagli-educatori', parent: 'blog' },
    'blog-servizi-dentari-scolastici-conflitti-interesse': { name: 'Servizi dentari scolastici', path: '/articoli-frontaliere/servizi-dentari-scolastici-conflitti-interesse', parent: 'blog' },
    'blog-pensioni-svantaggio-tasse-frontalieri': { name: 'Pensioni Frontalieri', path: '/articoli-frontaliere/pensioni-svantaggio-tasse-frontalieri', parent: 'blog' },
    'blog-takahashia-japonica-ticino-2026': { name: 'Pratico', path: '/articoli-frontaliere/takahashia-japonica-ticino-2026', parent: 'blog' },
    'blog-onorificenze-austriache-lugano-2024': { name: 'Novità', path: '/articoli-frontaliere/onorificenze-austriache-lugano-2024', parent: 'blog' },
    'blog-votazioni-svizzera-10-milioni-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/votazioni-svizzera-10-milioni-frontalieri', parent: 'blog' },
    'blog-modifiche-regolamento-antincendio-ticino-2026': { name: 'Protezione antincendio', path: '/articoli-frontaliere/modifiche-regolamento-antincendio-ticino-2026', parent: 'blog' },
    'blog-crans-montana-ore-straordinarie-non-pagate': { name: 'Ore straordinarie non pagate', path: '/articoli-frontaliere/crans-montana-ore-straordinarie-non-pagate', parent: 'blog' },
    'blog-lugano-calcio-frontalieri-2026': { name: 'FC Lugano', path: '/articoli-frontaliere/lugano-calcio-frontalieri-2026', parent: 'blog' },
    'blog-premiate-classi-acqua-vita-2026': { name: 'Novità', path: '/articoli-frontaliere/premiate-classi-acqua-vita-2026', parent: 'blog' },
    'blog-biasca-ucraina-aiuto-medico-2026': { name: 'Novità', path: '/articoli-frontaliere/biasca-ucraina-aiuto-medico-2026', parent: 'blog' },
    'blog-criptovalute-frontalieri-timing-perfetto': { name: 'Criptovalute', path: '/articoli-frontaliere/criptovalute-frontalieri-timing-perfetto', parent: 'blog' },
    'blog-super-ricco-tasse-frontalieri-ticino': { name: 'Fiscale', path: '/articoli-frontaliere/super-ricco-tasse-frontalieri-ticino', parent: 'blog' },
    'blog-interroll-acquisisce-royal-apollo-group': { name: 'Interroll acquisisce Royal Apollo Group', path: '/articoli-frontaliere/interroll-acquisisce-royal-apollo-group', parent: 'blog' },
    'blog-alpini-paracadutisti-genova-2026': { name: 'Alpini Genova', path: '/articoli-frontaliere/alpini-paracadutisti-genova-2026', parent: 'blog' },
    'blog-casa-hockey-lugano-frontalieri': { name: 'Novità Lugano Hockey', path: '/articoli-frontaliere/casa-hockey-lugano-frontalieri', parent: 'blog' },
    'blog-papa-leone-incontra-madre-frontaliere': { name: 'Novità', path: '/articoli-frontaliere/papa-leone-incontra-madre-frontaliere', parent: 'blog' },
    'blog-svizzera-sconfitta-svezia-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/svizzera-sconfitta-svezia-frontalieri', parent: 'blog' },
    'blog-tregua-ucraina-improbabile-cremlino': { name: 'Novità', path: '/articoli-frontaliere/tregua-ucraina-improbabile-cremlino', parent: 'blog' },
    'blog-incidente-tuta-alare-svizzera-2026': { name: 'Incidente in tuta alare', path: '/articoli-frontaliere/incidente-tuta-alare-svizzera-2026', parent: 'blog' },
    'blog-ghiacciai-svizzera-frontalieri': { name: 'Ghiacciai Svizzeri', path: '/articoli-frontaliere/ghiacciai-svizzera-frontalieri', parent: 'blog' },
    'blog-frontalieri-luino-caserma-fornasette': { name: 'Novità', path: '/articoli-frontaliere/frontalieri-luino-caserma-fornasette', parent: 'blog' },
    'blog-black-list-morosi-cassa-malati-ticino': { name: 'Black list morosi', path: '/articoli-frontaliere/black-list-morosi-cassa-malati-ticino', parent: 'blog' },
    'blog-documentario-claire-ghiringhelli-lugano': { name: 'Documentario Claire Ghiringhelli', path: '/articoli-frontaliere/documentario-claire-ghiringhelli-lugano', parent: 'blog' },
    'blog-malpensa-pista-riapre-frontalieri': { name: 'Malpensa pista 35L', path: '/articoli-frontaliere/malpensa-pista-riapre-frontalieri', parent: 'blog' },
    'blog-peter-magyar-ungheria-volta-pagina': { name: 'Novità', path: '/articoli-frontaliere/peter-magyar-ungheria-volta-pagina', parent: 'blog' },
    'blog-potere-dacquisto-ticino-2024': { name: 'Novità', path: '/articoli-frontaliere/potere-dacquisto-ticino-2024', parent: 'blog' },
    'blog-minivan-chioggia-frontalieri-incidente': { name: 'Incidente frontalieri', path: '/articoli-frontaliere/minivan-chioggia-frontalieri-incidente', parent: 'blog' },
    'blog-curiosita-rossocrociate-ticino-2026': { name: 'Tradizioni svizzere', path: '/articoli-frontaliere/curiosita-rossocrociate-ticino-2026', parent: 'blog' },
    'blog-malcontento-aeroporto-lugano-2026': { name: 'Novità', path: '/articoli-frontaliere/malcontento-aeroporto-lugano-2026', parent: 'blog' },
    'blog-chippis-ponte-demolito-sicurezza': { name: 'Chippis ponte sicurezza', path: '/articoli-frontaliere/chippis-ponte-demolito-sicurezza', parent: 'blog' },
    'blog-incidente-stradale-cittiglio-laveno': { name: 'Incidente stradale', path: '/articoli-frontaliere/incidente-stradale-cittiglio-laveno', parent: 'blog' },
    'blog-frontaliero-ossolano-morto-visp-autopsia': { name: 'Novità', path: '/articoli-frontaliere/frontaliero-ossolano-morto-visp-autopsia', parent: 'blog' },
    'blog-putin-ucraina-termine-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/putin-ucraina-termine-frontalieri', parent: 'blog' },
    'blog-cassa-malati-spacchettamento-ticino': { name: 'Cassa malati', path: '/articoli-frontaliere/cassa-malati-spacchettamento-ticino', parent: 'blog' },
    'blog-fedeli-chiedono-chiarezza-diocesi-2026': { name: 'Novità', path: '/articoli-frontaliere/fedeli-chiedono-chiarezza-diocesi-2026', parent: 'blog' },
    'blog-incidente-ispra-frontaliere-2026': { name: 'Incidente Ispra', path: '/articoli-frontaliere/incidente-ispra-frontaliere-2026', parent: 'blog' },
    'blog-basket-openjobmetis-bologna-2026': { name: 'Basket', path: '/articoli-frontaliere/basket-openjobmetis-bologna-2026', parent: 'blog' },
    'blog-blitz-droga-turate-frontalieri': { name: 'Blitz droga Turate', path: '/articoli-frontaliere/blitz-droga-turate-frontalieri', parent: 'blog' },
    'blog-crans-montana-audizioni-frontalieri': { name: 'Novità', path: '/articoli-frontaliere/crans-montana-audizioni-frontalieri', parent: 'blog' },
    'blog-sommer-bocciato-inter-frontalieri': { name: 'Calcio', path: '/articoli-frontaliere/sommer-bocciato-inter-frontalieri', parent: 'blog' },
    'blog-precompilata-2026-frontalieri-ticino': { name: 'Precompilata 2026', path: '/articoli-frontaliere/precompilata-2026-frontalieri-ticino', parent: 'blog' },
    'blog-arlotti-franchigia-frontalieri-letta': { name: 'Franchigia frontalieri', path: '/articoli-frontaliere/arlotti-franchigia-frontalieri-letta', parent: 'blog' },
    'blog-frontalieri-varese-10-maggio-2026': { name: 'Notizie frontalieri', path: '/articoli-frontaliere/frontalieri-varese-10-maggio-2026', parent: 'blog' },
    'blog-swiss-riduce-personale-amministrativo': { name: 'Swiss riduzione personale', path: '/articoli-frontaliere/swiss-riduce-personale-amministrativo', parent: 'blog' },
    'blog-palacinema-locarno-urgenti-2026': { name: 'Palacinema Locarno', path: '/articoli-frontaliere/palacinema-locarno-urgenti-2026', parent: 'blog' },
    'blog-venezia-ildegarda-frontalieri': { name: 'Venezia, esperienza sonora', path: '/articoli-frontaliere/venezia-ildegarda-frontalieri', parent: 'blog' },
    'blog-tre-arresti-rissa-ambrosino-cavalla': { name: 'Novità', path: '/articoli-frontaliere/tre-arresti-rissa-ambrosino-cavalla', parent: 'blog' },
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
 const { route: infoRoute } = parsePath(info.path);
 crumbs.push({
 name: getLocalizedSectionLabel(section, info.name),
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
 // so og:url, twitter:url, and canonical reflect the actual page URL.
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

 // FRO: Expired job soft-landing pages — preserve static HTML metadata.
 // When the SPA loads on an expired job URL, the build plugin already injected
 // correct title, meta description, canonical, and JobPosting JSON-LD into the
 // static HTML. If the job is NOT in the active dataset (jobSeo === null) and
 // the build plugin seeded expired job data, skip all dynamic metadata updates
 // to prevent overwriting with generic listing-page defaults.
 if (isJobDetailPage && !jobSeo) {
 try {
 const expiredData = (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
 if (expiredData && typeof expiredData === 'object' && 'slug' in (expiredData as Record<string, unknown>)) {
 return; // Preserve static HTML metadata for expired job pages
 }
 } catch { /* SSR or missing — continue with dynamic metadata */ }
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
 const localizedSeoContent = resolveLocalizedSeoContent(sectionKey, metadata, locale);
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
 try { jobCountLabel = await getActiveJobCountLabel(); } catch { /* keep null */ }
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
 const metaOgDescription = metaDescription;
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
 updateOrCreateMetaTag('name', 'description', metaDescription);
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
 : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';
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
 const resolvedImgUrl = imgUrl.startsWith('http') ? imgUrl : `${BASE_URL}${imgUrl}`;
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
 updateOrCreateMetaTag('name', 'twitter:image', resolvedImgUrl);
 } else {
 updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
 updateOrCreateMetaTag('property', 'og:image:width', '1200');
 updateOrCreateMetaTag('property', 'og:image:height', '630');
 updateOrCreateMetaTag('name', 'twitter:image', `${BASE_URL}/og-image.png`);
 }
 } else {
 if (jobSeo) {
 // Use branded og-image.png (1200×630) instead of tiny company logos (128px).
 // Google News/Discover require ≥1200px; social platforms recommend ≥600px.
 updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
 updateOrCreateMetaTag('property', 'og:image:width', '1200');
 updateOrCreateMetaTag('property', 'og:image:height', '630');
 updateOrCreateMetaTag('property', 'og:image:alt', metaOgTitle);
 updateOrCreateMetaTag('name', 'twitter:image', `${BASE_URL}/og-image.png`);
 } else {
 updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
 updateOrCreateMetaTag('property', 'og:image:width', '1200');
 updateOrCreateMetaTag('property', 'og:image:height', '630');
 updateOrCreateMetaTag('property', 'og:image:alt', metaOgTitle);
 updateOrCreateMetaTag('name', 'twitter:image', `${BASE_URL}/og-image.png`);
 }
 }

 // Article-specific OG tags for Google News & Bing News indexing
 if (isBlogArticle && blogArticleSd) {
 const sd = blogArticleSd;
 if (sd.datePublished) updateOrCreateMetaTag('property', 'article:published_time', sd.datePublished);
 if (sd.dateModified) updateOrCreateMetaTag('property', 'article:modified_time', sd.dateModified);
 if (sd.articleSection) updateOrCreateMetaTag('property', 'article:section', sd.articleSection);
 updateOrCreateMetaTag('property', 'article:author', `${BASE_URL}/chi-siamo/`);
 } else {
 // Remove article OG tags for non-article pages
 ['article:published_time', 'article:modified_time', 'article:section', 'article:author'].forEach(prop => {
 const el = document.querySelector(`meta[property="${prop}"]`);
 if (el) el.remove();
 });
 }

 // Update Twitter Card tags
 updateOrCreateMetaTag('name', 'twitter:card', 'summary_large_image');
 updateOrCreateMetaTag('name', 'twitter:title', metaOgTitle);
 updateOrCreateMetaTag('name', 'twitter:description', metaOgDescription);
 updateOrCreateMetaTag('name', 'twitter:url', `${BASE_URL}${canonicalLocalePath}`);

 // Update canonical URL (uses current locale path)
 updateCanonicalLink(`${BASE_URL}${canonicalLocalePath}`);

 // Update hreflang tags with locale-specific paths
 updateHreflangTags(route);

 // Update structured data if provided, always include breadcrumbs
 const breadcrumbs = buildBreadcrumbs(sectionKey, route, locale, hasLocalizedTitle ? localizedTitle : undefined);
 if (jobSeo?.structuredData) {
 updateStructuredData([jobSeo.structuredData, breadcrumbs]);
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
 'it': 'it_IT', 'en': 'en_US', 'de': 'de_CH', 'fr': 'fr_CH',
 };
 return localeMap[lang] || 'it_IT';
}

/**
 * Update hreflang link tags for multilingual SEO.
 * Now uses locale-specific paths from the i18n router
 * instead of ?lang= query parameters.
 */
function updateHreflangTags(route: import('./router').AppRoute): void {
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
