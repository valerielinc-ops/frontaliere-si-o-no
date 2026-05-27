/**
 * chatbotTools — Tool handlers for the AiChatbot.
 *
 * Exports `searchJobs`: a query → ranked job listings tool the LLM can call
 * when a user asks about job openings (e.g. "trova offerte infermiere a Lugano").
 *
 * Two-stage pipeline:
 * 1. Query extraction — tokenise + optional LLM-assisted structured extraction
 *    (canton, sector, contract type). Falls back to raw token match if the LLM
 *    extractor is unavailable or fails.
 * 2. Scoring — weighted token overlap across title/company/location/canton/
 *    category/contract, with exact-match boosts for canton and category.
 *
 * The jobs dataset can be injected (for tests) or fetched from /data/jobs.json
 * at runtime. Public: only the `searchJobs` function; everything else is
 * exported for testability.
 */

import { buildPath } from '@/services/router';

// ─── Types ────────────────────────────────────────────────────────────────

export type Locale = 'it' | 'en' | 'de' | 'fr';

/** Minimal shape of a job record consumed by the search tool. */
export interface JobRecord {
 slug: string;
 title: string;
 company: string;
 location?: string;
 canton?: string;
 category?: string;
 contract?: string;
 description?: string;
 requirements?: string;
 titleByLocale?: Partial<Record<Locale, string>>;
 slugByLocale?: Partial<Record<Locale, string>>;
}

export interface SearchJobsParams {
 query: string;
 locale: Locale;
 limit?: number;
 /** Pre-loaded jobs dataset (tests inject this; client code fetches if omitted). */
 jobs?: ReadonlyArray<JobRecord>;
 /** Optional structured extractor (LLM-backed). Falls back to heuristic on failure. */
 extractor?: (query: string) => Promise<ExtractedQuery | null>;
}

export interface SearchJobsResult {
 title: string;
 company: string;
 location: string;
 slug: string;
 url: string;
}

export interface ExtractedQuery {
 canton?: string;
 sector?: string;
 keywords: ReadonlyArray<string>;
 contract?: string;
}

// ─── Canonicalisation helpers ─────────────────────────────────────────────

/** Known Swiss canton aliases → canonical 2-letter code. */
const CANTON_ALIASES: Record<string, string> = {
 ticino: 'TI', ti: 'TI',
 grigioni: 'GR', graubunden: 'GR', grisons: 'GR', gr: 'GR',
 vallese: 'VS', wallis: 'VS', valais: 'VS', vs: 'VS',
 zurigo: 'ZH', zurich: 'ZH', 'zürich': 'ZH', zh: 'ZH',
 berna: 'BE', bern: 'BE', berne: 'BE', be: 'BE',
 lucerna: 'LU', luzern: 'LU', lucerne: 'LU', lu: 'LU',
 ginevra: 'GE', geneva: 'GE', 'genève': 'GE', genf: 'GE', ge: 'GE',
 basilea: 'BS', basel: 'BS', bale: 'BS', bs: 'BS',
 vaud: 'VD', waadt: 'VD', vd: 'VD',
};

/** City → canton hints (only high-signal, Ticino-heavy list). */
const CITY_TO_CANTON: Record<string, string> = {
 lugano: 'TI', bellinzona: 'TI', locarno: 'TI', mendrisio: 'TI', chiasso: 'TI',
 biasca: 'TI', manno: 'TI',
 coira: 'GR', chur: 'GR',
};

/** Sector/category aliases → canonical category key. */
const SECTOR_ALIASES: Record<string, string> = {
 infermiere: 'healthcare', infermieri: 'healthcare', infermier: 'healthcare',
 nurse: 'healthcare', nurses: 'healthcare',
 krankenschwester: 'healthcare', pflege: 'healthcare',
 infirmier: 'healthcare', 'infirmière': 'healthcare',
 sanitario: 'healthcare', medical: 'healthcare', health: 'healthcare', salute: 'healthcare',
 medico: 'healthcare', medici: 'healthcare', doctor: 'healthcare',
 finanza: 'finance', bank: 'finance', banca: 'finance', banker: 'finance',
 it: 'tech', informatica: 'tech', software: 'tech', developer: 'tech', sviluppatore: 'tech',
 ingegnere: 'engineering', engineer: 'engineering', ingegneria: 'engineering',
 vendita: 'sales', vendite: 'sales', sales: 'sales', commerciale: 'sales',
 marketing: 'marketing',
 logistica: 'logistics', logistics: 'logistics', magazzino: 'logistics',
 edilizia: 'construction', construction: 'construction', bau: 'construction',
 ristorazione: 'hospitality', hospitality: 'hospitality', hotel: 'hospitality',
};

/** Contract type aliases. */
const CONTRACT_ALIASES: Record<string, string> = {
 'full-time': 'full-time', fulltime: 'full-time', 'tempo pieno': 'full-time',
 'part-time': 'part-time', parttime: 'part-time', 'tempo parziale': 'part-time',
 stage: 'internship', tirocinio: 'internship', internship: 'internship', praktikum: 'internship',
 freelance: 'freelance', 'partita iva': 'freelance',
 contract: 'contract', contratto: 'contract',
};

/** Italian/English/generic stopwords — never used as search tokens. */
const STOPWORDS = new Set([
 'a', 'ad', 'al', 'alla', 'di', 'da', 'dal', 'del', 'della', 'e', 'ed', 'il', 'la', 'lo',
 'in', 'per', 'con', 'su', 'sul', 'sulla', 'un', 'una', 'uno', 'the', 'of', 'to', 'at',
 'on', 'for', 'with', 'and', 'or', 'as', 'an', 'is', 'be', 'cerca', 'cercare', 'cerco',
 'cerchi', 'trova', 'trovare', 'trovo', 'come', 'lavoro', 'offerte', 'offerta', 'annunci',
 'annuncio', 'posto', 'posti', 'posizione', 'posizioni', 'find', 'search', 'show', 'job',
 'jobs', 'mi', 'che', 'voglio', 'vorrei', 'would', 'like', 'want',
]);

/** Normalise a string: lowercase + strip diacritics + collapse whitespace. */
export function normaliseText(input: string): string {
 return String(input ?? '')
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .toLowerCase()
 .replace(/[^a-z0-9\s-]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

/** Tokenise a normalised string into non-stopword tokens of length ≥ 2. */
export function tokenise(input: string): string[] {
 const normalised = normaliseText(input);
 if (!normalised) return [];
 return normalised
 .split(/[\s-]+/)
 .filter(tok => tok.length >= 2 && !STOPWORDS.has(tok));
}

// ─── Heuristic extractor (no LLM required) ────────────────────────────────

/**
 * Heuristic structured extraction from a raw query string.
 * Produces the same shape as the LLM extractor for graceful fallback.
 * Exported for tests.
 */
export function extractQueryHeuristic(query: string): ExtractedQuery {
 const tokens = tokenise(query);
 let canton: string | undefined;
 let sector: string | undefined;
 let contract: string | undefined;
 const keywords: string[] = [];

 const normalisedFull = normaliseText(query);

 // Detect canton by alias or city
 for (const tok of tokens) {
 if (!canton && CANTON_ALIASES[tok]) canton = CANTON_ALIASES[tok];
 if (!canton && CITY_TO_CANTON[tok]) canton = CITY_TO_CANTON[tok];
 if (!sector && SECTOR_ALIASES[tok]) sector = SECTOR_ALIASES[tok];
 if (!contract && CONTRACT_ALIASES[tok]) contract = CONTRACT_ALIASES[tok];
 keywords.push(tok);
 }

 // Multi-word or hyphenated contract phrases (tokeniser splits on space AND hyphen,
 // so a raw-text scan is needed to catch "full-time", "part-time", "tempo pieno").
 if (!contract) {
 for (const [alias, canonical] of Object.entries(CONTRACT_ALIASES)) {
 if ((alias.includes(' ') || alias.includes('-')) && normalisedFull.includes(alias)) {
 contract = canonical;
 break;
 }
 }
 }

 return { canton, sector, keywords, contract };
}

// ─── Scoring ──────────────────────────────────────────────────────────────

interface ScoredJob {
 job: JobRecord;
 score: number;
}

/**
 * Score a single job against the extracted query.
 * Weights:
 * - exact canton match: +10
 * - exact category match: +8
 * - exact contract match: +4
 * - each keyword token found in title: +3
 * - in company: +2
 * - in location: +2
 * - in description/requirements: +1
 */
export function scoreJob(
 job: JobRecord,
 extracted: ExtractedQuery,
 locale: Locale,
): number {
 let score = 0;

 if (extracted.canton && job.canton && job.canton.toUpperCase() === extracted.canton.toUpperCase()) {
 score += 10;
 }
 if (extracted.sector && job.category && job.category.toLowerCase() === extracted.sector.toLowerCase()) {
 score += 8;
 }
 if (extracted.contract && job.contract && job.contract.toLowerCase() === extracted.contract.toLowerCase()) {
 score += 4;
 }

 const title = normaliseText(job.titleByLocale?.[locale] ?? job.title ?? '');
 const company = normaliseText(job.company ?? '');
 const location = normaliseText(job.location ?? '');
 const body = normaliseText(`${job.description ?? ''} ${job.requirements ?? ''}`);

 for (const kw of extracted.keywords) {
 if (kw.length < 2) continue;
 if (title.includes(kw)) score += 3;
 if (company.includes(kw)) score += 2;
 if (location.includes(kw)) score += 2;
 if (body.includes(kw)) score += 1;
 }

 return score;
}

// ─── URL building ─────────────────────────────────────────────────────────

/**
 * Build the public URL for a job in a given locale, using the locale-specific
 * slug when available (job.slugByLocale[locale]) and falling back to the
 * canonical slug otherwise. Exported for tests.
 */
export function buildJobUrl(job: JobRecord, locale: Locale): string {
 const localisedSlug = job.slugByLocale?.[locale];
 const slug = localisedSlug && localisedSlug.length > 0 ? localisedSlug : job.slug;
 return buildPath({ activeTab: 'job-board', jobSlug: slug }, locale);
}

// ─── Main entrypoint ──────────────────────────────────────────────────────

/** Safe dataset loader — returns [] on any error so the tool never throws. */
async function loadJobs(): Promise<JobRecord[]> {
 try {
 const res = await fetch('/data/jobs.json', { cache: 'force-cache' });
 if (!res.ok) return [];
 const data = await res.json();
 return Array.isArray(data) ? (data as JobRecord[]) : [];
 } catch {
 return [];
 }
}

/**
 * Search the jobs dataset for listings matching a natural-language query.
 * Returns the top N ranked jobs as compact objects suitable for display in
 * a chat bubble (title, company, location, slug, url).
 *
 * Never throws — returns [] on empty dataset, empty query, or extraction error.
 */
export async function searchJobs(
 params: SearchJobsParams,
): Promise<SearchJobsResult[]> {
 const { query, locale, limit = 5, jobs, extractor } = params;

 if (!query || !query.trim()) return [];
 const dataset = jobs ?? (await loadJobs());
 if (dataset.length === 0) return [];

 // Extract query structure (LLM if provided, else heuristic). Fallback on failure.
 let extracted: ExtractedQuery | null = null;
 if (extractor) {
 try {
 extracted = await extractor(query);
 } catch {
 extracted = null;
 }
 }
 if (!extracted) extracted = extractQueryHeuristic(query);

 // If the LLM returned no keywords, backfill from the heuristic tokeniser
 // so we always have something to score against.
 if (!extracted.keywords || extracted.keywords.length === 0) {
 extracted = { ...extracted, keywords: tokenise(query) };
 }

 // Score every job; drop zero-score entries so the caller never sees noise.
 const scored: ScoredJob[] = [];
 for (const job of dataset) {
 const score = scoreJob(job, extracted, locale);
 if (score > 0) scored.push({ job, score });
 }

 scored.sort((a, b) => b.score - a.score);

 const topN = scored.slice(0, Math.max(1, Math.min(limit, 20)));
 return topN.map(({ job }) => ({
 title: job.titleByLocale?.[locale] ?? job.title ?? '',
 company: job.company ?? '',
 location: job.location ?? '',
 slug: job.slugByLocale?.[locale] ?? job.slug,
 url: buildJobUrl(job, locale),
 }));
}
