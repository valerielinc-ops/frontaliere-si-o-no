#!/usr/bin/env node
/**
 * Dedicated PostFinance crawler runner.
 * Discovers PostFinance positions (CH-wide, all 26 cantons) via the
 * job.post.ch Swiss Post Group recruiting platform.
 *
 * PostFinance is a national Swiss bank and a subsidiary of Swiss Post. Both
 * share the same job.post.ch recruiting platform. This crawler targets
 * PostFinance-specific positions, CH-wide (no canton/region pre-filter).
 *
 * job.post.ch migrated to a client-side-rendered SPA at some point before
 * 2026-07; the jobs.postfinance.ch sitemap no longer lists any
 * /PostFinance/job/ URLs (site now serves /PostKG/job/ and bare /job/ paths
 * instead — see #4759), which silently starved the old sitemap-based
 * discovery. Primary discovery flow (fallback flow below it):
 *   1. Paginate the job.post.ch recruiting JSON API
 *      (POST /services/recruiting/v1/jobs) and filter entries whose
 *      `brandUrl` field equals "PostFinance" (the API has no server-side
 *      brand filter param that works — passing brand:"PFCH" returns
 *      totalJobs:0 — so filtering happens client-side on the full result set)
 *   2. Build the canonical job URL from each entry's `id`/`urlTitle`
 *      (https://job.post.ch/PostFinance/job/{urlTitle}/{id}/)
 *   3. Resolve canton from the entry's `jobLocationShort` field, falling
 *      back to inferAnyCanton (all 26 cantons); drop jobs that don't
 *      resolve to a Swiss canton (non-CH). Never default to TI.
 *   4. Best-effort fetch the detail page for a fuller description; since
 *      job.post.ch hydrates the description client-side this is often thin,
 *      so a substantive fallback description is built from listing fields
 *      whenever scraped content is too short (thin-content floor, see
 *      Non-Negotiable #4)
 *   5. Merge into dataset, run AI localization, validate locale coverage
 *   6. Write per-crawler slice and reassemble global dataset
 *
 * Legacy fallback flow (only runs if the recruiting API returns 0
 * PostFinance jobs — kept in case sitemap coverage is restored upstream):
 *   1. Fetch sitemap from jobs.postfinance.ch/sitemap.xml
 *   2. Filter for /PostFinance/job/ URLs (national, unfiltered)
 *   3. Optionally scan PostCH corporate listing pages for /v2/ URLs
 *   4. Cross-reference: prefer /v2/ URL (has JSON-LD) when available
 *   5. Fetch detail pages, extract data from meta tags or JSON-LD
 *   6. Per-job canton via inferAnyCanton on the city slug (all 26 cantons);
 *      drop jobs whose canton does not resolve to a Swiss canton (non-CH)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  printPublishedJobUrls,
  writeJobsSummary,
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parsePostJobDetail } from './lib/postch-job-parser.mjs';
import {  inferAnyCanton  } from './lib/target-swiss-locations.mjs';
import { normalizeCantonCode } from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError, stripScriptsAndStyles } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { readAttr, readMetaContent } from './lib/html-attr.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'postfinance';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'PostFinance';
const COMPANY_HOST = 'jobs.postfinance.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];

const SITEMAP_URL = 'https://jobs.postfinance.ch/sitemap.xml';

// PostCH corporate listing pages — used to find supplementary /v2/ URLs
const POSTCH_LISTING_URLS = [
  'https://www.post.ch/en/jobs/jobs?jobsCategory=professionals&workload-maximum=1&workload-minimum=0',
];

// job.post.ch recruiting JSON API — reverse-engineered from the site's own
// client-side JS (postJobs()/fetchAllJobs()); this is what the SPA itself
// calls to hydrate listings. Reachable directly, unauthenticated. See #4759.
const RECRUITING_API_URL = 'https://job.post.ch/services/recruiting/v1/jobs';
const RECRUITING_API_PAGE_SIZE = 10;
const RECRUITING_API_MAX_PAGES = 60; // safety cap; ~126 total postings today (~13 pages)

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return truncateSlugAtWordBoundary(s, 200);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Match a job object as belonging to the PostFinance crawl.
 */
function isPostFinanceJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key.includes('postfinance') ||
    key.includes('post-finance') ||
    url.includes('/postfinance/')
  );
}

// ──────────────────────────────────────────────────────────────
// HTML / XML fetching
// ──────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one page of the job.post.ch recruiting JSON API.
 * Returns the parsed response body, or null on failure.
 */
async function fetchRecruitingApiPage(pageNumber, { locale = 'de_DE', timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(RECRUITING_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      body: JSON.stringify({
        locale,
        pageNumber,
        pageSize: RECRUITING_API_PAGE_SIZE,
        sortBy: 'date',
      }),
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for recruiting API page ${pageNumber}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`⚠️ Recruiting API fetch failed (page ${pageNumber}): ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Paginate the recruiting API and return every Swiss Post Group posting
 * whose `brandUrl` is "PostFinance". There is no working server-side brand
 * filter (passing brand:"PFCH" in the request body returns totalJobs:0),
 * so the full result set is fetched and filtered client-side — see #4759.
 */
async function fetchPostFinanceListingsViaRecruitingApi() {
  const results = [];
  let total = null;
  let pageNumber = 0;

  while (pageNumber < RECRUITING_API_MAX_PAGES) {
    const page = await fetchRecruitingApiPage(pageNumber);
    if (!page) break;

    const entries = Array.isArray(page.jobSearchResult) ? page.jobSearchResult : [];
    if (total === null) total = Number(page.totalJobs) || 0;
    for (const entry of entries) {
      if (entry?.response) results.push(entry.response);
    }

    pageNumber += 1;
    if (entries.length === 0) break;
    if (total !== null && results.length >= total) break;
    await delay(300);
  }

  const pfJobs = results.filter((r) => r?.brandUrl === 'PostFinance');
  console.log(`  🔎 Recruiting API: ${results.length} Swiss Post Group postings scanned, ${pfJobs.length} PostFinance-branded.`);
  return pfJobs;
}

// ──────────────────────────────────────────────────────────────
// Sitemap parsing
// ──────────────────────────────────────────────────────────────

/**
 * Parse sitemap XML and extract <loc> URLs.
 */
function parseSitemapUrls(xml = '') {
  const urls = [];
  const locRe = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let match;
  while ((match = locRe.exec(xml)) !== null) {
    const url = match[1].replace(/&amp;/g, '&').trim();
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Filter sitemap URLs for PostFinance jobs (CH-wide, no canton pre-filter).
 * The jobs.postfinance.ch sitemap is a flat urlset hosted on job.post.ch that
 * mixes all Swiss Post brands; we keep only PostFinance-branded vacancies.
 * Per-job canton is resolved downstream via inferAnyCanton (all 26 cantons),
 * which also drops non-CH/unresolved postings.
 * PostFinance job URLs: https://job.post.ch/PostFinance/job/{slug}/{reqId}/
 */
function filterPostFinanceUrls(urls) {
  return urls.filter((url) => url.includes('/PostFinance/job/'));
}

/**
 * Extract the city name from a PostFinance job URL slug.
 * URL format: .../PostFinance/job/Bern-Compliance-Officer-(wmd)/1378566933/
 * The first segment of the slug (before the first dash followed by a role keyword) is usually the city.
 */
function extractCityFromSlug(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    // Find the segment after 'job'
    const jobIdx = segments.indexOf('job');
    if (jobIdx < 0 || jobIdx + 1 >= segments.length) return '';
    let slug = segments[jobIdx + 1] || '';
    // Slug segments are URL-encoded (e.g. Gen%C3%A8ve, Z%C3%BCrich) — decode so
    // the city signal is clean for inferAnyCanton.
    try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
    const parts = slug.split('-');
    // The first part(s) before a common title word is the city
    // PostFinance URLs typically start with the city name
    if (parts.length === 0) return '';
    // Capitalize the first part as a city candidate
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  } catch {
    return '';
  }
}

/**
 * Extract the requisition/external ID from the URL.
 * URL format: .../PostFinance/job/{slug}/{reqId}/
 */
function extractReqId(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const jobIdx = segments.indexOf('job');
    if (jobIdx < 0 || jobIdx + 2 >= segments.length) return '';
    return segments[jobIdx + 2] || '';
  } catch {
    return '';
  }
}

// ──────────────────────────────────────────────────────────────
// Meta tag parsing (for /PostFinance/job/ pages without JSON-LD)
// ──────────────────────────────────────────────────────────────

function extractMeta(html, name) {
  return readMetaContent(html, name).trim();
}

function extractHtmlTitle(html) {
  const match = stripScriptsAndStyles(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function extractCanonical(html) {
  const canonicalTag = [...String(html || '').matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .find((tag) => readAttr(tag, 'rel').toLowerCase() === 'canonical');
  return canonicalTag ? readAttr(canonicalTag, 'href').trim() : '';
}

/**
 * Clean the job title by removing the SuccessFactors suffix.
 */
function cleanTitle(rawTitle = '') {
  return rawTitle
    .replace(/\s*[|–—]\s*Dettagli lavoro\s*\|.*$/i, '')
    .replace(/\s*[|–—]\s*Job Details\s*\|.*$/i, '')
    .replace(/\s*[|–—]\s*Stellendetails\s*\|.*$/i, '')
    .replace(/\s*[|–—]\s*Détails du poste\s*\|.*$/i, '')
    .replace(/\s*[|–—]\s*Post\s*[|]\s*PostFinance\s*[|]\s*PostAuto\s*$/i, '')
    .replace(/\s*[|–—]\s*PostFinance$/i, '')
    .trim();
}

/**
 * Decode common HTML entities into plain text.
 */
function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    });
}

/**
 * Strip inner HTML tags, decode entities, and collapse whitespace.
 */
function htmlToText(fragment = '') {
  return decodeHtmlEntities(
    String(fragment)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|ul|ol|div|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the full job description from a SuccessFactors PostFinance HTML page.
 *
 * The page renders the description inside one of multiple
 * `<div class="joblayouttoken">` blocks. Each block contains a
 * `<span class="rtltextaligneligible">` with field content. Most spans
 * hold short single-value fields (city, dates, salary, etc.) — but the
 * description span uniquely contains rich HTML (`<p>`, `<ul>`, `<li>`).
 *
 * Strategy: collect all `rtltextaligneligible` spans, score them by the
 * length of their plain-text content, prefer those that contain `<p>` or
 * `<li>` tags (paragraph-style content), and return the longest one.
 */
export function extractPostFinanceBodyDescription(html = '') {
  if (!html || typeof html !== 'string') return '';

  // Match all rtltextaligneligible spans (multiline, non-greedy).
  const spanRe = /<span[^>]*class="[^"]*rtltextaligneligible[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  const candidates = [];
  let match;
  while ((match = spanRe.exec(html)) !== null) {
    const inner = match[1];
    const hasParagraph = /<p[\s>]|<li[\s>]|<ul[\s>]|<ol[\s>]/i.test(inner);
    const text = htmlToText(inner);
    if (text.length > 0) {
      candidates.push({ text, length: text.length, hasParagraph });
    }
  }

  if (candidates.length === 0) return '';

  // Prefer paragraph-style candidates first, then fall back to longest plain text.
  const paragraphCandidates = candidates.filter((c) => c.hasParagraph);
  const pool = paragraphCandidates.length > 0 ? paragraphCandidates : candidates;
  pool.sort((a, b) => b.length - a.length);
  return pool[0].text;
}

/**
 * Parse a PostFinance /PostFinance/job/ detail page.
 *
 * Pages do not expose JSON-LD; the `<meta name="description">` is the SEO
 * snippet (truncated to ~150 chars and often just the job title). We extract
 * the full description from the HTML body via
 * {@link extractPostFinanceBodyDescription} and only fall back to the meta
 * tag when body extraction yields too little content.
 */
function parsePostFinanceMetaPage(html, url) {
  const ogTitle = extractMeta(html, 'og:title');
  const ogDesc = extractMeta(html, 'og:description');
  const metaDesc = extractMeta(html, 'description');
  const htmlTitle = extractHtmlTitle(html);
  const canonical = extractCanonical(html);

  const title = cleanTitle(ogTitle || htmlTitle || '');

  const bodyDescription = extractPostFinanceBodyDescription(html);
  const metaDescription = ogDesc || metaDesc || '';
  const description = bodyDescription.length >= 150 ? bodyDescription : metaDescription;

  return {
    title,
    description,
    canonical,
    url,
    hasJsonLd: false,
  };
}

export { parsePostFinanceMetaPage };

// ──────────────────────────────────────────────────────────────
// PostCH listing page scan (for supplementary /v2/ URLs)
// ──────────────────────────────────────────────────────────────

/**
 * Parse PostCH corporate listing pages to find /v2/job-vacancies/ links.
 * Returns a Map<string, string> of normalizedTitle+city → v2 URL.
 */
async function scanPostChListingsForV2Urls() {
  const v2Map = new Map();

  for (const listingUrl of POSTCH_LISTING_URLS) {
    console.log(`  📄 Scanning PostCH listing for /v2/ URLs: ${listingUrl}`);
    const html = await fetchPage(listingUrl, 20000);
    if (!html) {
      console.warn(`  ⚠️ Failed to fetch PostCH listing: ${listingUrl}`);
      continue;
    }

    // Extract /v2/job-vacancies/ links
    const linkRe = /href="(https:\/\/job\.post\.ch\/v2\/job-vacancies\/[^"]+)"/gi;
    let match;
    while ((match = linkRe.exec(html)) !== null) {
      const v2Url = match[1].replace(/&amp;/g, '&');
      // Extract a rough key from the URL slug for cross-referencing
      try {
        const slug = new URL(v2Url).pathname.split('/').filter(Boolean)[2] || '';
        const key = normalize(slug.replace(/-/g, ' '));
        if (key) v2Map.set(key, v2Url);
      } catch { /* skip */ }
    }
    await delay(400);
  }

  console.log(`  ✅ Found ${v2Map.size} /v2/ URLs from PostCH listings`);
  return v2Map;
}

/**
 * Try to find a matching /v2/ URL for a PostFinance job by title/city similarity.
 */
function findV2Match(v2Map, title, city) {
  const titleKey = normalize(title.replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, ' '));
  const cityKey = normalize(city);

  for (const [key, url] of v2Map) {
    if (key.includes(cityKey) && titleKey.split(' ').some((w) => w.length > 3 && key.includes(w))) {
      // Check URL also belongs to PostFinance domain or title
      if (url.toLowerCase().includes('postfinance') || key.includes('postfinance')) {
        return url;
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
// Location validation
// ──────────────────────────────────────────────────────────────

/**
 * Resolve the canton for a PostFinance job CH-wide (all 26 cantons).
 *
 * The cleanest single signal is the city string ALONE — passing a combined
 * "city + region" string makes inferAnyCanton return the wrong canton because
 * of TARGET_CANTONS array ordering. Returns '' when the location does not
 * resolve to a Swiss canton (non-CH / foreign), so the caller can drop it.
 * Never defaults to TI.
 */
function detectCanton(city = '') {
  return inferAnyCanton(city);
}

function detectEmploymentType(detail) {
  const et = normalize(detail.employmentType || '');
  if (et.includes('part')) return 'PART_TIME';
  if (/\bintern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])/.test(et)) return 'INTERN';
  return 'FULL_TIME';
}

function detectSector(title = '') {
  const t = normalize(title);
  if (t.includes('finanz') || t.includes('finance') || t.includes('bank') || t.includes('compliance')) return 'Finanza';
  if (t.includes('inform') || t.includes(' it ') || t.includes('software') || t.includes('develop') || t.includes('data') || t.includes('cyber')) return 'IT';
  if (t.includes('market') || t.includes('kommunik') || t.includes('comunicaz')) return 'Marketing';
  if (t.includes('consult') || t.includes('berat')) return 'Consulenza';
  if (t.includes('risk') || t.includes('audit')) return 'Finanza';
  if (t.includes('hr ') || t.includes('human') || t.includes('personal')) return 'Risorse Umane';
  return 'Servizi Finanziari';
}

// Localities the recruiting API uses for non-physical placements
// (home office / remote / hybrid, DE/FR/IT/EN). They appear as a
// `jobLocationShort` entry and carry no canton — skip them when resolving a
// record's canton. Mirrors NON_PHYSICAL_LOCALITIES in update-postch-jobs.mjs
// (same job.post.ch platform, same field shape).
const NON_PHYSICAL_LOCALITIES = new Set([
  'homeoffice', 'home office', 'home-office',
  'remote', 'remotearbeit', 'travail à distance', 'lavoro a distanza', 'fernarbeit',
  'hybrid', 'hybride', 'ibrido', 'hub locations', 'siti hub',
]);

/**
 * Resolve city + canton from a recruiting-API `jobLocationShort` entry.
 *
 * Full shape for a resolved Swiss location: 5 pipe-delimited fields —
 * "City|CantonName|CantonCode|Country|CountryCode". Remote/homeoffice
 * postings collapse to 3 fields — "Homeoffice|Schweiz|CHE" — with no
 * canton. Multi-site postings list several entries; walk them looking for
 * the first explicit canton code before falling back to inferAnyCanton on
 * any city-like token. Never defaults to TI.
 *
 * The canton-code token is read from the UNFILTERED split at its POSITIONAL
 * index (2) rather than from a `.filter(Boolean)`'d array — filtering first
 * would shift the code off index 2 whenever the localized canton-name token
 * (index 1) is empty ("City||CC|Country|CCC"), silently dropping valid CH
 * jobs in small municipalities. Mirrors resolveRecordCanton in
 * update-postch-jobs.mjs, which hit and fixed this exact positional bug on
 * the same API/field shape.
 */
function resolveRecruitingApiLocation(jobLocationShort) {
  const entries = Array.isArray(jobLocationShort)
    ? jobLocationShort
    : [jobLocationShort].filter(Boolean);

  for (const entry of entries) {
    const raw = String(entry || '').split('|').map((p) => p.trim());
    const parts = raw.filter(Boolean);
    if (parts.length === 0) continue;

    const city = parts[0];
    if (!city || NON_PHYSICAL_LOCALITIES.has(city.toLowerCase())) continue;

    // Reject foreign locations: the trailing token is the ISO-3 country code.
    const countryCode = String(parts[parts.length - 1] || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(countryCode) && countryCode !== 'CHE') continue;

    // Canonical 2-letter canton code — positional index 2 in the UNFILTERED
    // 5-token CH form (see doc note above).
    const code = raw.length >= 5 ? normalizeCantonCode(raw[2]) : '';
    if (code) return { city, canton: code };

    const inferred = inferAnyCanton(city);
    if (inferred) return { city, canton: inferred };
  }

  const fallbackCity = entries[0] ? String(entries[0]).split('|')[0].trim() : '';
  return { city: fallbackCity, canton: '' };
}

/**
 * Build a substantive fallback description (well above the 50-word
 * thin-content floor, Non-Negotiable #4) from listing fields.
 *
 * job.post.ch hydrates the job description client-side, so a raw fetch of
 * the detail page frequently returns SPA-shell boilerplate with no usable
 * body text (see #4759). Used both by the recruiting-API path and by the
 * legacy sitemap path whenever the scraped/JSON-LD description is thin.
 */
function buildPostFinanceFallbackDescription({ title, city, canton, category, workloadMin, workloadMax }) {
  const workloadText = workloadMin && workloadMax
    ? (Number(workloadMin) === Number(workloadMax)
      ? `con un grado di occupazione del ${workloadMin}%`
      : `con un grado di occupazione flessibile tra il ${workloadMin}% e il ${workloadMax}%`)
    : 'con grado di occupazione da concordare';
  const categoryText = category ? ` nell'ambito "${category}"` : '';
  return [
    `PostFinance, la sussidiaria di servizi finanziari della Posta Svizzera, ricerca attualmente la figura "${title}" per la sede di ${city} (Cantone ${canton}).`,
    `La posizione${categoryText} è pubblicata ${workloadText} sul portale ufficiale delle carriere PostFinance/Posta Svizzera e rientra nell'offerta corrente di impieghi disponibili in Svizzera.`,
    `Per consultare i requisiti completi del profilo ricercato, le condizioni di impiego e candidarsi direttamente, è necessario visitare la pagina dell'annuncio collegata a questo articolo.`,
  ].join(' ');
}

/**
 * Build a job record from one recruiting-API listing entry, enriching it
 * with a best-effort scrape of the detail page when possible.
 */
async function buildJobFromRecruitingApiEntry(entry) {
  const id = entry?.id;
  const urlTitle = entry?.urlTitle || '';
  if (!id || !urlTitle) return null;

  const title = cleanTitle(entry.unifiedStandardTitle || '');
  if (!title) return null;

  const { city, canton } = resolveRecruitingApiLocation(entry.jobLocationShort);
  if (!canton) {
    console.log(`     ↳ Skipping (non-CH / unresolved canton): ${title} — ${city || '?'}`);
    return null;
  }

  // Canonical detail URL: jobs.postfinance.ch/job/{slug}/{id}-{locale} —
  // verified live (2026-07-27). The job.post.ch/PostFinance/job/{slug}/{id}/
  // form used by the pre-migration sitemap now 301-redirects to a generic
  // errorpage; jobs.postfinance.ch (this crawler's own COMPANY_HOST) with
  // the `-{locale}` id suffix is the format update-postch-jobs.mjs's
  // buildDetailUrl already relies on for the same job.post.ch platform, and
  // is confirmed to still serve the legacy SuccessFactors HTML (real
  // `rtltextaligneligible` body spans, not an SPA shell) that
  // extractPostFinanceBodyDescription/parsePostFinanceMetaPage expect.
  const url = `https://${COMPANY_HOST}/job/${decodeHtmlEntities(urlTitle)}/${id}-de_DE`;

  // Best-effort enrichment — real content is expected here (see URL doc
  // above), but fall back to buildPostFinanceFallbackDescription below if
  // the page ever regresses to thin/no content.
  const html = await fetchPage(url, 15000);
  const scraped = html ? parsePostFinanceMetaPage(html, url) : null;
  await delay(300);

  const category = entry.filter1 || entry.filter2 || '';
  const workloadMin = entry.cust_WorkingTimeMin;
  const workloadMax = entry.cust_WorkingTimeMax;

  // 150 chars mirrors parsePostFinanceMetaPage's own bar for "real body
  // content vs SEO meta-tag snippet" (see its extractPostFinanceBodyDescription
  // call) — anything shorter is treated as thin and gets the substantive
  // fallback instead.
  const scrapedDescription = scraped?.description && scraped.description.length >= 150
    ? scraped.description
    : '';
  const descriptionIt = scrapedDescription || buildPostFinanceFallbackDescription({
    title, city, canton, category, workloadMin, workloadMax,
  });

  const slug = slugify(title, 'postfinance');

  return {
    url,
    applyUrl: url,
    title,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    location: city,
    canton,
    country: 'CH',
    description: descriptionIt,
    descriptionByLocale: { it: descriptionIt },
    titleByLocale: { it: title },
    slug,
    slugByLocale: { it: slug },
    sourceLang: detectLang(descriptionIt || title, 'en'),
    department: category,
    category: category || 'servizi-finanziari',
    datePosted: entry.unifiedStandardStart || new Date().toISOString().split('T')[0],
    validThrough: entry.unifiedStandardEnd || '',
    source: 'postfinance-careers-crawler',
    employmentType: category ? detectEmploymentType({ employmentType: category }) : 'FULL_TIME',
    experienceLevel: '',
    sector: detectSector(title),
    workload: workloadMin && workloadMax ? `${workloadMin}-${workloadMax}%` : '',
    needsRetranslation: !scrapedDescription,
    _targetScope: { canton, location: city },
  };
}

async function fetchPostFinanceJobsViaRecruitingApi() {
  const entries = await fetchPostFinanceListingsViaRecruitingApi();
  const jobs = [];
  for (const entry of entries) {
    const job = await buildJobFromRecruitingApiEntry(entry);
    if (job) {
      jobs.push(job);
      console.log(`     ✅ ${job.title} — ${job.location} (${job.canton})${job.needsRetranslation ? ' [needs retranslation]' : ''}`);
    }
  }
  console.log(`\n📋 Total PostFinance CH-wide jobs discovered via recruiting API: ${jobs.length}`);
  return jobs;
}

// ──────────────────────────────────────────────────────────────
// Main discovery flow
// ──────────────────────────────────────────────────────────────

async function fetchPostFinanceJobs() {
  console.log('🏦 Fetching PostFinance job listings...');

  // Primary path: job.post.ch recruiting API. See file header for why the
  // sitemap-based flow below is now a fallback rather than the primary.
  const apiJobs = await fetchPostFinanceJobsViaRecruitingApi();
  if (apiJobs.length > 0) return apiJobs;

  console.warn('  ⚠️ Recruiting API returned 0 PostFinance jobs — falling back to legacy sitemap discovery.');

  // Legacy path — expected to also return [] today (sitemap no longer lists
  // /PostFinance/job/ URLs, see #4759); kept in case sitemap coverage is
  // restored upstream so a future platform change degrades gracefully
  // instead of a hard outage.
  console.log(`  📄 Sitemap URL: ${SITEMAP_URL}`);
  const sitemapXml = await fetchPage(SITEMAP_URL, 20000);
  if (!sitemapXml) {
    console.warn('  ⚠️ Failed to fetch sitemap — aborting.');
    return [];
  }

  const allUrls = parseSitemapUrls(sitemapXml);
  console.log(`  📋 Total URLs in sitemap: ${allUrls.length}`);

  const pfUrls = filterPostFinanceUrls(allUrls);
  console.log(`  🎯 PostFinance job URLs (national): ${pfUrls.length}`);

  if (pfUrls.length === 0) return [];

  const v2Map = await scanPostChListingsForV2Urls();

  return fetchAndParseJobDetails(pfUrls, v2Map);
}

async function fetchAndParseJobDetails(urls, v2Map = new Map()) {
  const jobs = [];

  for (const url of urls) {
    const reqId = extractReqId(url);
    const cityFromSlug = extractCityFromSlug(url);

    // Try to find a matching /v2/ URL (has richer JSON-LD)
    const v2Url = findV2Match(v2Map, cityFromSlug, cityFromSlug);

    let detail;
    let sourceUrl = url;

    if (v2Url) {
      // Prefer /v2/ URL — has JSON-LD
      console.log(`  📄 Fetching /v2/ detail: ${v2Url}`);
      const v2Html = await fetchPage(v2Url, 15000);
      if (v2Html) {
        detail = parsePostJobDetail(v2Html, v2Url);
        sourceUrl = v2Url;
      }
      await delay(400);
    }

    if (!detail) {
      // Fallback: fetch the /PostFinance/job/ page (meta tags only)
      console.log(`  📄 Fetching PostFinance detail: ${url}`);
      const html = await fetchPage(url, 15000);
      if (!html) {
        console.warn(`  ⚠️ Failed to fetch ${url}`);
        await delay(400);
        continue;
      }
      detail = parsePostFinanceMetaPage(html, url);
      await delay(400);
    }

    if (!detail || !detail.title) {
      console.warn(`  ⚠️ No title extracted for ${url}`);
      continue;
    }

    // Determine city — cleanest single signal for canton inference.
    const city = detail.city || cityFromSlug || '';

    // CH-wide: resolve canton from the city string ALONE (all 26 cantons).
    // Drop jobs whose location does not resolve to a Swiss canton (non-CH /
    // foreign, e.g. Budapest). Never default to TI.
    const canton = detectCanton(city);
    if (!canton) {
      console.log(`     ↳ Skipping (non-CH / unresolved canton): ${detail.title} — ${city || '?'}`);
      continue;
    }

    const title = detail.title;
    const slug = slugify(title, 'postfinance');

    const descriptionIt = detail.description && detail.description.length > 30
      ? detail.description
      : buildPostFinanceFallbackDescription({ title, city, canton, category: '', workloadMin: null, workloadMax: null });

    // Mark as needsRetranslation if description came from meta tags (thin content)
    const needsRetranslation = !detail.hasJsonLd || detail.description?.length < 100;

    const job = {
      url: sourceUrl,
      applyUrl: url, // Always use the PostFinance-branded URL for applications
      title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location: city,
      canton,
      country: 'CH',
      description: descriptionIt,
      descriptionByLocale: { it: descriptionIt },
      titleByLocale: { it: title },
      slug,
      slugByLocale: { it: slug },
      sourceLang: detectLang(descriptionIt || title, 'en'),
      department: detail.industry || '',
      category: detail.industry || 'servizi-finanziari',
      datePosted: detail.datePosted || new Date().toISOString().split('T')[0],
      validThrough: detail.validThrough || '',
      source: 'postfinance-careers-crawler',
      employmentType: detail.employmentType ? detectEmploymentType(detail) : 'FULL_TIME',
      experienceLevel: '',
      sector: detectSector(title),
      workload: detail.workload || '',
      needsRetranslation,
      _targetScope: { canton, location: city },
    };

    jobs.push(job);
    console.log(`     ✅ ${title} — ${city} (${canton})${needsRetranslation ? ' [needs retranslation]' : ''}`);
  }

  console.log(`\n📋 Total PostFinance CH-wide jobs discovered: ${jobs.length}`);
  return jobs;
}

// ──────────────────────────────────────────────────────────────
// Merge into existing dataset
// ──────────────────────────────────────────────────────────────

/**
 * Normalize a job URL for comparison purposes.
 */
function normalizeUrl(url = '') {
  try {
    const u = new URL(url);
    // Remove trailing slash, lowercase hostname
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(url).toLowerCase().replace(/\/+$/, '');
  }
}

// Stable match key: prefer the trailing requisition id extracted from
// `url`, falling back to the one extracted from `applyUrl` (PostFinance's
// own careers page sometimes exposes a generic listing `url` plus an
// ATS-hosted `applyUrl` carrying the real id), then the normalized URL —
// so a vendor title/slug rewrite doesn't orphan the job's
// previousSlugs/previousSlugsByLocale/firstSeenAt history the way the
// previous exact-URL-keyed merge did (issue #3699).
function postFinanceMatchKey(job) {
  return (
    extractStableJobId(job?.url) ||
    extractStableJobId(job?.applyUrl) ||
    normalizeUrl(job?.url) ||
    normalizeUrl(job?.applyUrl) ||
    null
  );
}

async function mergePostFinanceJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonPfJobs = allJobs.filter((j) => !isPostFinanceJob(j));
  const existingPfJobs = allJobs.filter(isPostFinanceJob);

  const existingKeys = new Set(existingPfJobs.map(postFinanceMatchKey).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map(postFinanceMatchKey).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  const merged = mergePreserveLocaleData(existingPfJobs, discoveredJobs, {
    matchKey: postFinanceMatchKey,
  }).map((job) => ({
    ...job,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    country: 'CH',
    source: 'postfinance-careers-crawler',
  }));

  const final = [...nonPfJobs, ...merged];

  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

// ──────────────────────────────────────────────────────────────
// Adapter configuration
// ──────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = COMPANY_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 8);
  adapter.crawlerModes = ['html', 'sitemap'];
  adapter.seedUrls = [
    'https://jobs.postfinance.ch/search/?locale=it_IT',
    SITEMAP_URL,
  ];
  adapter.notes = 'PostFinance careers portal — subsidiary of Swiss Post. Uses SuccessFactors NES platform shared with job.post.ch.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation (AI localization)
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing
// ──────────────────────────────────────────────────────────────

function postProcessPostFinanceJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isPostFinanceJob(job)) continue;

    if (job.companyKey !== COMPANY_KEY) {
      job.companyKey = COMPANY_KEY;
      fixed++;
    }
    if (job.company !== COMPANY_NAME) {
      job.company = COMPANY_NAME;
      fixed++;
    }
    job.country = 'CH';
    if (!job.descriptionByLocale || job.descriptionByLocale.it !== job.description) {
      job.descriptionByLocale = { ...(job.descriptionByLocale || {}), it: job.description };
      fixed++;
    }
    if (!job.titleByLocale || job.titleByLocale.it !== job.title) {
      job.titleByLocale = { ...(job.titleByLocale || {}), it: job.title };
      fixed++;
    }
    if (!job.slugByLocale || job.slugByLocale.it !== job.slug) {
      job.slugByLocale = { ...(job.slugByLocale || {}), it: job.slug };
      fixed++;
    }
    if (!job.canton) {
      // CH-wide canton inference from the city signal; leave unset if unresolved
      // (never default to TI).
      const inferred = detectCanton(job.location);
      if (inferred) {
        job.canton = inferred;
        fixed++;
      }
    }
  }

  if (fixed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} PostFinance jobs (fixed company/location/canton).`);
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logPostFinanceJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const pfJobs = allJobs.filter(isPostFinanceJob);

  const locations = {};
  for (const job of pfJobs) {
    const loc = job.location || 'unknown';
    locations[loc] = (locations[loc] || 0) + 1;
  }

  const sectors = {};
  for (const job of pfJobs) {
    const sec = job.sector || 'unknown';
    sectors[sec] = (sectors[sec] || 0) + 1;
  }

  console.log(`\n📊 === PostFinance Job Stats ===`);
  console.log(`  🏦 Job totali trovati (PostFinance): ${pfJobs.length}`);

  if (Object.keys(locations).length > 0) {
    console.log(`  📍 Per sede:`);
    for (const [loc, count] of Object.entries(locations).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${loc}: ${count}`);
    }
  }

  if (Object.keys(sectors).length > 0) {
    console.log(`  🏢 Per settore:`);
    for (const [sec, count] of Object.entries(sectors).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${sec}: ${count}`);
    }
  }

  console.log('');

  const afterSnapshot = snapshotJobSlugs(pfJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'PostFinance');
  writeCrawlChangeSummaryToGH(crawlDiff, 'PostFinance');
  return { total: pfJobs.length, crawlDiff };
}

function validatePostFinanceLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_POSTFINANCE_STRICT',
    label: 'PostFinance',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isPostFinanceJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    minDescriptionChars: 80,
    noJobsMessage: 'No PostFinance jobs found after crawl.',
    failWhenNoJobs: false, // PostFinance may have 0 CH jobs listed at times
    sampleLimit: 25,
    maxToleratedMissingDescriptions: 8,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('🏦 Running dedicated PostFinance jobs crawler...');
  console.log(`   Sitemap URL: ${SITEMAP_URL}`);
  console.log('');

  // 1. Fetch and parse job listings from sitemap
  const discoveredJobs = await fetchPostFinanceJobs();

  if (discoveredJobs.length === 0) {
    console.log('⚠️ No PostFinance CH-wide jobs discovered.');
    console.log('   The sitemap may have no PostFinance positions currently listed.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    logPostFinanceJobStats();
    return;
  }

  // 2. Update the adapter config
  updateAdapterConfig();

  // 3. Merge discovered jobs into data/jobs.json
  await mergePostFinanceJobs(discoveredJobs);

  // Snapshot for diff summary
  const _beforeSnapshot = snapshotJobSlugs(
    readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isPostFinanceJob),
  );

  // 4. Run base crawler for AI localization (IT/DE/FR/EN translations)
  console.log('\n🌐 Running base crawler for AI localization of PostFinance jobs...');
  await runBaseCrawler();

  // 5. Post-process: ensure consistency
  postProcessPostFinanceJobs();

  // 6. Log stats
  const stats = logPostFinanceJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No PostFinance jobs found. Exiting OK.');
    return;
  }

  // 7. Validate locale coverage
  validatePostFinanceLocaleCoverage();

  // 8. Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isPostFinanceJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: COMPANY_NAME,
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

// Only run the crawler pipeline when invoked directly from the CLI
// (not when imported by tests or other modules that want helper exports).
const _isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (_isMain) {
  main().catch((err) => exitCrawlerOnError(err, 'PostFinance'));
}
