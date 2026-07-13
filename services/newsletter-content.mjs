/**
 * Newsletter content — v2 (AI-powered personalization)
 *
 * Smart job matching based on subscriber location/sector interests.
 * AI prompt builders for personalized briefing and subject lines.
 * No more 3-variant system — every subscriber gets unique content.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getVariantStyleDirective } from './newsletter-subject-variants.mjs';
import { locTokenHit } from './locToken.mjs';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import { JOB_BOARD_SECTION_RX } from '../scripts/lib/jobBoardSections.mjs';
import { nlNormLocale } from './newsletter-template.mjs';

const BASE_URL = 'https://frontaliereticino.ch';

/** Mirror the build plugin's canonicalCompanySlug logic (slugify company name, not companyKey) */
export function slugifyCompanyName(name) {
  return String(name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').trim();
}

let __dirname = '';
try {
  __dirname = path.dirname(new URL(import.meta.url).pathname);
} catch {
  // Browser environment — Node path module not available
}

// ─── Company logo resolution ─────────────────────────────────

// The self-hosted brand/logo images are offloaded out of the origin artifact to
// the dedicated CDN at deploy (#1705, scripts/offload-generated-images-cdn.mjs):
// the manifest stores same-origin `/images/{brands,logos}/…` paths, but those
// paths 404 at the origin once offloaded, so an email <img> pointing there shows
// a broken icon. Rewrite offloaded paths to the stable CDN host — same fix already
// shipped for the job-alert emails (scripts/send-job-alerts.mjs IMAGE_CDN_BASE).
// MUST stay in sync with CDN_OFFLOADED_IMAGE_PREFIXES in services/cdnImageBase.ts.
const IMAGE_CDN_BASE = 'https://cdn.frontaliereticino.ch';
const CDN_OFFLOADED_IMAGE_PREFIXES = [
  '/images/brands/',
  '/images/insurers/',
  '/images/providers/',
  '/images/logos/',
  '/images/authors/',
  '/images/publisher/',
  '/images/events/', // nationwide events feature (issue #3125)
];

/** Absolute URL for a same-origin image path: CDN host if offloaded, else origin. */
function imageUrl(p) {
  for (const prefix of CDN_OFFLOADED_IMAGE_PREFIXES) {
    if (p.startsWith(prefix)) return `${IMAGE_CDN_BASE}${p}`;
  }
  return `${BASE_URL}${p}`;
}

let _logoManifest = null;
function loadLogoManifest() {
  if (_logoManifest) return _logoManifest;
  try {
    const p = path.resolve(__dirname, '..', 'data', 'company-logos-manifest.json');
    _logoManifest = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    _logoManifest = {};
  }
  return _logoManifest;
}

/**
 * Resolve the best logo URL for a job in newsletter context (absolute URLs only).
 * Only a self-hosted logo from the manifest is returned; otherwise null so the
 * email template renders its coloured initial-letter avatar. We deliberately do
 * NOT fall back to Clearbit (CDN defunct → broken image) or a Google favicon
 * (grey globe) — both look broken in an inbox.
 */
function resolveLogoUrl(job) {
  const manifest = loadLogoManifest();
  const key = job.companyKey || '';

  // Self-hosted logo from manifest → absolute URL (CDN host if offloaded).
  // Anything else → null (template falls back to the coloured initial-letter avatar).
  if (key && manifest[key]) {
    return imageUrl(manifest[key]);
  }

  return null;
}

// ─── Job matching ───────────────────────────────────────────

// Parse a single date field to a timestamp, or NaN if unusable.
// `new Date(raw)` reads a slash date as US MM/DD/YY, so a European DD/MM/YY
// posted date is either Invalid (day>12, e.g. "30/05/26") OR — the silent bug
// (#2630) — reinterpreted as a valid-but-WRONG date when day≤12 (e.g.
// "05/06/26" → 5 Jun is read as 6 May). Both are wrong: these fields are
// European DD/MM. Detect the bare `d/m/y` slash form and parse it as DD/MM
// explicitly; everything else (ISO, RFC, timestamps) goes through `new Date`.
export function parseDateField(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(raw).trim());
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000; // "26" → 2026
    // Reject impossible DD/MM (e.g. month>12) → caller falls through to the
    // next field rather than trusting a misparse.
    if (day < 1 || day > 31 || month < 1 || month > 12) return NaN;
    const ts = Date.UTC(year, month - 1, day);
    // The range guard above is necessary but NOT sufficient: in-range-but-
    // impossible calendar dates (31/04, 31/02) pass it, and Date.UTC silently
    // ROLLS them over to the next month (31/02 → 3 Mar) instead of failing —
    // a valid-but-WRONG timestamp that bypasses the firstSeenAt fallthrough,
    // the exact failure class #2630 set out to eliminate (#2727 item 3).
    // Round-trip check: reject if UTC normalized the day/month away.
    const back = new Date(ts);
    if (back.getUTCDate() !== day || back.getUTCMonth() !== month - 1) return NaN;
    return ts;
  }
  return new Date(raw).getTime();
}

function toDateValue(job) {
  // Pick the first field that PARSES, not the first truthy one: a slice of jobs
  // carry a malformed/ambiguous postedDate (European DD/MM/YY) that would
  // otherwise shadow a perfectly good firstSeenAt and force the job into
  // decayFactor's neutral UNDATED branch (date present ≠ date usable).
  // Order matters: firstSeenAt (set once at discovery, never refreshed) must
  // come BEFORE crawledAt — crawledAt refreshes on every re-crawl, so with it
  // first every re-crawled job "aged" ~0 days forever, which both defeated the
  // anti-evergreen popularity decay below and made the no-profile "fresh
  // slots" rotation in matchJobsForSubscriber treat stale inventory as new.
  for (const raw of [job?.postedDate, job?.firstSeenAt, job?.publishedAt, job?.crawledAt]) {
    if (!raw) continue;
    const ts = parseDateField(raw);
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

// ─── Popularity decay (anti-evergreen-freeze) ───────────────
// Raw job_views are cumulative all-time (scripts/fetch-job-popularity.mjs),
// so a handful of big-employer evergreens stay frozen at the top of every
// newsletter. We decay the view count by job age at read time so stale
// popular jobs stop crowding out fresher listings. Half-life 30d: a 30-day
// old job counts half, 60d a quarter, 90d an eighth.
const POPULARITY_HALFLIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Jobs with no parseable date can't be aged, so we apply a neutral mid-life
// dampening (~1 half-life) instead of trusting their raw all-time count.
const UNDATED_DECAY_FACTOR = 0.5;
// No-profile subscribers get 2 popular (decayed) + 2 fresh slots so the
// section visibly rotates week-over-week instead of collapsing onto the
// all-time most-viewed jobs.
const NO_PROFILE_POPULAR_SLOTS = 2;

export function decayFactor(job, now) {
  const ts = toDateValue(job);
  if (!ts) return UNDATED_DECAY_FACTOR;
  const ageDays = Math.max(0, (now - ts) / DAY_MS);
  return Math.pow(0.5, ageDays / POPULARITY_HALFLIFE_DAYS);
}

/** Age-decayed popularity: cumulative views damped by job freshness. */
function decayedPopularity(job, popularity, now) {
  const views = getJobPopularityCount(job, popularity);
  if (views <= 0) return 0;
  return views * decayFactor(job, now);
}

function normalizeLocation(location) {
  const raw = String(location || '').trim();
  if (!raw) return 'Ticino';
  const zipMatch = raw.match(/\b\d{4}\b/);
  if (zipMatch) return raw.replace(zipMatch[0], '').replace(/\bWorking Area\b/gi, '').replace(/\s+/g, ' ').trim() || raw;
  return raw;
}

const CONTRACT_LABELS = {
  it: { part: 'Part-time', intern: 'Stage', appr: 'Apprendistato', temp: 'Tempo determinato', full: 'Tempo pieno', default: 'Annuncio attivo' },
  en: { part: 'Part-time', intern: 'Internship', appr: 'Apprenticeship', temp: 'Fixed-term', full: 'Full-time', default: 'Active listing' },
  de: { part: 'Teilzeit', intern: 'Praktikum', appr: 'Lehrstelle', temp: 'Befristet', full: 'Vollzeit', default: 'Aktive Stelle' },
  fr: { part: 'Temps partiel', intern: 'Stage', appr: 'Apprentissage', temp: 'Durée déterminée', full: 'Temps plein', default: 'Annonce active' },
};

export function normalizeContract(contract, locale = 'it') {
  const labels = CONTRACT_LABELS[locale] || CONTRACT_LABELS.it;
  const value = String(contract || '').toLowerCase();
  if (value.includes('part')) return labels.part;
  if (value.includes('intern')) return labels.intern;
  if (value.includes('appr')) return labels.appr;
  if (value.includes('temp')) return labels.temp;
  if (value.includes('full')) return labels.full;
  return labels.default;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Quality gate: returns true if a job has enough content for the newsletter.
 */
function passesQualityGate(job) {
  if (!job?.title || !job?.slug || !job?.company) return false;
  const desc = String(job.descriptionByLocale?.it || job.description || '');
  // No thin text — at least 120 chars of real content
  if (desc.length < 120) return false;
  // No broken HTML as first char
  if (desc.trim().startsWith('<')) return false;
  return true;
}

/**
 * Load job popularity data from data/job-popularity.json.
 * Returns a Map<slug, viewCount> or empty Map if unavailable.
 */
let _popularityCache = null;
function loadPopularity() {
  if (_popularityCache) return _popularityCache;
  try {
    const popPath = path.resolve(__dirname, '..', 'data', 'job-popularity.json');
    const data = JSON.parse(fs.readFileSync(popPath, 'utf-8'));
    _popularityCache = new Map(Object.entries(data).map(([k, v]) => [k, Number(v) || 0]));
    return _popularityCache;
  } catch {
    return new Map();
  }
}

/**
 * Sum job_views across every slug variant the job is known by:
 *   - canonical job.slug (usually = slugByLocale.it)
 *   - all locale variants in slugByLocale (en/de/fr versions diverge for ~98% of jobs)
 *   - all renames in previousSlugs and previousSlugsByLocale.{loc}
 *
 * Until trackJobView started writing under the canonical IT slug, the same job
 * could fragment into up to 4 separate Firestore docs (one per locale).
 * This helper reconciles the historical fragmentation at read time.
 */
export function getJobPopularityCount(job, popularity) {
  if (!popularity || popularity.size === 0 || !job) return 0;
  const seen = new Set();
  const add = (slug) => {
    if (slug && !seen.has(slug)) seen.add(slug);
  };
  add(job.slug);
  if (job.slugByLocale) {
    for (const loc of ['it', 'en', 'de', 'fr']) add(job.slugByLocale[loc]);
  }
  if (Array.isArray(job.previousSlugs)) {
    for (const s of job.previousSlugs) add(s);
  }
  if (job.previousSlugsByLocale) {
    for (const arr of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(arr)) for (const s of arr) add(s);
    }
  }
  let total = 0;
  for (const slug of seen) total += popularity.get(slug) || 0;
  return total;
}

/**
 * Load real-time dashboard metrics for the newsletter.
 * Reads from existing data files (cached per process):
 *   - public/data/switzerland-unemployment-rate.json → unemployment rate
 *   - data/health-premiums/{year}.json (F2-A3 multi-year) with a fallback to
 *     the legacy flat `data/health-premiums.json` → Lugano LAMal premium
 *     (standard, adult 26+, franchise 2500).
 *
 * Franchise 2500 adjustment: -33% from base (franchise 300) premium.
 */
let _metricsCache = null;
export function loadDashboardMetrics() {
  if (_metricsCache) return _metricsCache;

  // Labels are intentionally NOT included here — the template renders them
  // via nlT(locale, 'metricUnemployment') / nlT(locale, 'metricLamal') so
  // they are localized per-recipient. Adding label fields would override
  // localization and bake Italian into every email.
  const metrics = {
    unemploymentRate: '2.8%',
    lamalPremium: 'CHF 467',
  };

  // ── Unemployment rate ──
  try {
    const unempPath = path.resolve(__dirname, '..', 'public', 'data', 'switzerland-unemployment-rate.json');
    const unempData = JSON.parse(fs.readFileSync(unempPath, 'utf-8'));
    if (unempData.rate && typeof unempData.rate === 'number') {
      metrics.unemploymentRate = `${unempData.rate}%`;
    }
  } catch {
    console.warn('⚠️  loadDashboardMetrics: unemployment data unavailable, using fallback');
  }

  // ── LAMal premium (Lugano, standard model, franchise 2500) ──
  try {
    // Prefer the F2-A3 year-scoped dataset, fall back to the legacy flat
    // path when the directory is not present (older deploys / tests).
    const currentYear = new Date().getUTCFullYear();
    const candidates = [
      path.resolve(__dirname, '..', 'data', 'health-premiums', `${currentYear}.json`),
      path.resolve(__dirname, '..', 'data', 'health-premiums.json'),
    ];
    let lamalData = null;
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          lamalData = JSON.parse(fs.readFileSync(p, 'utf-8'));
          break;
        }
      } catch {
        // try next candidate
      }
    }
    if (!lamalData) throw new Error('no health-premiums dataset found');
    const lugano = lamalData.premiums['6823-Lugano'];
    if (lugano?.insurers) {
      let sum = 0;
      let count = 0;
      for (const models of Object.values(lugano.insurers)) {
        if (models.standard && typeof models.standard === 'number') {
          sum += models.standard;
          count++;
        }
      }
      if (count > 0) {
        // Base is franchise 300; apply -33% for franchise 2500
        const base = sum / count;
        const adjusted = Math.round(base * (1 - 0.33));
        metrics.lamalPremium = `CHF ${adjusted}`;
      }
    }
  } catch {
    console.warn('⚠️  loadDashboardMetrics: health premiums data unavailable, using fallback');
  }

  _metricsCache = metrics;
  return metrics;
}

// ─── Keyword extraction from job slugs / source strings ─────

const SLUG_STOP_WORDS = new Set([
  // IT connectives
  'il', 'lo', 'la', 'le', 'i', 'gli', 'un', 'uno', 'una', 'di', 'del', 'della',
  'dei', 'delle', 'dello', 'degli', 'da', 'dal', 'dalla', 'a', 'al', 'alla',
  'in', 'nel', 'nella', 'con', 'su', 'sul', 'sulla', 'per', 'tra', 'fra', 'e', 'o',
  // EN connectives
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'in', 'at', 'to', 'on', 'with', 'from',
  // DE connectives
  'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'fur', 'von', 'mit', 'im', 'am',
  // FR connectives
  'le', 'la', 'les', 'un', 'une', 'de', 'du', 'des', 'et', 'ou', 'pour', 'dans', 'en',
  // Generic filler
  'sa', 'ag', 'gmbh', 'srl', 'spa', 'ltd', 'inc', 'se', 'che', 'non', 'trice',
  'm', 'f', 'd', 'mfd', 'w', 'h', 'hf',
]);

/**
 * Extract meaningful keywords from a slug or free-text source string.
 * Filters stop words and short tokens. Returns lowercase Set.
 *
 * Exported so the job-alert matcher (services/jobAlertMatching.mjs) reuses the
 * SAME tokenizer + stop-word list instead of copy-pasting it — single source of
 * truth keeps the two funnels' keyword extraction from drifting apart.
 */
export function extractKeywords(text) {
  if (!text) return new Set();
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-zà-ü0-9\s-]/g, '')
    .split(/[-\s]+/)
    .filter((t) => t.length >= 3 && !SLUG_STOP_WORDS.has(t));
  return new Set(tokens);
}

/**
 * Parse the legacy `source` field (e.g. "job_gate:CompanyName:Job Title Here")
 * into { company, title } for keyword extraction.
 */
function parseSourceField(source) {
  if (!source || typeof source !== 'string') return null;
  const parts = source.split(':');
  if (parts.length < 3) return null;
  return { company: parts[1]?.trim() || null, title: parts.slice(2).join(':').trim() || null };
}

/**
 * Score a job against a set of subscriber interest keywords.
 * Returns 0–10 relevance score.
 */
function keywordRelevanceScore(job, subscriberKeywords, subscriberCompany, subscriberLocation = '') {
  if (subscriberKeywords.size === 0 && !subscriberCompany && !subscriberLocation) return 0;
  let score = 0;
  const jobTitle = String(job.titleByLocale?.it || job.title || '').toLowerCase();
  const jobCategory = String(job.category || job.sector || '').toLowerCase();
  const jobCompanyKey = (job.companyKey || job.company || '').toLowerCase();

  // Company match: strong signal (same employer → highly relevant)
  if (subscriberCompany) {
    const subComp = subscriberCompany.toLowerCase();
    if (jobCompanyKey.includes(subComp) || subComp.includes(jobCompanyKey)) {
      score += 4;
    }
  }

  // Keyword overlap with job title
  if (subscriberKeywords.size > 0) {
    const jobTokens = extractKeywords(`${jobTitle} ${jobCategory}`);
    let overlap = 0;
    for (const kw of subscriberKeywords) {
      if (jobTokens.has(kw)) overlap++;
    }
    // Normalize: up to 6 points based on overlap ratio
    if (subscriberKeywords.size > 0 && overlap > 0) {
      score += Math.min(6, Math.round((overlap / subscriberKeywords.size) * 6));
    }
  }

  // Location match: the job's town/canton matches the subscriber's saved job
  // location/interest. Location is also used as a pre-filter, but ranking it
  // here lets same-town jobs win over far ones when the pre-filter is skipped
  // (too few in-location results to fill the limit).
  if (subscriberLocation) {
    const subLoc = subscriberLocation.toLowerCase();
    const jobLoc = `${String(job.location || '')} ${String(job.addressLocality || '')} ${String(job.addressRegion || '')} ${String(job.canton || '')}`.toLowerCase();
    if (locTokenHit(jobLoc, subLoc)) score += 2;
  }

  return score;
}

/**
 * Match jobs for a subscriber — relevance-first with popularity fallback.
 *
 * Algorithm:
 * 1. Quality filter (title, slug, company, description >= 120 chars)
 * 2. Extract interest keywords from subscriber's saved job context, source field, and company
 * 3. Score each job: keyword relevance (0–10) + popularity bonus
 * 4. Location filter (if locationInterest set)
 * 5. Company diversity: max 1 job per company
 * 6. Top `limit` jobs
 *
 * @param {object} subscriber — { locationInterest, sectorInterest, job_slug, job_company, job_category, source, preferences, sourceJob }
 * @param {object[]} jobs — Full jobs array from data/jobs.json
 * @param {number} limit — Max jobs to return (default 3)
 * @returns {object[]} — Matched jobs with title, url, company, location, contract
 */
/** Locale-specific job board URL path prefix */
const JOB_BOARD_PATH = {
  it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section (it)
  en: 'en/find-jobs-ticino',
  de: 'de/jobs-im-tessin',
  fr: 'fr/trouver-emploi-tessin',
};

// Company-hub URL prefix per locale — MUST mirror build-plugins/
// jobsSeoPagesPlugin.ts `companyRoutePrefix`. The build emits each hub at
// `{board}/{prefix}-{companySlug}/`, so a newsletter that hardcodes the IT
// `azienda-` for a DE/EN/FR board path links to a page that was never built
// (e.g. /de/jobs-im-tessin/azienda-eoc-… 404s; the real page is
// /de/jobs-im-tessin/unternehmen-eoc-…).
const COMPANY_ROUTE_PREFIX = {
  it: 'azienda',
  en: 'company',
  de: 'unternehmen',
  fr: 'entreprise',
};

/** True if a job-board slug is a company-hub slug in ANY locale. */
export function isCompanyHubSlug(slug) {
  if (!slug) return false;
  return Object.values(COMPANY_ROUTE_PREFIX).some((p) => slug.startsWith(`${p}-`));
}

/** Build the locale-aware company page URL. Mirrors the build plugin's
 *  per-locale `companyRoutePrefix` + section path (trailing slash = canonical). */
export function companyPageUrl(companySlug, locale = 'it') {
  if (!companySlug) return '';
  const boardPath = JOB_BOARD_PATH[locale] || JOB_BOARD_PATH.it;
  const prefix = COMPANY_ROUTE_PREFIX[locale] || COMPANY_ROUTE_PREFIX.it;
  return `${BASE_URL}/${boardPath}/${prefix}-${companySlug}/`;
}

// Company-hub URL this module builds (`companyPageUrl` → JOB_BOARD_PATH) is
// always the Ticino board path. That URL is only ever emitted by the build
// for companies with >=1 real TI job — see the "TI-only scope" comment on
// the legacy `companyMap` loop in build-plugins/jobsSeoPagesPlugin.ts
// (~line 3700), gated on the same `resolveJobCanton` resolver. A company
// whose only active jobs are outside TI gets a *different* per-canton hub
// URL instead (jobsSeoPagesPlugin.ts ~line 7600), never one at this Ticino
// board path. Lazy-load + cache mirrors `loadLogoManifest` above.
let _cantonResolvers = null;
function loadCantonResolvers() {
  if (_cantonResolvers !== null) return _cantonResolvers;
  try {
    const cantonSlugFile = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'data', 'canton-url-slugs.json'), 'utf-8')
    );
    const municipalitiesFile = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'data', 'canton-municipalities.json'), 'utf-8')
    );
    _cantonResolvers = createCantonResolvers({ cantonSlugFile, municipalitiesFile });
  } catch {
    _cantonResolvers = false;
  }
  return _cantonResolvers;
}

/**
 * Set of company-hub slugs the build actually emits — one per company that has
 * ≥1 ACTIVE **TI** job (`data/jobs.json`). The build emits a company hub at
 * this (Ticino board) URL for every active TI company (and brand-alias slugs
 * additionally get 200 bridge pages), so a company whose name exists ONLY on
 * EXPIRED jobs, or ONLY on non-TI jobs, has NO emitted hub at this URL:
 * linking it silently 404s (#2530 expired-only case, e.g.
 * `jumbo-divisione-di-coop-societa-cooperativa`, a name present only in
 * `data/expired-jobs.json`; #3557 non-TI-only case, recovered as a redirect
 * by the CF worker's company-hub safety net rather than a raw 404, but the
 * origin page itself never exists). Built from the same active jobs array,
 * the same `slugifyCompanyName` the link builder uses, and the same
 * `resolveJobCanton` TI gate the emitter uses, so the allow-set matches the
 * emitted set by construction.
 *
 * @param {object[]} jobs active jobs array (data/jobs.json)
 * @returns {Set<string>} emitted company-hub slugs
 */
export function buildCompanyHubSlugSet(jobs) {
  const set = new Set();
  const resolvers = loadCantonResolvers();
  for (const j of jobs || []) {
    // Mirror the emitter's `validJobs` gate (jobsSeoPagesPlugin.ts ~1255): a hub
    // is emitted only for a company on a job that ALSO has title, location and a
    // description. A company appearing only on description-/title-/location-less
    // jobs gets no emitted primary hub, so it must not be allow-listed either —
    // otherwise the gate still links a 404 (#2608 item 2). The company-slug
    // algorithm here (slugifyCompanyName) is byte-identical to the emitter's
    // slugifyCompanyBuild, and brand-alias raw slugs are covered by 200 bridges
    // from companyHubBridgePlugin's crawler-known coverage (#2608 item 3), so the
    // raw slug is the correct allow-set key.
    if (j && j.title && j.company && j.location && (j.description || j.descriptionByLocale)) {
      // TI-only gate (issue #3557): skip jobs whose resolved canton isn't TI,
      // mirroring the emitter's companyMap loop exactly.
      if (resolvers && resolvers.resolveJobCanton(j) !== 'TI') continue;
      const slug = slugifyCompanyName(j.company);
      if (slug) set.add(slug);
    }
  }
  return set;
}

/**
 * Company-hub URL only when the build emitted that hub (company present in the
 * active set); '' otherwise — defense-in-depth mirroring `validateJobUrls` so
 * the newsletter never links a 404 company hub (#2530). When `emittedSlugs` is
 * empty/missing the gate is skipped (returns the URL) to avoid silently
 * dropping every company link on a bad/empty dataset, matching `validateJobUrls`.
 *
 * @param {string} company raw company name
 * @param {string} locale
 * @param {Set<string>} [emittedSlugs] from {@link buildCompanyHubSlugSet}
 * @returns {string} hub URL or ''
 */
export function companyHubUrlIfEmitted(company, locale = 'it', emittedSlugs) {
  if (!company) return '';
  const slug = slugifyCompanyName(company);
  if (!slug) return '';
  if (emittedSlugs && emittedSlugs.size > 0 && !emittedSlugs.has(slug)) return '';
  return companyPageUrl(slug, locale);
}

export function matchJobsForSubscriber(subscriber, jobs, limit = 3, locale = 'it', recentlyFeaturedSlugs = []) {
  if (!jobs || jobs.length === 0) return [];

  const popularity = loadPopularity();
  const hasPopularity = popularity.size > 0;

  // Quality filter for popularity ranking; fallback pool keeps all valid jobs
  const qualityPool = jobs.filter(passesQualityGate);
  const basicPool = jobs.filter((j) => j?.title && j?.slug && j?.company);
  const fullPool = hasPopularity && qualityPool.length >= limit ? qualityPool : basicPool;
  const sourceJob = subscriber?.sourceJob || subscriber?._sourceJob || null;
  const jobSlug = subscriber?.job_slug || sourceJob?.slug || '';
  const sourceSlugSet = new Set([
    jobSlug,
    sourceJob?.slug,
    ...Object.values(sourceJob?.slugByLocale || {}),
  ].filter(Boolean));

  // ── Exclude recently featured jobs (rotation, same logic as article rotation) ──
  const recentSet = new Set(recentlyFeaturedSlugs);
  const jobIsSource = (j) =>
    sourceSlugSet.size > 0 && (
      (j.slug && sourceSlugSet.has(j.slug)) ||
      Object.values(j.slugByLocale || {}).some((s) => s && sourceSlugSet.has(s))
    );
  const jobIsRecent = (j) =>
    recentSet.size > 0 && (
      (j.slug && recentSet.has(j.slug)) ||
      Object.values(j.slugByLocale || {}).some((s) => s && recentSet.has(s))
    );
  // Prefer fresh jobs always; only mix in recent-featured ones at the END to
  // backfill missing slots. This guarantees a popular evergreen job in the
  // exclude list cannot displace fresh candidates just because the fresh pool
  // is below {limit}.
  const freshPool = fullPool.filter((j) => !jobIsRecent(j) && !jobIsSource(j));
  const recentPool = fullPool.filter((j) => jobIsRecent(j) || jobIsSource(j));
  const pool = freshPool.length >= limit ? freshPool : [...freshPool, ...recentPool];

  // ── Build subscriber interest profile from available signals ──
  const jobCompany = subscriber?.job_company || sourceJob?.company || '';
  const jobCategory = subscriber?.job_category || sourceJob?.category || sourceJob?.sector || '';
  const jobSearchQuery = subscriber?.job_search_query || '';
  const sourceField = subscriber?.source || '';

  // Collect keywords from multiple sources
  const slugKeywords = extractKeywords(jobSlug);
  const categoryKeywords = extractKeywords(jobCategory);
  const searchKeywords = extractKeywords(jobSearchQuery);
  // Slug recovered retroactively by scripts/backfill-newsletter-job-context.mjs
  // for subscribers who signed up before job context was captured (or from a
  // job page whose source slug since expired). It carries the same job
  // signal as job_slug, so feed it into the keyword profile too.
  const backfillSlugKeywords = extractKeywords(subscriber?.job_context_backfill_slug || '');
  const sourceJobTitleKeywords = sourceJob?.title ? extractKeywords(sourceJob.title) : new Set();
  const sourceJobCategoryKeywords = sourceJob?.category || sourceJob?.sector
    ? extractKeywords(`${sourceJob.category || ''} ${sourceJob.sector || ''}`)
    : new Set();
  const parsedSource = parseSourceField(sourceField);
  const sourceTitleKeywords = parsedSource?.title ? extractKeywords(parsedSource.title) : new Set();

  // Merge all keyword sources (slug is primary, source title is secondary)
  const subscriberKeywords = new Set([
    ...slugKeywords,
    ...categoryKeywords,
    ...searchKeywords,
    ...backfillSlugKeywords,
    ...sourceJobTitleKeywords,
    ...sourceJobCategoryKeywords,
    ...sourceTitleKeywords,
  ]);

  // Company from explicit field or parsed source
  const subscriberCompany = jobCompany || parsedSource?.company || '';

  const hasInterestProfile = subscriberKeywords.size > 0 || subscriberCompany;

  // ── Score and sort jobs ──
  const savedJobLocation = subscriber?.job_location || sourceJob?.location || sourceJob?.addressLocality || '';
  const location = String(subscriber?.locationInterest || savedJobLocation || '').toLowerCase().trim();
  const sector = String(subscriber?.sectorInterest || jobCategory || '').toLowerCase().trim();
  const usableSector = sector && sector !== 'other';

  // Pre-filter by location if specified (applied before scoring for performance)
  let candidates = pool;
  if (location) {
    const locationFiltered = pool.filter((j) => {
      const jobLoc = `${String(j.location || '')} ${String(j.addressLocality || '')} ${String(j.addressRegion || '')} ${String(j.canton || '')}`.toLowerCase();
      return locTokenHit(jobLoc, location);
    });
    if (locationFiltered.length >= limit) candidates = locationFiltered;
  }

  // Further filter by sector only if it's not the generic "other"
  // Only apply if enough results remain to fill the requested limit
  if (usableSector) {
    const sectorFiltered = candidates.filter((j) =>
      String(j.title || '').toLowerCase().includes(sector) ||
      String(j.category || '').toLowerCase().includes(sector) ||
      String(j.sector || '').toLowerCase().includes(sector)
    );
    if (sectorFiltered.length >= limit) candidates = sectorFiltered;
  }

  // Score each candidate: keyword/company/location relevance, age-decayed
  // popularity (anti-evergreen-freeze), and recency.
  const now = Date.now();
  const scored = candidates.map((job) => ({
    job,
    relevance: hasInterestProfile
      ? keywordRelevanceScore(job, subscriberKeywords, subscriberCompany, location)
      : 0,
    decayedViews: hasPopularity ? decayedPopularity(job, popularity, now) : 0,
    date: toDateValue(job),
  }));

  const companyKey = (j) => (j.companyKey || j.company || '').toLowerCase();

  let ordered;
  if (hasInterestProfile) {
    // Relevance-first: keyword/company/location match, then age-decayed
    // popularity, then recency.
    ordered = [...scored]
      .sort((a, b) =>
        (b.relevance - a.relevance) ||
        (b.decayedViews - a.decayedViews) ||
        (b.date - a.date))
      .map((s) => s.job);
  } else {
    // No interest profile (the common case): reserve the first
    // NO_PROFILE_POPULAR_SLOTS slots for age-decayed popularity leaders, then
    // fill the rest with the freshest listings — company-diverse, no repeats.
    // This stops the section collapsing onto the all-time most-viewed jobs and
    // guarantees visible week-over-week rotation.
    const byPopular = [...scored].sort((a, b) => (b.decayedViews - a.decayedViews) || (b.date - a.date));
    const byFresh = [...scored].sort((a, b) => (b.date - a.date) || (b.decayedViews - a.decayedViews));
    const picked = [];
    const usedCompanies = new Set();
    const usedSlugs = new Set();
    const take = (list, max) => {
      for (const s of list) {
        if (picked.length >= max) break;
        const ck = companyKey(s.job);
        if (s.job.slug && usedSlugs.has(s.job.slug)) continue;
        if (ck && usedCompanies.has(ck)) continue;
        picked.push(s.job);
        if (s.job.slug) usedSlugs.add(s.job.slug);
        if (ck) usedCompanies.add(ck);
      }
    };
    take(byPopular, Math.min(NO_PROFILE_POPULAR_SLOTS, limit)); // popular leaders
    take(byFresh, limit);                                       // fill with fresh
    take(byPopular, limit);                                     // backfill leftovers
    ordered = picked;
  }

  // Company diversity: max 1 job per company (defensive — the no-profile blend
  // already dedupes by company, but the relevance-first path does not).
  const companyDiverse = dedupeBy(ordered, companyKey);

  // Backfill: if location/sector filtering left too few diverse companies,
  // fill remaining slots from the full pool (excluding already-selected companies)
  let finalJobs = companyDiverse;
  if (companyDiverse.length < limit && candidates !== pool) {
    const usedCompanies = new Set(companyDiverse.map(companyKey));
    const backfillScored = pool
      .filter((j) => !usedCompanies.has(companyKey(j)))
      .map((job) => ({ job, decayedViews: hasPopularity ? decayedPopularity(job, popularity, now) : 0, date: toDateValue(job) }))
      .sort((a, b) => b.decayedViews - a.decayedViews || b.date - a.date);
    const backfill = dedupeBy(backfillScored.map((s) => s.job), companyKey);
    finalJobs = [...companyDiverse, ...backfill];
  }

  // Company hubs are emitted only for companies present in the ACTIVE dataset.
  // A matched job sourced from an expired posting can carry a company-name
  // variant absent from active data → its hub is never emitted → 404 (#2530).
  // Gate companyUrl on the emitted-hub allow-set built from `jobs`.
  const emittedCompanyHubs = buildCompanyHubSlugSet(jobs);
  // Per-job board path — every canton has its own job-board section (see
  // loadCantonResolvers above); falls back to the flat JOB_BOARD_PATH (TI
  // legacy) only if the resolver data failed to load.
  const resolvers = loadCantonResolvers();
  const fallbackBoardPath = JOB_BOARD_PATH[locale] || JOB_BOARD_PATH.it;

  return finalJobs
    .slice(0, limit)
    .map((job) => {
      const slug = job.slugByLocale?.[locale] || job.slugByLocale?.it || job.slug;
      const boardPath = resolvers
        ? resolvers.resolveCantonSection(locale, resolvers.resolveJobCanton(job))
        : fallbackBoardPath;
      return {
        title: job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title,
        url: `/${boardPath}/${slug}/`,
        slug: job.slug || slug,
        company: job.company,
        companyKey: job.companyKey || '',
        location: normalizeLocation(job.location),
        contract: normalizeContract(job.contract, locale),
        sector: job.sector || job.category || '',
        rawContract: job.contract || '',
        logoUrl: resolveLogoUrl(job),
        companyUrl: companyHubUrlIfEmitted(job.company, locale, emittedCompanyHubs),
      };
    });
}

/**
 * Build a Set of known slugs from a jobs array.
 */
function buildSlugSet(jobs) {
  const slugs = new Set();
  for (const j of jobs) {
    if (j.slug) slugs.add(j.slug);
    if (j.slugByLocale) {
      for (const s of Object.values(j.slugByLocale)) {
        if (s) slugs.add(s);
      }
    }
  }
  return slugs;
}

/**
 * Validate matched job URLs against the set of known valid IT slugs.
 * Removes jobs whose slug doesn't exist in jobs.json (stale/deleted jobs).
 *
 * Resilience: if `allJobs` produces an empty slug set, falls back to reading
 * slugs directly from data/jobs.json. If still empty, skips validation entirely
 * so that matched jobs are never silently dropped.
 *
 * @param {object[]} matchedJobs — Output of matchJobsForSubscriber
 * @param {object[]} allJobs — Full jobs array from data/jobs.json
 * @returns {object[]} — Only jobs with valid, resolvable URLs
 */
export function validateJobUrls(matchedJobs, allJobs) {
  if (!matchedJobs || matchedJobs.length === 0) return [];

  let validSlugs = buildSlugSet(allJobs || []);

  // Resilience: if slug set is empty, skip validation — never silently drop all jobs
  if (validSlugs.size === 0) {
    console.warn('⚠️  validateJobUrls: no valid slugs available — skipping validation, returning all matched jobs');
    return matchedJobs;
  }

  const valid = [];
  const invalid = [];
  for (const job of matchedJobs) {
    // Strip locale prefix, then the canton-aware board section (shared
    // JOB_BOARD_SECTION_RX — any canton, not just the TI legacy slugs; see
    // the matchJobsForSubscriber fix above for why TI-only broke non-TI jobs).
    const slug = job.url
      .replace(/^\/(en|de|fr)\//, '/')
      .replace(JOB_BOARD_SECTION_RX, '')
      .replace(/^\//, '')
      .replace(/\/$/, '');
    if (validSlugs.has(slug)) {
      valid.push(job);
    } else {
      invalid.push(job);
    }
  }

  if (invalid.length > 0) {
    console.warn(`⚠️  Newsletter URL validation: ${invalid.length} job(s) with unresolvable slugs removed:`);
    invalid.forEach((j) => console.warn(`   - ${j.title}: ${j.url}`));
  }

  return valid;
}

// ─── AI prompt builders ─────────────────────────────────────

const LOCALE_NAMES = { it: 'Italian', en: 'English', de: 'German', fr: 'French' };

/**
 * Build a prompt for AI to generate a personalized newsletter briefing.
 *
 * @param {object} ctx
 * @param {object} ctx.subscriber — { locale, preferences, locationInterest, sectorInterest, sourceChannel }
 * @param {object} ctx.exchangeRate — { rate, previousRate }
 * @param {object} ctx.exchangeInsight — { headline, summary, bestWeekday }
 * @param {Array}  ctx.matchedJobs — [{ title, company, location }]
 * @param {object} ctx.weeklyFact — { text, source }
 * @param {object} ctx.featuredTool — { title, description }
 * @returns {{ system: string, user: string }}
 */
export function buildBriefingPrompt(ctx) {
  const locale = nlNormLocale(ctx.subscriber?.locale);
  const langName = LOCALE_NAMES[locale] || 'Italian';
  const prefs = ctx.subscriber?.preferences || {};
  const interests = [];
  if (prefs.jobs) interests.push('job opportunities');
  if (prefs.taxUpdates || prefs.tax) interests.push('tax/fiscal updates');
  if (prefs.exchangeRate) interests.push('exchange rate');
  if (prefs.tips) interests.push('practical tips');
  if (prefs.traffic) interests.push('border traffic');

  // Provide the actual date so the AI never needs to invent one
  const todayStr = new Date().toLocaleDateString(locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-GB' : 'it-CH', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Compute weekly change using the SAME previousRate as the hero card
  // to avoid inconsistency between card percentage and AI briefing text
  const cardPct = ctx.exchangeRate && ctx.exchangeRate.previousRate > 0
    ? ((ctx.exchangeRate.rate - ctx.exchangeRate.previousRate) / ctx.exchangeRate.previousRate * 100)
    : 0;
  const cardPctStr = `${cardPct >= 0 ? '+' : ''}${cardPct.toFixed(1)}%`;

  const rateTrend = ctx.exchangeRate
    ? `CHF/EUR rate as of ${todayStr}: ${ctx.exchangeRate.rate.toFixed(4)} (previous week: ${ctx.exchangeRate.previousRate.toFixed(4)}, weekly change: ${cardPctStr})`
    : 'Exchange rate data unavailable';

  // Use card-consistent percentage in the insight line too
  const insightLine = ctx.exchangeInsight
    ? `Market insight: CHF/EUR ${cardPct > 0.2 ? 'strengthening' : cardPct < -0.2 ? 'weakening' : 'stable'} (${cardPctStr} weekly). ${ctx.exchangeInsight.summary}`
    : '';

  const jobLines = (ctx.matchedJobs || []).slice(0, 3)
    .map((j) => {
      const url = j.url ? `${BASE_URL}${j.url.startsWith('/') ? j.url : '/' + j.url}` : '';
      if (!url) return null; // Skip jobs without URLs — AI must not mention unlinkable jobs
      // First PARSEABLE date via the module's hardened resolver (not first
      // truthy) so a malformed postedDate can't render "(posted: Invalid Date)".
      const postedMs = toDateValue(j);
      const postedInfo = postedMs ? ` (posted: ${new Date(postedMs).toLocaleDateString('it-CH')})` : '';
      // Reuse the upstream-validated hub URL from matchJobsForSubscriber (gated
      // on the emitted-hub allow-set, #2530) instead of re-deriving an UNGATED
      // slug here — re-deriving was the duplicate path that re-introduced the
      // 404 (a company present only on expired jobs has no emitted hub). Absent
      // companyUrl → omit the link (safe: the AI just won't reference a hub).
      const companyUrl = j.companyUrl || '';
      return `- ${j.title} at ${j.company} (${j.location})${postedInfo} → JOB_URL: ${url}${companyUrl ? ` | COMPANY_URL: ${companyUrl}` : ''}`;
    })
    .filter(Boolean)
    .join('\n');

  const factLine = ctx.weeklyFact
    ? `Weekly fact: "${ctx.weeklyFact.text}" (Source: ${ctx.weeklyFact.source || 'N/A'})`
    : '';

  const toolLine = ctx.featuredTool
    ? `Featured tool: ${ctx.featuredTool.title} — ${ctx.featuredTool.description}${ctx.featuredTool.toolUrl ? ` → URL: ${BASE_URL}${ctx.featuredTool.toolUrl}` : ''}`
    : '';

  const locationLine = ctx.subscriber?.locationInterest
    ? `Reader location interest: ${ctx.subscriber.locationInterest}`
    : '';

  const sectorLine = ctx.subscriber?.sectorInterest
    ? `Reader sector interest: ${ctx.subscriber.sectorInterest}`
    : '';

  // Locale-specific job-mention examples. Keeping the example phrasing in the
  // target language prevents the model from copying Italian phrasings like
  // "dai un'occhiata al ruolo di ... presso ... a Chiasso" verbatim into an
  // English/German/French email.
  const briefingExamplesByLocale = {
    it: `dai un'occhiata al ruolo di <a target="_blank" rel="noopener noreferrer" href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> presso <a target="_blank" rel="noopener noreferrer" href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> a Chiasso`,
    en: `take a look at the <a target="_blank" rel="noopener noreferrer" href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> role at <a target="_blank" rel="noopener noreferrer" href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> in Chiasso`,
    de: `schau dir die Stelle als <a target="_blank" rel="noopener noreferrer" href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> bei <a target="_blank" rel="noopener noreferrer" href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> in Chiasso an`,
    fr: `jetez un œil au poste de <a target="_blank" rel="noopener noreferrer" href="JOB_URL" style="color:#2563eb;text-decoration:underline;">Software Engineer</a> chez <a target="_blank" rel="noopener noreferrer" href="COMPANY_URL" style="color:#2563eb;text-decoration:underline;">Board International</a> à Chiasso`,
  };
  const briefingExample = briefingExamplesByLocale[locale] || briefingExamplesByLocale.it;

  const system = [
    `You write the opening section of a weekly email newsletter for "Frontaliere Ticino", a platform for cross-border workers (frontalieri) between Italy and Switzerland.`,
    `Write in ${langName}. Be warm, conversational, and practical. Like a knowledgeable friend sharing useful updates.`,
    `ABSOLUTE LANGUAGE RULE: Every word in your output MUST be in ${langName}. ${locale === 'it' ? '' : `NEVER copy Italian phrasings from any reference material into your ${langName} output — use only natural ${langName} prepositions and verbs to introduce job mentions, company names, and city names. `}Tool names, brand names, and proper nouns are the only exceptions.`,
    `Output 2-3 short paragraphs. Use simple HTML ONLY: <p> tags for paragraphs, <strong> for emphasis, <a target="_blank" rel="noopener noreferrer" href="URL" style="color:#2563eb;text-decoration:underline;"> for links. No greetings, no sign-offs, no subject line.`,
    `CRITICAL: NEVER use Markdown syntax. Do NOT use **bold**, *italic*, [text](link), or any asterisks for emphasis. Always use the HTML tags above. Asterisks will render as literal characters in the email.`,
    `STRUCTURE RULE: First paragraph MUST mention 1-2 specific job opportunities with clickable hyperlinks. Second paragraph covers exchange rate context. Keep jobs EARLY — never push them to the end.`,
    `CRITICAL JOB LINKING RULE: Every job mention MUST have TWO hyperlinks: (1) the job title linked to JOB_URL, and (2) the company name linked to COMPANY_URL. Copy URLs exactly from the data. NEVER use <strong> for job titles or company names — ALWAYS use <a>. If a job has no URL, do NOT mention it. Example (in ${langName}): "${briefingExample}".`,
    `If a Featured tool name is provided, use it EXACTLY as written in the data — never translate, never substitute. The tool name comes pre-localized.`,
    `CRITICAL EXCHANGE RATE RULE: Use ONLY the weekly change percentage provided in the data below. Do NOT calculate or invent a different percentage.`,
    `Naturally weave in the exchange rate, any relevant job or fiscal context, and the weekly fact if interesting. Do NOT list everything — pick what matters most for this reader.`,
    `CRITICAL: Only mention dates that are explicitly provided in the data below. NEVER invent, guess, or assume dates for events, job postings, or facts. If no date is given for something, do not add one. Today's date is ${todayStr}.`,
    `Keep total length under 200 words. Be concise but engaging.`,
  ].join(' ');

  const userParts = [
    rateTrend,
    insightLine,
    jobLines ? `Matched jobs for this reader:\n${jobLines}` : 'No specific jobs matched',
    factLine,
    toolLine,
    locationLine,
    sectorLine,
    interests.length ? `Reader interests: ${interests.join(', ')}` : 'Reader interests: general',
  ].filter(Boolean);

  return { system, user: userParts.join('\n\n') };
}

/**
 * Build a prompt for AI to generate a personalized email subject line.
 *
 * @param {object} ctx
 * @param {object} ctx.subscriber — { locale, preferences, locationInterest }
 * @param {object} ctx.exchangeRate — { rate }
 * @param {Array}  ctx.matchedJobs — [{ title }]
 * @param {string} [ctx.briefingSummary] — First line of the AI briefing, if available
 * @returns {{ system: string, user: string }}
 */
export function buildSubjectPrompt(ctx) {
  const locale = nlNormLocale(ctx.subscriber?.locale);
  const langName = LOCALE_NAMES[locale] || 'Italian';

  // Day of week for time-sensitive hooks
  const dayNames = { it: ['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'], en: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], de: ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'], fr: ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'] };
  const today = (dayNames[locale] || dayNames.it)[new Date().getDay()];

  // Locale-specific subject examples. Keeping examples in the target language
  // prevents the model from drifting to Italian when locale != 'it'.
  const examplesByLocale = {
    it: [
      `- Curiosity gap: "⚡ Il tasso CHF scende: quanto perdi?"`,
      `- Number + location: "📊 3 aziende assumono a Lugano"`,
      `- Direct benefit: "💰 Simula il netto 2026 in 30 sec"`,
      `- Urgency/FOMO: "🔥 Scadenza fiscale: hai controllato?"`,
      `- Question hook: "🤔 Permesso G o B? Il calcolo che conta"`,
      `- News peg: "📰 ${today}: cosa cambia per i frontalieri"`,
    ],
    en: [
      `- Curiosity gap: "⚡ CHF rate is dropping: how much are you losing?"`,
      `- Number + location: "📊 3 companies hiring in Lugano"`,
      `- Direct benefit: "💰 Simulate your 2026 net pay in 30 sec"`,
      `- Urgency/FOMO: "🔥 Tax deadline: have you checked?"`,
      `- Question hook: "🤔 Permit G or B? The calc that matters"`,
      `- News peg: "📰 ${today}: what's changing for frontalieri"`,
    ],
    de: [
      `- Curiosity gap: "⚡ CHF-Kurs fällt: wie viel verlierst du?"`,
      `- Number + location: "📊 3 Firmen stellen in Lugano ein"`,
      `- Direct benefit: "💰 Nettolohn 2026 in 30 Sek berechnen"`,
      `- Urgency/FOMO: "🔥 Steuerfrist: schon geprüft?"`,
      `- Question hook: "🤔 Bewilligung G oder B? Die Rechnung zählt"`,
      `- News peg: "📰 ${today}: was sich für Grenzgänger ändert"`,
    ],
    fr: [
      `- Curiosity gap: "⚡ Le taux CHF baisse : combien tu perds ?"`,
      `- Number + location: "📊 3 entreprises recrutent à Lugano"`,
      `- Direct benefit: "💰 Simule ton net 2026 en 30 sec"`,
      `- Urgency/FOMO: "🔥 Échéance fiscale : t'as vérifié ?"`,
      `- Question hook: "🤔 Permis G ou B ? Le calcul qui compte"`,
      `- News peg: "📰 ${today} : ce qui change pour les frontaliers"`,
    ],
  };
  const examples = (examplesByLocale[locale] || examplesByLocale.it).join('\n');

  // Voice pronouns per locale to avoid "tu/you" instruction being misread
  const voiceByLocale = {
    it: `Use "tu" voice, never "noi"`,
    en: `Use "you" voice, never "we"`,
    de: `Use "du" voice, never "wir"`,
    fr: `Use "tu" voice, never "nous"`,
  };

  // A/B test: bias the subject toward the assigned variant's style (concrete vs
  // curious). Empty string when ctx.variant is unset/unknown → prompt unchanged.
  const variantDirective = getVariantStyleDirective(ctx.variant, locale);

  const system = [
    `You are a world-class email copywriter for "Frontaliere Ticino", a fintech app for Swiss-Italian cross-border workers.`,
    `Write ONE email subject line in ${langName}. STRICTLY 35-50 characters including emoji. Count carefully.`,
    `ABSOLUTE LANGUAGE RULE: The subject MUST be written in ${langName} — NOT Italian, NOT English, NOT any other language. If the target is ${langName} and you output Italian (or any other language), the output will be rejected. All example phrasings below are in ${langName} to make this unambiguous.`,
    ``,
    `PROVEN PATTERNS (pick one and adapt — stay in ${langName}):`,
    examples,
    ...(variantDirective ? [``, variantDirective] : []),
    ``,
    `RULES:`,
    `- Start with ONE emoji (⚡💰📊🔥🤔📰🏦💼)`,
    `- MUST be a complete phrase — NEVER end with "..." or a cut-off word`,
    `- ${voiceByLocale[locale] || voiceByLocale.it}`,
    `- NO exact numbers (exchange rates, percentages)`,
    `- NO generic words like "update", "newsletter", "weekly" or their ${langName} equivalents`,
    `- ONE hook only. Make the reader NEED to open the email.`,
    `- Output ONLY the subject line in ${langName}. No quotes, no translation, no explanation.`,
  ].join('\n');

  const hints = [];
  if (ctx.exchangeRate) {
    const pct = ctx.exchangeRate.previousRate
      ? ((ctx.exchangeRate.rate - ctx.exchangeRate.previousRate) / ctx.exchangeRate.previousRate * 100)
      : 0;
    const dir = pct > 0.1 ? 'strengthening' : pct < -0.1 ? 'weakening' : 'stable';
    hints.push(`CHF/EUR trend: ${dir} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`);
  }
  if (ctx.matchedJobs?.length) {
    const companies = [...new Set(ctx.matchedJobs.map(j => j.company))].slice(0, 3);
    hints.push(`Hot companies: ${companies.join(', ')}`);
    if (ctx.matchedJobs[0]?.location) hints.push(`Job location: ${ctx.matchedJobs[0].location}`);
  }
  if (ctx.subscriber?.locationInterest) hints.push(`Reader location: ${ctx.subscriber.locationInterest}`);
  if (ctx.briefingSummary) hints.push(`Theme: ${ctx.briefingSummary.slice(0, 80)}`);

  return { system, user: hints.join(' | ') || 'Generate a compelling subject for cross-border workers' };
}

/**
 * Fallback content when AI is unavailable.
 */
// Evergreen fallbacks — used when AI subject generation fails or returns degenerate
// output (empty, too short, emoji-only). Each MUST satisfy inlineQaCheck:
//   - 10 <= length <= 60
//   - no trailing "..." or "…"
//   - non-empty word content (catches all-emoji/all-punct edge cases)
// Validated by tests/newsletter-fallback-subjects.test.ts.
export const FALLBACK_SUBJECT = {
  it: '\u26a1 Frontaliere: cambio, lavoro, zero fuffa',
  en: '\u26a1 Frontaliere: rates, jobs, no fluff',
  de: '\u26a1 Frontaliere: Kurs, Jobs, kein Quatsch',
  fr: '\u26a1 Frontaliere: taux, emplois, z\u00e9ro blabla',
};

export function getFallbackBriefing(locale, exchangeRate) {
  const rate = exchangeRate?.rate?.toFixed(4) || '0.9420';
  const briefings = {
    it: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Ogni settimana ti dicono che "il mercato \u00e8 volatile" e che "bisogna stare attenti". Grazie, utilissimo. Come dire a uno che sta annegando che l\u2019acqua \u00e8 bagnata.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Noi preferiamo i numeri. Quelli veri, quelli che trovi in busta paga. Questa settimana: il cambio \u00e8 a <strong>${rate}</strong>, e c\u2019\u00e8 una votazione che forse ti sei perso tra un cappuccino e la coda a Brogeda.</p>`,
    en: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Every week they tell you "the market is volatile". Thanks, very helpful. Like telling someone who's drowning that water is wet.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">We prefer numbers. Real ones, the kind you find on your payslip. This week: rate at <strong>${rate}</strong>.</p>`,
    de: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Jede Woche sagen sie dir, der Markt sei volatil. Danke, sehr hilfreich. Wie einem Ertrinkenden zu sagen, dass Wasser nass ist.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Wir bevorzugen Zahlen. Echte Zahlen. Diese Woche: Kurs bei <strong>${rate}</strong>.</p>`,
    fr: `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Chaque semaine on te dit que "le march\u00e9 est volatil". Merci, tr\u00e8s utile. Comme dire \u00e0 quelqu'un qui se noie que l'eau est mouill\u00e9e.</p><p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">Nous pr\u00e9f\u00e9rons les chiffres. Les vrais. Cette semaine : taux \u00e0 <strong>${rate}</strong>.</p>`,
  };
  return briefings[locale] || briefings.it;
}
