#!/usr/bin/env node
/**
 * Dedicated PostFinance crawler runner.
 * Crawls jobs.postfinance.ch sitemap for Ticino/Grigioni positions.
 *
 * PostFinance is a subsidiary of Swiss Post. Both share the same
 * SuccessFactors NES job platform (job.post.ch). This crawler targets
 * PostFinance-specific positions via the branded careers portal.
 *
 * Discovery flow:
 *   1. Fetch sitemap from jobs.postfinance.ch/sitemap.xml
 *   2. Filter for /PostFinance/job/ URLs with Ticino city slugs
 *   3. Optionally scan PostCH corporate listing pages for /v2/ URLs
 *   4. Cross-reference: prefer /v2/ URL (has JSON-LD) when available
 *   5. Fetch detail pages, extract data from meta tags or JSON-LD
 *   6. Filter to Ticino/Grigioni region only
 *   7. Merge into dataset, run AI localization, validate locale coverage
 *   8. Write per-crawler slice and reassemble global dataset
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
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { parsePostJobDetail } from './lib/postch-job-parser.mjs';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'postfinance';
const COMPANY_NAME = 'PostFinance';
const COMPANY_HOST = 'jobs.postfinance.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];

const SITEMAP_URL = 'https://jobs.postfinance.ch/sitemap.xml';

// PostCH corporate listing pages — used to find supplementary /v2/ URLs
const POSTCH_LISTING_URLS = [
  'https://www.post.ch/en/jobs/jobs?jobsCategory=professionals&workload-maximum=1&workload-minimum=0',
];

// Ticino city keywords for pre-filtering sitemap URLs
const TICINO_CITY_KEYWORDS = [
  'bellinzona', 'lugano', 'locarno', 'mendrisio', 'chiasso', 'biasca',
  'manno', 'giubiasco', 'vezia', 'cadenazzo', 'bodio', 'airolo',
  'faido', 'castione', 'monte-carasso', 'camorino', 'sementina',
  'gordola', 'muralto', 'minusio', 'ascona', 'losone', 'magadino',
  'tenero', 'stabio', 'balerna', 'coldrerio', 'morbio', 'vacallo',
  'novazzano', 'brig', 'visp', 'naters', 'chur', 'davos', 'ilanz',
  'poschiavo', 'brusio', 'mesocco', 'grono', 'roveredo',
  'tessin', 'ticino', 'graubunden', 'grigioni',
];

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
  return s.slice(0, 200);
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
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
 * Filter sitemap URLs for PostFinance Ticino jobs.
 * PostFinance job URLs: https://job.post.ch/PostFinance/job/{slug}/{reqId}/
 */
function filterPostFinanceTicinoUrls(urls) {
  return urls.filter((url) => {
    // Must be a PostFinance-specific URL
    if (!url.includes('/PostFinance/job/')) return false;

    const lower = url.toLowerCase();
    // Check if URL slug contains a Ticino city keyword
    return TICINO_CITY_KEYWORDS.some((kw) => lower.includes(kw));
  });
}

/**
 * Extract the city name from a PostFinance job URL slug.
 * URL format: .../PostFinance/job/Bellinzona-Compliance-Officer-(wmd)/1378566933/
 * The first segment of the slug (before the first dash followed by a role keyword) is usually the city.
 */
function extractCityFromSlug(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    // Find the segment after 'job'
    const jobIdx = segments.indexOf('job');
    if (jobIdx < 0 || jobIdx + 1 >= segments.length) return '';
    const slug = segments[jobIdx + 1] || '';
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
  const re = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]+content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const match = html.match(re);
  if (match) return match[1].trim();
  const re2 = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+(?:name|property)\\s*=\\s*["']${name}["']`,
    'i',
  );
  const match2 = html.match(re2);
  return match2 ? match2[1].trim() : '';
}

function extractHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function extractCanonical(html) {
  const match = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']*)["']/i);
  if (match) return match[1].trim();
  const match2 = html.match(/<link[^>]+href\s*=\s*["']([^"']*)["'][^>]+rel\s*=\s*["']canonical["']/i);
  return match2 ? match2[1].trim() : '';
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

function isTicinoJob(city, location) {
  return (
    isTargetSwissLocation(city) ||
    isTargetSwissLocation(location)
  );
}

function detectCanton(city = '') {
  return inferAnyCanton(city) || 'TI';
}

function detectEmploymentType(detail) {
  const et = normalize(detail.employmentType || '');
  if (et.includes('part')) return 'PART_TIME';
  if (et.includes('intern')) return 'INTERN';
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

// ──────────────────────────────────────────────────────────────
// Main discovery flow
// ──────────────────────────────────────────────────────────────

async function fetchPostFinanceJobs() {
  console.log('🏦 Fetching PostFinance job listings from sitemap...');

  // Step 1: Fetch sitemap
  console.log(`  📄 Sitemap URL: ${SITEMAP_URL}`);
  const sitemapXml = await fetchPage(SITEMAP_URL, 20000);
  if (!sitemapXml) {
    console.warn('  ⚠️ Failed to fetch sitemap — aborting.');
    return [];
  }

  const allUrls = parseSitemapUrls(sitemapXml);
  console.log(`  📋 Total URLs in sitemap: ${allUrls.length}`);

  // Step 2: Filter for PostFinance Ticino jobs
  const ticinoUrls = filterPostFinanceTicinoUrls(allUrls);
  console.log(`  🎯 PostFinance Ticino URLs after pre-filter: ${ticinoUrls.length}`);

  if (ticinoUrls.length === 0) {
    console.log('  ℹ️ No Ticino PostFinance URLs found in sitemap. Checking all PostFinance URLs...');
    // Fallback: fetch all /PostFinance/job/ URLs and filter by detail page location
    const allPfUrls = allUrls.filter((u) => u.includes('/PostFinance/job/'));
    console.log(`  📋 All PostFinance job URLs: ${allPfUrls.length}`);
    if (allPfUrls.length === 0) return [];
    // Use allPfUrls but validate location on detail page fetch
    return fetchAndParseJobDetails(allPfUrls, true);
  }

  // Step 3: Scan PostCH listings for supplementary /v2/ URLs
  const v2Map = await scanPostChListingsForV2Urls();

  // Step 4: Fetch detail pages
  return fetchAndParseJobDetails(ticinoUrls, false, v2Map);
}

async function fetchAndParseJobDetails(urls, validateLocation = false, v2Map = new Map()) {
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

    // Determine city
    const city = detail.city || cityFromSlug || 'Bellinzona';

    // Validate location if we didn't pre-filter
    if (validateLocation && !isTicinoJob(city, detail.location || detail.region || '')) {
      console.log(`     ↳ Skipping (not Ticino): ${detail.title} — ${city}`);
      continue;
    }

    const title = detail.title;
    const canton = detectCanton(city);
    const slug = slugify(title, 'postfinance');

    const descriptionIt = detail.description && detail.description.length > 30
      ? detail.description
      : `Posizione aperta presso ${COMPANY_NAME} a ${city}. Ruolo: ${title}. PostFinance è una sussidiaria della Posta Svizzera.`;

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

  console.log(`\n📋 Total PostFinance Ticino jobs discovered: ${jobs.length}`);
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

async function mergePostFinanceJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonPfJobs = allJobs.filter((j) => !isPostFinanceJob(j));
  const existingPfJobs = allJobs.filter(isPostFinanceJob);

  // Build lookup by normalized URL
  const existingByUrl = new Map();
  for (const job of existingPfJobs) {
    existingByUrl.set(normalizeUrl(job.url), job);
    if (job.applyUrl) existingByUrl.set(normalizeUrl(job.applyUrl), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];
  const discoveredUrlSet = new Set();

  for (const discovered of discoveredJobs) {
    const normUrl = normalizeUrl(discovered.url);
    const normApplyUrl = normalizeUrl(discovered.applyUrl);
    discoveredUrlSet.add(normUrl);
    discoveredUrlSet.add(normApplyUrl);

    const existingJob = existingByUrl.get(normUrl) || existingByUrl.get(normApplyUrl);

    if (existingJob) {
      const updatedJob = {
        ...existingJob,
        title: discovered.title || existingJob.title,
        description: discovered.description || existingJob.description,
        company: COMPANY_NAME,
        companyKey: COMPANY_KEY,
        location: discovered.location || existingJob.location,
        canton: discovered.canton || existingJob.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existingJob.applyUrl,
        url: discovered.url || existingJob.url,
        department: discovered.department || existingJob.department,
        category: discovered.category || existingJob.category,
        sector: discovered.sector || existingJob.sector,
        source: 'postfinance-careers-crawler',
        workload: discovered.workload || existingJob.workload,
        titleByLocale: mergeLocaleTextMap(existingJob.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existingJob.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existingJob.slugByLocale, discovered.slugByLocale, 3),
      };
      // Preserve needsRetranslation only if still needed
      if (discovered.needsRetranslation && !existingJob.descriptionByLocale?.en) {
        updatedJob.needsRetranslation = true;
      }
      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  // Count removed (existing PF jobs not in discovery)
  for (const job of existingPfJobs) {
    const normUrl = normalizeUrl(job.url);
    const normApplyUrl = normalizeUrl(job.applyUrl);
    if (!discoveredUrlSet.has(normUrl) && !discoveredUrlSet.has(normApplyUrl)) {
      removed++;
    }
  }

  const final = [...nonPfJobs, ...merged];

  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');

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
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
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
    if (!job.location) {
      job.location = 'Bellinzona';
      fixed++;
    }
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
      job.canton = detectCanton(job.location);
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
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
    failWhenNoJobs: false, // PostFinance may have 0 Ticino jobs at times
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
    console.log('⚠️ No PostFinance Ticino jobs discovered.');
    console.log('   The sitemap may have no Ticino positions currently listed.');
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
  main().catch((err) => {
    console.error(`❌ PostFinance crawler failed: ${err?.message || err}`);
    process.exit(1);
  });
}
