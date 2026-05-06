/**
 * Related-search cluster landings — Vite build plugin.
 *
 * Phase 2 of canonicalizing the related-search URLs that the SPA's JobBoard
 * widget exposes (e.g. `/cerca-lavoro-ticino/ricerca-data-center-technician/`).
 * Phase 1 (audit script) populated `data/related-search-candidates.json`.
 * Phase B1 (AI enrichment) optionally populates
 * `data/related-search-enriched.json` with intro + 3-FAQ blocks per cluster.
 *
 * This plugin reads both files plus `data/jobs.json`, filters to clusters
 * with ≥5 emissions and no editorial collision, then emits one indexable
 * static HTML page per surviving cluster at:
 *   IT: /cerca-lavoro-ticino/ricerca-{slug-core}/
 *   EN: /en/find-jobs-ticino/search-{slug-core}/
 *   DE: /de/jobs-im-tessin/suche-{slug-core}/
 *   FR: /fr/trouver-emploi-tessin/recherche-{slug-core}/
 *
 * Mobile-first layout: the job-list section appears in source order BEFORE
 * any editorial filler (intro + FAQ go inside collapsed `<details>`). This
 * is critical — Googlebot reads source order, mobile users see source order
 * on collapse, and we MUST NOT inline 80 words above the listings.
 *
 * Hub index pages are emitted at:
 *   /{sectionLocalized}/{searchPrefix}/  (paginated at 200 entries / page)
 *
 * Anti-doorway mitigations:
 *   - Clusters with <3 matching jobs are SKIPPED entirely (no thin-content
 *     fallback) per CLAUDE.md non-negotiable rule #4.
 *   - Up to 30 jobs / page (cap).
 *   - Template intro is parameterized by jobCount + keyword + city +
 *     top-3-companies, so even when the AI cache is empty the body varies
 *     per-page.
 *   - When enrichment data has no FAQs for a cluster, the FAQ section is
 *     OMITTED rather than templated (better than fake content).
 *
 * Gates:
 *   - SKIP_RELATED_SEARCH_CLUSTERS=1 → fast-path exit, no files generated.
 *
 * The plugin DEGRADES GRACEFULLY when input files are missing (logs a
 * warning and returns 0 pages instead of failing the build).
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';

import { WriteCollector } from './batchWrite';
import { BASE_URL } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';
import { buildTitleWithBrand } from './shared/titleSuffix';
import {
  renderJobBoardCommuterContext,
  renderSearchQueryIntro,
  buildJobBoardCommuterFaqLd,
} from './shared/jobBoardCommuterContext';
import {
  getJobBoardSectionSlug,
  getSearchSlugPrefix,
} from '../services/relatedSearchClusters';
import type { Locale } from '../services/i18n';
import {
  COPY,
  KNOWN_CITIES,
  LOCALE_PREFIX,
  OG_LOCALE,
  SUPPORTED_LOCALES,
  type CandidateEntry,
  type CandidatesFile,
  type EnrichedEntry,
  type EnrichedFile,
  type LocaleCopy,
  type RawJob,
} from './relatedSearchClustersData';

// ── Constants ───────────────────────────────────────────────────────────

const MIN_JOB_COUNT = 5;
const MIN_MATCHING_JOBS = 3;
const MAX_JOBS_PER_PAGE = 30;
const HUB_PAGE_SIZE = 200;

// ── Utilities ───────────────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Lower-case + NFD-strip (handles Zürich/Zurich, Genève/Geneva, etc.). */
function normalizeText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Tokenize a query string into [normalized, length>=2] tokens. */
function tokenizeQuery(query: string): string[] {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2);
}

/**
 * Approximation of the SPA's `indexedQueryMatch` from JobBoard.tsx.
 * Each query token must appear as a substring of the normalized job
 * haystack. Stemming is intentionally skipped — at build time we cannot
 * afford the per-job stemming overhead. The shorter-token substring match
 * is permissive in the same direction the SPA's stemmer is permissive
 * (matches plurals, feminine forms) so the final job-list count is
 * essentially identical.
 */
function queryMatchesJob(haystack: string, queryTokens: ReadonlyArray<string>): boolean {
  if (queryTokens.length === 0) return false;
  for (const token of queryTokens) {
    if (!haystack.includes(token)) return false;
  }
  return true;
}

/** Build the per-locale normalized haystack once and cache it on the job. */
function buildJobHaystack(job: RawJob, locale: Locale): string {
  const title = job.titleByLocale?.[locale] ?? job.title ?? '';
  const description = job.descriptionByLocale?.[locale] ?? job.description ?? '';
  return normalizeText(`${title} ${job.company ?? ''} ${job.location ?? ''} ${description}`);
}

/** Detect a known city in a sample term (longest match wins). */
function detectCity(sampleTerm: string): string | null {
  if (!sampleTerm) return null;
  const lower = normalizeText(sampleTerm);
  const sortedCities = [...KNOWN_CITIES].sort((a, b) => b.length - a.length);
  for (const city of sortedCities) {
    const cityLower = normalizeText(city);
    const re = new RegExp(`(^|[\\s,/-])${cityLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,/-])`);
    if (re.test(lower)) return city;
  }
  return null;
}

/** Strip a trailing city occurrence from the sample term, returning the keyword. */
function stripCityFromKeyword(sampleTerm: string, city: string | null): string {
  if (!city) return sampleTerm.trim();
  const lowerCity = normalizeText(city);
  const lowerTerm = normalizeText(sampleTerm);
  const trailingRe = new RegExp(`[\\s,/-]+${lowerCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  if (!trailingRe.test(lowerTerm)) return sampleTerm.trim();
  return sampleTerm.replace(/[\s,/-]+\S+$/, '').trim() || sampleTerm.trim();
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function jobIdentity(job: RawJob): string {
  return job.slug || job.id || `${job.company}-${job.title}`;
}

// ── File loading ────────────────────────────────────────────────────────

function loadCandidates(rootDir: string): CandidateEntry[] {
  const candidatesPath = path.join(rootDir, 'data', 'related-search-candidates.json');
  if (!fs.existsSync(candidatesPath)) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m candidates file missing — skipping (soft).');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8')) as CandidatesFile;
    if (!Array.isArray(raw.candidates)) {
      console.warn('\x1b[33m[related-search-clusters]\x1b[0m candidates file has unexpected shape — skipping.');
      return [];
    }
    return raw.candidates;
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to parse candidates file:', err);
    return [];
  }
}

function loadEnriched(rootDir: string): Record<string, EnrichedEntry> {
  const enrichedPath = path.join(rootDir, 'data', 'related-search-enriched.json');
  if (!fs.existsSync(enrichedPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(enrichedPath, 'utf-8')) as EnrichedFile;
    return raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to parse enriched file:', err);
    return {};
  }
}

function loadJobs(rootDir: string): RawJob[] {
  const jobsPath = path.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m jobs.json missing — no listings will be rendered.');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as unknown;
    return Array.isArray(raw) ? (raw as RawJob[]) : [];
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to parse jobs.json:', err);
    return [];
  }
}

// ── Filtering & dedupe ──────────────────────────────────────────────────

interface ClusterContext {
  candidate: CandidateEntry;
  keyword: string;
  city: string | null;
  matchingJobs: RawJob[];
  topCompanies: string[];
}

function filterAndDedupeCandidates(all: CandidateEntry[]): CandidateEntry[] {
  const passing = all.filter((c) =>
    c.jobCount >= MIN_JOB_COUNT
    && c.editorialCollision === null
    && Array.isArray(c.sampleTerms)
    && c.sampleTerms.length > 0
    && SUPPORTED_LOCALES.includes(c.locale),
  );
  // Dedupe by `${locale}::${slug}`: keep the entry with the highest jobCount.
  const bySlug = new Map<string, CandidateEntry>();
  for (const c of passing) {
    const key = `${c.locale}::${c.slug}`;
    const existing = bySlug.get(key);
    if (!existing || (c.jobCount > existing.jobCount)) bySlug.set(key, c);
  }
  return Array.from(bySlug.values());
}

function buildClusterContext(
  candidate: CandidateEntry,
  haystackByLocale: Map<string, string>,
  jobs: ReadonlyArray<RawJob>,
): ClusterContext | null {
  const sampleTerm = (candidate.sampleTerms || [])[0] || '';
  if (!sampleTerm) return null;
  const city = detectCity(sampleTerm);
  const keyword = stripCityFromKeyword(sampleTerm, city);
  if (!keyword) return null;

  const tokens = tokenizeQuery(sampleTerm);
  if (tokens.length === 0) return null;

  const matching: RawJob[] = [];
  for (const job of jobs) {
    if (matching.length >= MAX_JOBS_PER_PAGE) break;
    const cacheKey = `${candidate.locale}::${jobIdentity(job)}`;
    let haystack = haystackByLocale.get(cacheKey);
    if (haystack === undefined) {
      haystack = buildJobHaystack(job, candidate.locale);
      haystackByLocale.set(cacheKey, haystack);
    }
    if (queryMatchesJob(haystack, tokens)) matching.push(job);
  }

  if (matching.length < MIN_MATCHING_JOBS) return null;

  const counts = new Map<string, number>();
  for (const j of matching) {
    const c = (j.company || '').trim();
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const topCompanies = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  return { candidate, keyword: keyword.trim(), city, matchingJobs: matching, topCompanies };
}

// ── Page emission ───────────────────────────────────────────────────────

interface PageInputs {
  ctx: ClusterContext;
  enriched: EnrichedEntry | undefined;
  hreflang: ReadonlyArray<{ locale: Locale; url: string }>;
  related: ReadonlyArray<{ keyword: string; url: string }>;
  distDir: string;
  dateStamp: string;
}

interface PageOutput {
  urlPath: string;
  html: string;
  loc: string;
}

/** Build the canonical URL path for a cluster page. */
function buildClusterPath(locale: Locale, slug: string): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/** Build the URL path for the per-locale hub. */
function buildHubPath(locale: Locale, page: number = 1): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  const sub = getSearchSlugPrefix(locale);
  const base = `${prefix}/${section}/${sub}/`.replace(/\/+/g, '/');
  return page > 1 ? `${base}page-${page}/` : base;
}

/** Build a localized job-detail URL. */
function jobLocalizedUrl(job: RawJob, locale: Locale): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  const slug = job.slugByLocale?.[locale] || job.slug || '';
  if (!slug) return `${BASE_URL}${prefix}/${section}/`.replace(/\/+/g, '/');
  return `${BASE_URL}${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/** Build the page headline. Keeps under 44 chars where possible. */
function buildHeadline(keyword: string, city: string | null): string {
  const kw = capitalize(keyword.trim());
  return city ? `${kw} a ${city}` : kw;
}

/** Build the meta description (120-160 chars). */
function buildDescription(ctx: ClusterContext, locale: Locale): string {
  const tagline = COPY[locale].taglineSingular(ctx.matchingJobs.length, ctx.keyword, ctx.city);
  const head = ctx.topCompanies.length > 0 ? ` ${ctx.topCompanies.slice(0, 2).join(', ')}.` : '';
  const out = `${tagline}${head}`.trim();
  return out.length > 158 ? `${out.slice(0, 157)}…` : out;
}

/**
 * Detect a high-level sector label from the keyword. Used to vary the FAQ
 * copy in `renderJobBoardCommuterContext` so 1,400 cluster pages don't all
 * surface the same "Are Italian qualifications recognised?" answer text.
 *
 * Returns null when no confident match — the helper falls back to a
 * locale-agnostic generic in that case.
 */
function detectSectorLabel(keyword: string, locale: Locale): string | null {
  const k = normalizeText(keyword);
  // Healthcare cluster (covers nurses, doctors, OSS, paramedics).
  if (/(nurs|inferm|oss|sanit|health|krank|gesund|sant|medic|doctor|arzt)/.test(k)) {
    return locale === 'it' ? 'sanità' : locale === 'en' ? 'healthcare' : locale === 'de' ? 'Gesundheitswesen' : 'santé';
  }
  // Tech / engineering cluster.
  if (/(tech|dev|engin|ingegn|sviluppo|software|data|IT|informatic|programm)/.test(k)) {
    return locale === 'it' ? 'tecnologia' : locale === 'en' ? 'technology' : locale === 'de' ? 'Technologie' : 'technologie';
  }
  // Banking / finance cluster.
  if (/(bank|financ|wealth|fiscal|conta|account|gestione patrimoni|finanz)/.test(k)) {
    return locale === 'it' ? 'banche e finanza' : locale === 'en' ? 'banking and finance' : locale === 'de' ? 'Banken und Finanzen' : 'banque et finance';
  }
  // Logistics / transport.
  if (/(autista|logistic|transport|driver|fahrer|chauffeur|magazz|warehouse)/.test(k)) {
    return locale === 'it' ? 'logistica e trasporti' : locale === 'en' ? 'logistics and transport' : locale === 'de' ? 'Logistik und Transport' : 'logistique et transport';
  }
  // Hospitality / restaurants.
  if (/(cuoc|chef|cameri|hotel|ristor|gastro|restaur|kellner|serveur)/.test(k)) {
    return locale === 'it' ? 'ristorazione e ospitalità' : locale === 'en' ? 'hospitality' : locale === 'de' ? 'Gastronomie und Hotellerie' : 'restauration et hôtellerie';
  }
  // Construction / manual.
  if (/(muratore|builder|constru|bau|carpent|elettricista|electric|idraulic|plumb)/.test(k)) {
    return locale === 'it' ? 'edilizia' : locale === 'en' ? 'construction' : locale === 'de' ? 'Bauwesen' : 'bâtiment';
  }
  // Education.
  if (/(insegn|teach|docent|lehr|prof|education|formaz)/.test(k)) {
    return locale === 'it' ? 'istruzione' : locale === 'en' ? 'education' : locale === 'de' ? 'Bildung' : 'éducation';
  }
  return null;
}

/** Localised copy for the cluster page (search bar, chrome, fallbacks). */
interface ClusterChromeCopy {
  searchPlaceholder: string;
  /** "Searching for" pseudo-label inside the searchbar (visible cue). */
  searchingFor: string;
  /** Active-filter chip label prefix (e.g. "query:"). */
  filterChipPrefix: string;
  /** "Read more about this search" summary on the bottom <details>. */
  contextSummary: string;
  /** Region fallback when no city is detected (used for commuter copy). */
  regionFallback: string;
  /** "Frontaliere region" — used inside H1 to differ from <title>. */
  regionH1Suffix: string;
  /** Aria label for active filters group. */
  activeFiltersLabel: string;
  /** Visually-hidden label announcing the result count. */
  resultsCountLabel: (n: number) => string;
}

const CHROME_COPY: Record<Locale, ClusterChromeCopy> = {
  it: {
    searchPlaceholder: 'Cerca per ruolo, azienda o città…',
    searchingFor: 'Risultati per',
    filterChipPrefix: 'ricerca',
    contextSummary: 'Approfondimento: come funziona questa ricerca per i frontalieri',
    regionFallback: 'Ticino',
    regionH1Suffix: 'in Ticino',
    activeFiltersLabel: 'Filtri attivi',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'offerta trovata' : 'offerte trovate'}`,
  },
  en: {
    searchPlaceholder: 'Search by role, company or city…',
    searchingFor: 'Results for',
    filterChipPrefix: 'search',
    contextSummary: 'More about this search for cross-border applicants',
    regionFallback: 'Ticino',
    regionH1Suffix: 'in Ticino',
    activeFiltersLabel: 'Active filters',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'job found' : 'jobs found'}`,
  },
  de: {
    searchPlaceholder: 'Suche nach Rolle, Unternehmen oder Stadt…',
    searchingFor: 'Ergebnisse für',
    filterChipPrefix: 'Suche',
    contextSummary: 'Mehr zu dieser Suche für Grenzgänger',
    regionFallback: 'Tessin',
    regionH1Suffix: 'im Tessin',
    activeFiltersLabel: 'Aktive Filter',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'Stelle gefunden' : 'Stellen gefunden'}`,
  },
  fr: {
    searchPlaceholder: 'Recherche par poste, entreprise ou ville…',
    searchingFor: 'Résultats pour',
    filterChipPrefix: 'recherche',
    contextSummary: 'En savoir plus sur cette recherche pour les frontaliers',
    regionFallback: 'Tessin',
    regionH1Suffix: 'au Tessin',
    activeFiltersLabel: 'Filtres actifs',
    resultsCountLabel: (n) => `${n} ${n === 1 ? 'offre trouvée' : 'offres trouvées'}`,
  },
};

// Cluster page rendering deliberately does NOT emit a static searchbar
// replica, active-filter chip, or JobCard grid in the body. The SPA's
// JobBoard component renders all of those (and they actually function)
// on hydration via `parseSearchSlugFilter`. The previous static replicas
// looked interactive but were dead — UX regression. The static body now
// contains only crawler-facing prose; see `renderClusterPage` below.

/** Build all JSON-LD scripts for a cluster page. */
function buildJsonLd(opts: {
  ctx: ClusterContext;
  canonicalUrl: string;
  enriched: EnrichedEntry | undefined;
  locale: Locale;
  commuterLocation: string;
  sectorLabel: string | null;
}): string[] {
  const { ctx, canonicalUrl, enriched, locale, commuterLocation, sectorLabel } = opts;
  const headline = buildHeadline(ctx.keyword, ctx.city);
  const copy = COPY[locale];
  const sectionUrl = `${BASE_URL}${LOCALE_PREFIX[locale]}/${getJobBoardSectionSlug(locale)}/`.replace(/\/+/g, '/');

  // ItemList JSON-LD intentionally NOT emitted: the static body no longer
  // visibly lists the jobs (the SPA renders them via JobBoard hydration),
  // and Google's structured-data policy requires structured data to match
  // visible content. Job listings are still surfaced via the SPA-rendered
  // JobCard grid, which Google indexes after JS execution.
  const breadcrumb = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.homeBreadcrumb, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.jobsBreadcrumb, item: sectionUrl },
      { '@type': 'ListItem', position: 3, name: headline, item: canonicalUrl },
    ],
  });

  const out = [breadcrumb];

  // FAQPage from AI-enriched data (when present).
  if (enriched?.faqs && enriched.faqs.length >= 1) {
    out.push(JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: enriched.faqs.map((q) => ({
        '@type': 'Question',
        name: q.question,
        acceptedAnswer: { '@type': 'Answer', text: q.answer },
      })),
    }));
  }

  // Commuter-context FAQPage: a separate JSON-LD object containing the
  // 4 frontaliere-relevant Q&A from `renderJobBoardCommuterContext`.
  // Google merges multiple FAQPage entries on the same page, so emitting
  // both alongside the AI block is safe and surfaces more rich-result
  // candidates.
  out.push(buildJobBoardCommuterFaqLd({
    locale: locale as 'it' | 'en' | 'de' | 'fr',
    location: commuterLocation,
    sectorOrType: sectorLabel,
  }));

  return out;
}

function renderHreflang(
  hreflang: ReadonlyArray<{ locale: Locale; url: string }>,
  fallbackUrl: string,
): string {
  // Per audit:hreflang gate: a page WITH hreflang must declare all 4 locales
  // + x-default (5 entries minimum). Most clusters exist in only 1-2 locales,
  // so emitting partial hreflang trips the [tooFew] check. Strategy: only
  // emit hreflang when we have ALL 4 locale alternates; otherwise omit
  // entirely (single-locale pages don't need hreflang and the audit doesn't
  // flag pages with zero hreflang entries).
  const distinctLocales = new Set(hreflang.map((h) => h.locale));
  if (distinctLocales.size < 4) return '';
  const lines: string[] = [];
  for (const alt of hreflang) {
    lines.push(`    <link rel="alternate" hreflang="${alt.locale}" href="${alt.url}">`);
  }
  const itAlt = hreflang.find((h) => h.locale === 'it');
  const xDefaultUrl = itAlt?.url || hreflang[0]?.url || fallbackUrl;
  lines.push(`    <link rel="alternate" hreflang="x-default" href="${xDefaultUrl}">`);
  return lines.join('\n');
}

/** Render a single cluster page. */
function renderClusterPage(inputs: PageInputs): PageOutput {
  const { ctx, enriched, hreflang, related, distDir, dateStamp } = inputs;
  const { candidate } = ctx;
  const locale = candidate.locale;
  const copy = COPY[locale];
  const chrome = CHROME_COPY[locale];

  const urlPath = buildClusterPath(locale, candidate.slug);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const headline = buildHeadline(ctx.keyword, ctx.city);
  const tagline = copy.taglineSingular(ctx.matchingJobs.length, ctx.keyword, ctx.city);
  const description = buildDescription(ctx, locale);

  // Resolve the location used by the commuter-context helper. When the
  // cluster has a city, use it directly (the helper recognises Lugano,
  // Mendrisio, Chiasso, Bellinzona, Locarno, Stabio and surfaces TILO/
  // crossing data). Otherwise fall back to the regional name and pass
  // omitCommute to skip the city-specific table.
  const commuterLocation = ctx.city || chrome.regionFallback;
  const sectorLabel = detectSectorLabel(ctx.keyword, locale);

  const jsonLdScripts = buildJsonLd({ ctx, canonicalUrl, enriched, locale, commuterLocation, sectorLabel });
  const hreflangHtml = renderHreflang(hreflang, canonicalUrl);

  // ── Strategy: SPA renders the interactive UI for users; static page
  // emits ONLY crawler-facing prose (collapsed `<details>`) below `#root`.
  // The wrapper class `cluster-seo-prose` is intentionally NOT
  // `seo-static-content` — that lets the SPA's lite-shell detector miss
  // the marker and hydrate `#root` with its full JobBoard search-query UI
  // (working searchbar + filter chips + JobCard grid + pagination from
  // `parseSearchSlugFilter`). User sees a fully-functional search-results
  // view; crawlers index the prose section that lives below `#root`.

  const sectionUrl = `${BASE_URL}${LOCALE_PREFIX[locale]}/${getJobBoardSectionSlug(locale)}/`.replace(/\/+/g, '/');

  // H1 must differ from <title> (audit:h1-title-duplicates is zero-tolerance).
  // Append a city/region suffix + count so the H1 (e.g. "Data Center
  // Technician — 12 offerte aperte in Ticino") never matches the title
  // (which is just the headline + brand) under the audit's case+whitespace-
  // insensitive comparison.
  const regionPart = ctx.city ? '' : ` ${chrome.regionH1Suffix}`;
  const headlineH1 = `${headline} — ${ctx.matchingJobs.length} ${copy.jobsHeading.toLowerCase()}${regionPart}`;

  // Top companies / cities for the search-query intro paragraph (used by
  // `renderSearchQueryIntro` to vary opening framing per page).
  const topCities = Array.from(
    new Set(
      ctx.matchingJobs
        .map((j) => (j.location || '').trim())
        .filter((l) => l.length > 0),
    ),
  ).slice(0, 5);

  // ── BOTTOM: SEO prose block (collapsed by default on mobile) ─────
  // Source-order placement: AFTER the job grid + CTA so mobile users
  // see meaty content first (CLAUDE.md non-negotiable rule #14). The
  // <details> wraps both the AI intro (when present) / search-query
  // template and the commuter-context block — combined ~5-7 KB of
  // unique prose per page (varies by query/city/sector hash so 1,400
  // pages don't share boilerplate).
  const aiIntroHtml = enriched?.intro
    ? `<p style="margin:0 0 14px;line-height:1.65">${esc(enriched.intro)}</p>`
    : renderSearchQueryIntro(
        locale as 'it' | 'en' | 'de' | 'fr',
        ctx.keyword,
        ctx.matchingJobs.length,
        ctx.topCompanies,
        topCities,
      );

  // AI-enriched FAQ block (when available). Rendered as <dl> for clarity;
  // FAQPage JSON-LD for these is emitted separately via `buildJsonLd`.
  const aiFaqHtml = enriched?.faqs && enriched.faqs.length > 0
    ? `<section style="margin:24px 0 0">
        <h3 style="font-size:18px;font-weight:700;color:var(--color-heading);margin:0 0 10px">${esc(copy.faqSummary)}</h3>
        ${enriched.faqs.map((q) =>
          `<details style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:12px;padding:12px 14px;margin-bottom:6px"><summary style="font-weight:600;cursor:pointer;color:var(--color-heading)">${esc(q.question)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.6">${esc(q.answer)}</p></details>`,
        ).join('')}
      </section>`
    : '';

  // Commuter-context prose: 5-7 KB methodology + city-specific commute
  // table + salary breakdown + scenario callout + 4-FAQ + cross-links.
  const commuterContextHtml = renderJobBoardCommuterContext({
    locale: locale as 'it' | 'en' | 'de' | 'fr',
    location: commuterLocation,
    sectorOrType: sectorLabel,
    omitCommute: !ctx.city,
  });

  // Related-search cross-links (same-city, different-keyword) — kept at
  // the bottom of the prose block for crawlability and to avoid pushing
  // editorial filler above the fold.
  const relatedHtml = related.length > 0
    ? `<nav aria-label="${esc(copy.relatedHeading)}" class="rsc-related" style="margin:24px 0 0;padding:18px 0;border-top:1px solid var(--color-edge)">
        <h3 style="margin:0 0 10px;font-size:18px;font-weight:700;color:var(--color-heading)">${esc(copy.relatedHeading)}</h3>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px">${related.map((r) => `<li><a href="${esc(r.url)}" style="${LINK_ACCENT_STYLE};display:inline-block;padding:4px 10px;background:var(--color-surface);border:1px solid var(--color-edge);border-radius:9999px;font-size:13px">${esc(r.keyword)}</a></li>`).join('')}</ul>
      </nav>`
    : '';

  const seoContextBlock = `<details class="cluster-seo-context" style="margin:32px 0 0;padding:0;border-top:1px solid var(--color-edge)">
    <summary style="margin-top:18px;padding:10px 14px;cursor:pointer;color:var(--color-link);font-weight:600;font-size:15px;list-style:none">${esc(chrome.contextSummary)}</summary>
    <div style="padding:8px 0 0">
      <section style="max-width:860px;margin:0;color:var(--color-body);line-height:1.65;font-size:15px">
        ${aiIntroHtml}
      </section>
      ${aiFaqHtml}
      ${commuterContextHtml}
      ${relatedHtml}
    </div>
  </details>`;

  // ── Body ────────────────────────────────────────────────────────
  // Crawler-facing static body (lives in `<main class="cluster-seo-prose">`
  // BELOW `#root`). Source order: breadcrumb + H1 + tagline (heading
  // hierarchy for SEO), then the collapsed prose `<details>`. Users see
  // the SPA's hydrated JobBoard UI inside `#root` ABOVE this main; the
  // prose is below the fold and folds out only when expanded — satisfies
  // CLAUDE.md non-negotiable rule #14 (filler must not push real content
  // below the fold).
  const bodyHtml = `<div class="related-search-cluster" style="max-width:1100px;margin:0 auto;padding:24px 16px 56px;color:var(--color-body)">
    <nav aria-label="${esc(copy.searchBreadcrumb)}" style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.homeBreadcrumb)}</a>
      <span> / </span>
      <a href="${esc(sectionUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.jobsBreadcrumb)}</a>
      <span> / </span>
      <span>${esc(headline)}</span>
    </nav>
    <header style="margin-bottom:18px">
      <p style="margin:0 0 6px;color:var(--color-subtle);font-size:13px">${esc(dateStamp)}</p>
      <h1 style="margin:0 0 8px;font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.18;color:var(--color-heading)">${esc(headlineH1)}</h1>
      <p style="margin:0;color:var(--color-body);font-size:15px;line-height:1.55;max-width:820px">${esc(tagline)}</p>
    </header>
    ${seoContextBlock}
  </div>`;

  const title = buildTitleWithBrand(headline);

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml,
    jsonLdScripts,
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
    // Opt OUT of `seo-static-content` lite-shell trigger so the SPA
    // hydrates `#root` and renders the working JobBoard search-query UI
    // (parseSearchSlugFilter populates the searchbar, JobBoard renders
    // results, filters work). The static `<main>` below is crawler-only.
    seoMainClass: 'cluster-seo-prose',
  });

  return { urlPath, html, loc: canonicalUrl };
}

// ── Hub index pages ─────────────────────────────────────────────────────

interface HubItem {
  keyword: string;
  city: string | null;
  url: string;
  slug: string;
}

interface HubPageInput {
  locale: Locale;
  items: ReadonlyArray<HubItem>;
  page: number;
  totalPages: number;
  distDir: string;
  dateStamp: string;
}

function groupByCity(items: ReadonlyArray<HubItem>): { byCity: Map<string, HubItem[]>; uncategorized: HubItem[] } {
  const byCity = new Map<string, HubItem[]>();
  const uncategorized: HubItem[] = [];
  for (const it of items) {
    if (it.city) {
      const arr = byCity.get(it.city) ?? [];
      arr.push(it);
      byCity.set(it.city, arr);
    } else {
      uncategorized.push(it);
    }
  }
  return { byCity, uncategorized };
}

/** Render a full page navigator (every page-N is linked — BFS depth gate). */
function renderPageNavigator(locale: Locale, totalPages: number, currentPage: number): string {
  if (totalPages <= 1) return '';
  const copy = COPY[locale];
  const links: string[] = [];
  for (let p = 1; p <= totalPages; p++) {
    const url = buildHubPath(locale, p);
    if (p === currentPage) {
      links.push(`<span style="padding:6px 10px;border-radius:8px;background:var(--color-accent);color:var(--color-on-accent);font-weight:700">${p}</span>`);
    } else {
      links.push(`<a href="${esc(url)}" style="${LINK_ACCENT_STYLE};padding:6px 10px;border-radius:8px;border:1px solid var(--color-edge);background:var(--color-surface)">${p}</a>`);
    }
  }
  return `<nav aria-label="${esc(copy.pageNavigatorLabel)}" style="display:flex;flex-wrap:wrap;gap:6px;margin:24px 0">${links.join('')}</nav>`;
}

function renderHubPage(input: HubPageInput): { urlPath: string; html: string; loc: string } {
  const { locale, items, page, totalPages, distDir, dateStamp } = input;
  const copy = COPY[locale];
  const urlPath = buildHubPath(locale, page);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  const { byCity, uncategorized } = groupByCity(items);
  const sortedCities = Array.from(byCity.keys()).sort((a, b) => a.localeCompare(b, locale));

  const cityBlocks = sortedCities.map((city) => {
    const list = (byCity.get(city) || []).sort((a, b) => a.keyword.localeCompare(b.keyword, locale));
    return `<section style="margin:0 0 22px">
      <h3 style="margin:0 0 8px;font-size:18px">${esc(city)}</h3>
      <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px">${list.map((it) => `<li><a href="${esc(it.url)}" style="${LINK_ACCENT_STYLE}">${esc(capitalize(it.keyword))}</a></li>`).join('')}</ul>
    </section>`;
  }).join('');

  const sortedUncat = [...uncategorized].sort((a, b) => a.keyword.localeCompare(b.keyword, locale));
  const uncatBlock = sortedUncat.length > 0
    ? `<section style="margin:0 0 22px">
        <h3 style="margin:0 0 8px;font-size:18px">${esc(copy.alphabeticalLabel)}</h3>
        <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px">${sortedUncat.map((it) => `<li><a href="${esc(it.url)}" style="${LINK_ACCENT_STYLE}">${esc(capitalize(it.keyword))}</a></li>`).join('')}</ul>
      </section>`
    : '';

  const navigator = renderPageNavigator(locale, totalPages, page);
  const sectionUrl = `${BASE_URL}${LOCALE_PREFIX[locale]}/${getJobBoardSectionSlug(locale)}/`.replace(/\/+/g, '/');

  const collectionLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: copy.hubTitle,
    url: canonicalUrl,
    description: copy.hubDescription,
    inLanguage: locale,
    dateModified: new Date().toISOString(),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.slice(0, 100).map((it, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: capitalize(it.keyword),
        url: it.url,
      })),
    },
  });
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.homeBreadcrumb, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.jobsBreadcrumb, item: sectionUrl },
      { '@type': 'ListItem', position: 3, name: copy.searchBreadcrumb, item: canonicalUrl },
    ],
  });

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:24px 16px 56px;color:var(--color-body)">
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.homeBreadcrumb)}</a>
      <span> / </span>
      <a href="${esc(sectionUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.jobsBreadcrumb)}</a>
      <span> / </span>
      <span>${esc(copy.searchBreadcrumb)}</span>
    </nav>
    <header style="margin-bottom:18px">
      <h1 style="margin:0 0 10px;font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.18">${esc(copy.hubH1)}${page > 1 ? ` — ${copy.pageNavigatorLabel} ${page}` : ''}</h1>
      <p class="lede" style="margin:0;color:var(--color-body);font-size:16px;line-height:1.55;max-width:820px">${esc(copy.hubIntro(items.length))}</p>
      <p style="margin:6px 0 0;color:var(--color-subtle);font-size:13px">${esc(dateStamp)}</p>
    </header>
    ${sortedCities.length > 0 ? `<section style="margin:0 0 12px"><h2 style="margin:0 0 12px;font-size:22px">${esc(copy.citySectionLabel)}</h2>${cityBlocks}</section>` : ''}
    ${uncatBlock}
    ${navigator}
  </article>`;

  const title = buildTitleWithBrand(`${copy.hubTitle}${page > 1 ? ` — ${copy.pageNavigatorLabel} ${page}` : ''}`);
  const html = buildSeoPageHtml({
    locale,
    title,
    description: copy.hubDescription,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: '',
    jsonLdScripts: [breadcrumbLd, collectionLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
  });

  return { urlPath, html, loc: canonicalUrl };
}

// ── Section landing post-process ────────────────────────────────────────

/**
 * Inject a link to the per-locale hub into the existing job-board section
 * landing (emitted by `jobsSeoPagesPlugin`). Keeps the hub at BFS depth
 * ≤4 from `/`. If the section landing is missing (jobs plugin skipped),
 * we log a warning and skip — never fail.
 */
function injectHubLinkIntoSectionLanding(
  distDir: string,
  locale: Locale,
  hubUrl: string,
  copy: LocaleCopy,
): void {
  const prefix = LOCALE_PREFIX[locale];
  const section = getJobBoardSectionSlug(locale);
  const sectionPath = path.join(distDir, prefix.replace(/^\//, ''), section, 'index.html');
  if (!fs.existsSync(sectionPath)) {
    console.warn(`\x1b[33m[related-search-clusters]\x1b[0m section landing missing at ${sectionPath} — skipping hub link injection.`);
    return;
  }

  let html: string;
  try {
    html = fs.readFileSync(sectionPath, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to read section landing:', err);
    return;
  }

  // Idempotent: skip if our marker is already present.
  if (html.includes('data-related-search-hub-link="1"')) return;

  const linkBlock = `<nav data-related-search-hub-link="1" aria-label="${esc(copy.searchBreadcrumb)}" style="max-width:1100px;margin:24px auto 0;padding:0 16px"><a href="${esc(hubUrl)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.hubH1)} →</a></nav>`;

  let patched: string | null = null;
  if (html.includes('<!-- end:job-board-main -->')) {
    patched = html.replace('<!-- end:job-board-main -->', `${linkBlock}\n<!-- end:job-board-main -->`);
  } else if (html.includes('</main>')) {
    patched = html.replace('</main>', `${linkBlock}\n</main>`);
  }

  if (!patched) {
    console.warn(`\x1b[33m[related-search-clusters]\x1b[0m no insertion anchor in ${sectionPath} — skipping.`);
    return;
  }

  try {
    fs.writeFileSync(sectionPath, patched, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to write section landing:', err);
  }
}

// ── Sitemap ─────────────────────────────────────────────────────────────

function writeSitemap(distDir: string, locs: ReadonlyArray<string>, dateStamp: string): void {
  if (locs.length === 0) return;
  const entries = locs.map((loc) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`,
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
  const sitemapPath = path.join(distDir, 'sitemap-search-clusters.xml');
  try {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(sitemapPath, xml, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m sitemap write failed:', err);
    return;
  }

  const masterPath = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(masterPath)) return;
  try {
    let idx = fs.readFileSync(masterPath, 'utf-8');
    if (idx.includes('sitemap-search-clusters.xml')) {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-search-clusters\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    } else {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-search-clusters.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    }
    fs.writeFileSync(masterPath, idx, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[related-search-clusters]\x1b[0m failed to patch master sitemap:', err);
  }
}

// ── Plugin entry ────────────────────────────────────────────────────────

export function relatedSearchClustersPlugin(rootDir: string): Plugin {
  return {
    name: 'related-search-clusters',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_RELATED_SEARCH_CLUSTERS === '1') {
        console.log('\x1b[36m[related-search-clusters]\x1b[0m skipped via SKIP_RELATED_SEARCH_CLUSTERS');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const startedAt = Date.now();

      const candidates = filterAndDedupeCandidates(loadCandidates(rootDir));
      if (candidates.length === 0) {
        console.log('\x1b[36m[related-search-clusters]\x1b[0m 0 candidates after filtering — nothing to emit');
        return;
      }
      const enriched = loadEnriched(rootDir);
      const jobs = loadJobs(rootDir);
      console.log(`\x1b[36m[related-search-clusters]\x1b[0m ${candidates.length} candidates, ${Object.keys(enriched).length} enriched entries, ${jobs.length} jobs`);

      // Cache `${locale}::${jobIdentity}` → normalized haystack across clusters.
      const haystackCache = new Map<string, string>();

      const contexts: ClusterContext[] = [];
      for (const cand of candidates) {
        const ctx = buildClusterContext(cand, haystackCache, jobs);
        if (ctx) contexts.push(ctx);
      }
      console.log(`\x1b[36m[related-search-clusters]\x1b[0m ${contexts.length} clusters survived match-≥${MIN_MATCHING_JOBS} filter`);

      if (contexts.length === 0) return;

      // Group by (normalized keyword + city) for cross-locale hreflang lookup.
      const byKeywordCity = new Map<string, Map<Locale, ClusterContext>>();
      for (const ctx of contexts) {
        const key = `${normalizeText(ctx.keyword)}|${normalizeText(ctx.city || '')}`;
        let inner = byKeywordCity.get(key);
        if (!inner) {
          inner = new Map();
          byKeywordCity.set(key, inner);
        }
        inner.set(ctx.candidate.locale, ctx);
      }

      // Group by locale + city for related-link suggestions.
      const byLocale = new Map<Locale, ClusterContext[]>();
      const byLocaleCity = new Map<Locale, Map<string, ClusterContext[]>>();
      for (const ctx of contexts) {
        const arr = byLocale.get(ctx.candidate.locale) || [];
        arr.push(ctx);
        byLocale.set(ctx.candidate.locale, arr);
        if (ctx.city) {
          let inner = byLocaleCity.get(ctx.candidate.locale);
          if (!inner) {
            inner = new Map();
            byLocaleCity.set(ctx.candidate.locale, inner);
          }
          const cityArr = inner.get(ctx.city) || [];
          cityArr.push(ctx);
          inner.set(ctx.city, cityArr);
        }
      }

      const collector = new WriteCollector({ distDir, pluginName: 'relatedSearchClustersPlugin' });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapLocs: string[] = [];

      // ── Per-cluster pages ─────────────────────────────────────────────
      for (const ctx of contexts) {
        const locale = ctx.candidate.locale;
        const altKey = `${normalizeText(ctx.keyword)}|${normalizeText(ctx.city || '')}`;
        const altMap = byKeywordCity.get(altKey);
        const hreflang = altMap
          ? Array.from(altMap.entries()).map(([loc, otherCtx]) => ({
              locale: loc,
              url: `${BASE_URL}${buildClusterPath(loc, otherCtx.candidate.slug)}`,
            }))
          : [];

        const cityIdx = byLocaleCity.get(locale);
        const sameCityList = (ctx.city && cityIdx?.get(ctx.city)) || [];
        const related = sameCityList
          .filter((other) => other.candidate.slug !== ctx.candidate.slug)
          .slice(0, 8)
          .map((other) => ({
            keyword: other.city ? `${capitalize(other.keyword)} — ${other.city}` : capitalize(other.keyword),
            url: `${BASE_URL}${buildClusterPath(locale, other.candidate.slug)}`,
          }));

        const enrichedKey = `${locale}::${ctx.candidate.slug}`;
        const out = renderClusterPage({
          ctx,
          enriched: enriched[enrichedKey],
          hreflang,
          related,
          distDir,
          dateStamp,
        });

        const indexPath = path.join(distDir, out.urlPath, 'index.html');
        const flatPath = path.join(distDir, out.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, out.html);
        collector.add(flatPath, out.html);
        sitemapLocs.push(out.loc);
      }

      // ── Per-locale hub pages ──────────────────────────────────────────
      for (const [locale, list] of byLocale.entries()) {
        const items: HubItem[] = list.map((ctx) => ({
          keyword: ctx.keyword,
          city: ctx.city,
          slug: ctx.candidate.slug,
          url: `${BASE_URL}${buildClusterPath(locale, ctx.candidate.slug)}`,
        }));
        const totalPages = Math.max(1, Math.ceil(items.length / HUB_PAGE_SIZE));

        for (let page = 1; page <= totalPages; page++) {
          const slice = items.slice((page - 1) * HUB_PAGE_SIZE, page * HUB_PAGE_SIZE);
          const out = renderHubPage({
            locale,
            items: slice,
            page,
            totalPages,
            distDir,
            dateStamp,
          });
          const indexPath = path.join(distDir, out.urlPath, 'index.html');
          const flatPath = path.join(distDir, out.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, out.html);
          collector.add(flatPath, out.html);
          sitemapLocs.push(out.loc);
        }

        const hubUrl = `${BASE_URL}${buildHubPath(locale, 1)}`;
        injectHubLinkIntoSectionLanding(distDir, locale, hubUrl, COPY[locale]);
      }

      const written = await collector.flush();
      writeSitemap(distDir, sitemapLocs, dateStamp);

      console.log(
        `\x1b[36m[related-search-clusters]\x1b[0m emitted ${contexts.length} cluster pages + ${byLocale.size} hubs (${written} files) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
    },
  };
}
