#!/usr/bin/env node
/**
 * Dedicated Medacta International SA crawler runner.
 * Runs only Medacta jobs from their Allibo ATS-powered careers portal
 * and enforces full locale coverage for SEO-critical fields.
 *
 * The Medacta careers portal uses Allibo ATS (joblink.allibo.com)
 * widgets embedded in category pages on medacta.com.
 *
 * We avoid persisting third-party widget connector URLs in git.
 * Instead we:
 *   1. Crawl the 14 career-category pages on medacta.com
 *   2. Parse the server-rendered HTML for public job links
 *   3. Keep only first-party category URLs in the adapter JSON
 *   4. Invoke the base crawler for full detail scraping + AI localisation
 *   5. Post-process: fix company name, location, canton, clean descriptions
 *   6. Validate locale coverage across IT/EN/DE/FR
 *
 * Medacta International SA is a global orthopaedic company headquartered in
 * Castel San Pietro, Canton Ticino, Switzerland.  Listed on SIX Swiss Exchange.
 * ~2 200 employees globally, ~800 in Ticino.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang } from './lib/dedicated-crawler-common.mjs';
import {
  decodeHtmlEntities,
  inferMedactaCategory,
  inferMedactaContract,
  buildMedactaBaseDescription,
  buildMedactaLocalizedDescriptions,
} from './lib/medacta-job-enrichment.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const MEDACTA_KEY = 'medacta-international';
const HQ = getCompanyDefaults('medacta');
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Career category pages on medacta.com.
 * Each page embeds an Allibo search-engine widget that loads job listings.
 */
const CAREER_CATEGORIES = [
  'production',
  'engineering',
  'mkt-communication',
  'event-travel',
  'finance',
  'it',
  'r-d',
  'operations',
  'quality-assurance',
  'regulatory',
  'medical-affairs',
  'general-services',
  'hr',
  'sales',
];

const MEDACTA_COMPANY_NAME = 'Medacta International SA';
const MEDACTA_COMPANY_HOST = 'medacta.com';

const MEDACTA_LOCALES_MAP = {
  it: 'IT',
  en: 'EN',
  de: 'DE',
  fr: 'FR',
};

/**
 * Map of department/category names to human-readable labels.
 */
const CATEGORY_LABELS = {
  production: 'Production',
  engineering: 'Engineering',
  'mkt-communication': 'Marketing & Communications',
  'event-travel': 'Events & Travel',
  finance: 'Finance',
  it: 'Information Technology',
  'r-d': 'Research & Development',
  operations: 'Operations & Supply Chain',
  'quality-assurance': 'Quality Assurance',
  regulatory: 'Regulatory Affairs',
  'medical-affairs': 'Medical Affairs',
  'general-services': 'General Services',
  hr: 'Human Resources',
  sales: 'Sales',
};
const RD_MARKER_RE = /(?:\br\s*&\s*d\b|research\s*(?:&|and)\s*development)/i;

const DEFAULT_CITY = 'Castel San Pietro';
const DEFAULT_CANTON = HQ.canton;

/**
 * Swiss cities and their canton codes for location detection.
 */
const SWISS_CITY_CANTON = {
  'castel san pietro': 'TI',
  lugano: 'TI',
  mendrisio: 'TI',
  chiasso: 'TI',
  bellinzona: 'TI',
  locarno: 'TI',
  zurich: 'ZH',
  zürich: 'ZH',
  bern: 'BE',
  basel: 'BS',
  geneve: 'GE',
  geneva: 'GE',
  lausanne: 'VD',
};

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


/**
 * Normalize Medacta source category from Allibo.
 * If title/job hints contain "R&D", force category key/label to R&D
 * even when the widget returns the job in IT buckets.
 */
function normalizeMedactaSourceCategory({ category = '', categoryLabel = '', title = '', jobCategory = '' } = {}) {
  let key = normalizeKey(category || '');
  let label = decodeHtmlEntities(String(categoryLabel || CATEGORY_LABELS[key] || '')).trim();
  const hint = decodeHtmlEntities(`${title} ${jobCategory} ${label}`).trim();

  if (RD_MARKER_RE.test(hint)) {
    key = 'r-d';
    label = CATEGORY_LABELS['r-d'];
  }

  if (!label && CATEGORY_LABELS[key]) label = CATEGORY_LABELS[key];
  if (!key && label) key = normalizeKey(label).replace(/_/g, '-');

  return {
    categoryKey: key,
    categoryLabel: label || 'Operations',
  };
}

/**
 * Match a job object as belonging to the Medacta crawl.
 */
function isMedactaJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === MEDACTA_KEY ||
    key.includes('medacta') ||
    host.includes('medacta.com') ||
    (host.includes('allibo.com') && /[?&]DM=1818\b/i.test(url)) ||
    (company.includes('medacta') && !company.includes('mediacom'))
  );
}

/**
 * Check whether a URL belongs to Medacta's trusted domains.
 */
function isTrustedMedactaDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.includes('medacta.com') || (host.includes('allibo.com') && /[?&]DM=1818\b/i.test(rawUrl));
  } catch {
    return false;
  }
}

function deriveLocalizedSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  return String(job?.slug || '').trim();
}

function normalizeMedactaUrlForDedup(rawUrl = '') {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    const params = url.searchParams;

    // Allibo detail links often vary by tracking params but share stable IDs.
    // URLSearchParams is case-sensitive; Allibo uses uppercase param names (ID, DM, etc.)
    if (host.includes('allibo.com')) {
      const lowerParams = new Map(
        [...params.entries()].map(([k, v]) => [k.toLowerCase(), v])
      );
      const id =
        lowerParams.get('id') ||
        lowerParams.get('jobid') ||
        lowerParams.get('adid') ||
        lowerParams.get('ad_id') ||
        '';
      if (id) return `${host}${path}?id=${String(id).trim().toLowerCase()}`;
      return `${host}${path}`;
    }

    // Keep stable routing bits only.
    const stable = new URLSearchParams();
    for (const [k, v] of params.entries()) {
      const key = String(k || '').toLowerCase();
      if (key.startsWith('utm_')) continue;
      if (key === 'gclid' || key === 'fbclid' || key === 'mc_cid' || key === 'mc_eid') continue;
      if (!String(v || '').trim()) continue;
      stable.set(key, String(v).trim().toLowerCase());
    }
    const query = [...stable.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return query ? `${host}${path}?${query}` : `${host}${path}`;
  } catch {
    return normalizeKey(trimmed);
  }
}

function medactaDedupKey(job) {
  const urlKey = normalizeMedactaUrlForDedup(job?.url || '');
  if (urlKey) return `url:${urlKey}`;
  const fallback = normalizeKey(`${job?.title || ''}|${job?.location || ''}|${job?.department || ''}`);
  return fallback ? `fallback:${fallback}` : `id:${normalizeKey(job?.id || '')}`;
}

function medactaJobQualityScore(job) {
  const desc = String(job?.description || '').trim();
  const byLocale = job?.descriptionByLocale || {};
  const localeCoverage = LOCALES.reduce((acc, locale) => {
    const txt = String(byLocale?.[locale] || '').trim();
    return acc + (txt.length >= 120 ? 1 : 0);
  }, 0);
  const trusted = isTrustedMedactaDomain(job?.url || '') ? 800 : 0;
  const locationScore = String(job?.location || '').trim() ? 120 : 0;
  const cantonScore = String(job?.canton || '').trim() ? 80 : 0;
  const featuredScore = job?.featured ? 40 : 0;
  return Math.min(6000, desc.length) + localeCoverage * 900 + trusted + locationScore + cantonScore + featuredScore;
}

function dedupeMedactaJobsForPersistence(jobs = []) {
  if (!Array.isArray(jobs) || jobs.length === 0) return { jobs: [], removed: 0 };
  const bestByKey = new Map();
  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    if (!isMedactaJob(job)) continue;
    const key = medactaDedupKey(job);
    if (!key || key === 'id:') continue;
    const score = medactaJobQualityScore(job);
    const prev = bestByKey.get(key);
    if (!prev || score > prev.score) {
      bestByKey.set(key, { idx, score });
    }
  }

  if (bestByKey.size === 0) return { jobs, removed: 0 };

  const deduped = [];
  let removed = 0;
  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    if (!isMedactaJob(job)) {
      deduped.push(job);
      continue;
    }
    const key = medactaDedupKey(job);
    const best = bestByKey.get(key);
    if (best && best.idx === idx) {
      deduped.push(job);
    } else {
      removed += 1;
    }
  }

  return { jobs: deduped, removed };
}

/**
 * Determine canton code from a city name or location string.
 */
function detectCanton(location = '') {
  const loc = normalize(location);
  for (const [city, canton] of Object.entries(SWISS_CITY_CANTON)) {
    if (loc.includes(city)) return canton;
  }
  return '';
}

// ──────────────────────────────────────────────────────────────
// Page fetching
// ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL with timeout and User-Agent header.
 * Returns response body as text, or null on failure.
 */
async function fetchPage(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json',
        'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
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

/**
 * Fetch a job description from an Allibo detail page.
 * The detail pages are CAPTCHA-protected, so full descriptions are NOT
 * available via server-side fetch. We extract whatever meta description
 * is available from the static HTML (og:description or meta description).
 */
async function fetchJobDescription(detailUrl) {
  if (!detailUrl) return '';
  const html = await fetchPage(detailUrl, 12000);
  if (!html) return '';

  // If CAPTCHA page, extract from meta tags (still available)
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  if (ogMatch) return decodeHtmlEntities(ogMatch[1]).trim();

  // Allibo typo: 'descritpion' (their actual attribute name)
  const metaMatch = html.match(/<meta\s+name=['"]descritpion['"]\s+content="([^"]+)"/i);
  if (metaMatch) return decodeHtmlEntities(metaMatch[1]).trim();

  // Standard meta description
  const stdMatch = html.match(/<meta\s+name=['"]description['"]\s+content="([^"]+)"/i);
  if (stdMatch) return decodeHtmlEntities(stdMatch[1]).trim();

  return '';
}

/**
 * Inject Medacta jobs directly into data/jobs.json (EFG-style injection).
 * Creates job objects from Allibo API data and writes them.
 * Returns count of injected jobs.
 */
async function injectMedactaJobs(alliboJobs) {
  if (alliboJobs.length === 0) return 0;

  // Read existing jobs
  let jobs = [];
  if (fs.existsSync(DATA_JOBS)) {
    try { jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')); } catch { jobs = []; }
  }
  if (!Array.isArray(jobs)) jobs = [];

  // Index existing jobs by URL for dedup
  const urlIndex = new Map();
  for (let i = 0; i < jobs.length; i++) {
    const u = String(jobs[i]?.url || '').toLowerCase();
    if (u) urlIndex.set(u, i);
  }

  // Also index by a normalized title+company key for additional dedup
  const titleIndex = new Map();
  for (let i = 0; i < jobs.length; i++) {
    if (!isMedactaJob(jobs[i])) continue;
    const key = normalizeKey(`${jobs[i]?.title || ''}-medacta`);
    titleIndex.set(key, i);
  }

  console.log(`\n📥 Injecting ${alliboJobs.length} Medacta jobs into jobs.json...`);
  let injected = 0;
  let updated = 0;
  const batchSize = 3;

  for (let i = 0; i < alliboJobs.length; i++) {
    const aj = alliboJobs[i];
    const url = aj.detailLink || `https://www.medacta.com/EN/career?category=${aj.category}`;
    const slug = `${aj.title}-medacta-${aj.location}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200);

    // Fetch meta description from detail page (with rate limiting).
    // Full detail body is CAPTCHA-protected on Allibo; enrich deterministically.
    let metaDescription = '';
    if (aj.detailLink) {
      if (i > 0 && i % batchSize === 0) {
        await new Promise((r) => setTimeout(r, 800));
      }
      metaDescription = await fetchJobDescription(aj.detailLink);
    }

    const normalizedSource = normalizeMedactaSourceCategory({
      category: aj.category,
      categoryLabel: aj.categoryLabel,
      title: aj.title,
      jobCategory: aj.jobCategory,
    });
    const canonicalCategory = inferMedactaCategory({
      category: normalizedSource.categoryKey,
      categoryLabel: normalizedSource.categoryLabel,
      title: aj.title,
      jobCategory: aj.jobCategory,
    });
    const canonicalContract = inferMedactaContract({
      rawContract: aj.contract || '',
      title: aj.title,
      description: metaDescription,
      jobCategory: aj.jobCategory,
    });
    const departmentLabel = decodeHtmlEntities(
      String(normalizedSource.categoryLabel || aj.jobCategory || aj.category || 'Operations')
    ).trim();
    const localizedDescriptions = buildMedactaLocalizedDescriptions({
      title: aj.title,
      location: aj.location || DEFAULT_CITY,
      category: canonicalCategory,
      categoryLabel: aj.categoryLabel,
      departmentLabel,
      isUrgent: aj.isUrgent,
      metaDescription,
    });
    const description = localizedDescriptions.it || buildMedactaBaseDescription({
      title: aj.title,
      location: aj.location || DEFAULT_CITY,
      category: canonicalCategory,
      categoryLabel: aj.categoryLabel,
      departmentLabel,
      isUrgent: aj.isUrgent,
      metaDescription,
    });
    const titleByLocale = { en: aj.title };

    const jobEntry = {
      id: `medacta-${aj.alliboId || normalizeKey(aj.title)}`,
      slug,
      company: MEDACTA_COMPANY_NAME,
      companyKey: MEDACTA_KEY,
      title: aj.title,
      location: aj.location || DEFAULT_CITY,
      canton: aj.canton || DEFAULT_CANTON,
      country: aj.country || 'CH',
      category: canonicalCategory,
      department: departmentLabel,
      contract: canonicalContract,
      currency: 'CHF',
      description,
      requirements: [],
      featured: aj.isUrgent || false,
      postedDate: new Date().toISOString().split('T')[0],
      url,
      source: 'Allibo ATS API + structured enrichment',
      companyDomain: MEDACTA_COMPANY_HOST,
      sector: 'Dispositivi medici',
      titleByLocale,
      descriptionByLocale: localizedDescriptions,
      requirementsByLocale: {},
      crawledAt: new Date().toISOString(),
      slugByLocale: {},
      sourceLang: detectLang(description || aj.title, 'en'),
      addressLocality: aj.location || DEFAULT_CITY,
      addressCountry: aj.country || 'CH',
    };

    // Check for existing job by URL
    const existingIdx = urlIndex.get(url.toLowerCase());
    const titleKey = normalizeKey(`${aj.title}-medacta`);
    const titleIdx = titleIndex.get(titleKey);

    if (existingIdx !== undefined) {
      // Update existing job
      const existing = jobs[existingIdx];
      existing.title = aj.title;
      existing.location = aj.location || existing.location;
      existing.canton = aj.canton || existing.canton;
      existing.category = canonicalCategory;
      existing.department = departmentLabel || existing.department;
      existing.contract = canonicalContract;
      existing.companyDomain = MEDACTA_COMPANY_HOST;
      existing.featured = aj.isUrgent || existing.featured;
      existing.crawledAt = new Date().toISOString();
      if (description && description.length > 120) existing.description = description;
      existing.titleByLocale = { ...(existing.titleByLocale || {}), ...titleByLocale };
      existing.descriptionByLocale = { ...(existing.descriptionByLocale || {}), ...localizedDescriptions };
      updated++;
    } else if (titleIdx !== undefined) {
      // Update existing job found by title
      const existing = jobs[titleIdx];
      existing.url = url;
      existing.title = aj.title;
      existing.location = aj.location || existing.location;
      existing.canton = aj.canton || existing.canton;
      existing.category = canonicalCategory;
      existing.department = departmentLabel || existing.department;
      existing.contract = canonicalContract;
      existing.companyDomain = MEDACTA_COMPANY_HOST;
      existing.featured = aj.isUrgent || existing.featured;
      existing.crawledAt = new Date().toISOString();
      if (description && description.length > 120) existing.description = description;
      existing.titleByLocale = { ...(existing.titleByLocale || {}), ...titleByLocale };
      existing.descriptionByLocale = { ...(existing.descriptionByLocale || {}), ...localizedDescriptions };
      updated++;
    } else {
      // New job — append
      jobs.push(jobEntry);
      urlIndex.set(url.toLowerCase(), jobs.length - 1);
      titleIndex.set(titleKey, jobs.length - 1);
      injected++;
    }

    console.log(`  ${existingIdx !== undefined || titleIdx !== undefined ? '🔄' : '✅'} ${aj.title} (${aj.location || DEFAULT_CITY})`);
  }

  const dedupedState = dedupeMedactaJobsForPersistence(jobs);
  jobs = dedupedState.jobs;

  // Write back
  fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');

  console.log(`\n📊 Injection summary: ${injected} new, ${updated} updated`);
  if (dedupedState.removed > 0) {
    console.log(`🧯 Medacta hard-dedup removed ${dedupedState.removed} duplicate rows.`);
  }
  return injected + updated;
}

// ──────────────────────────────────────────────────────────────
// Job discovery — category page crawling
// ──────────────────────────────────────────────────────────────

/**
 * Build the category page URL for a given locale and category slug.
 */
function categoryPageUrl(lang = 'EN', category = '') {
  return `https://www.medacta.com/${lang}/career?category=${category}`;
}

/**
 * Extract all job-related links from a Medacta category page HTML.
 * Looks for:
 *   - Allibo application links: joblink.allibo.com/ats3/...
 *   - Medacta career detail links (if any server-rendered)
 *   - PDF/document links related to job descriptions
 */
function extractJobLinks(html = '', pageUrl = '') {
  const links = new Set();

  // Allibo application links (URL-encoded in data attributes or href)
  const alliboRe = /https?:\/\/joblink\.allibo\.com\/ats3\/job-offer\.aspx[^"'\s<>]+/gi;
  let match;
  while ((match = alliboRe.exec(html)) !== null) {
    const url = match[0]
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, '')
      .trim();
    if (url.length > 30) links.add(url);
  }

  // Medacta career detail links
  const medactaJobRe = /href="(\/[A-Z]{2}\/career\/[^"]+)"/gi;
  while ((match = medactaJobRe.exec(html)) !== null) {
    try {
      const full = new URL(match[1], 'https://www.medacta.com').href;
      links.add(full);
    } catch { /* skip invalid URLs */ }
  }

  // Additional Medacta internal links with "career" or "job" in path
  const internalRe = /href="(https?:\/\/(?:www\.)?medacta\.com\/[^"]*(?:career|job|position|openings)[^"]*)"/gi;
  while ((match = internalRe.exec(html)) !== null) {
    const url = match[1].replace(/&amp;/g, '&').trim();
    // Skip the main careers listing page and category pages themselves
    if (url.includes('?category=')) continue;
    if (/\/careers?\s*$/i.test(url)) continue;
    links.add(url);
  }

  return [...links];
}

/**
 * Extract job postings from Allibo widget JSON data embedded in the page.
 * Allibo widgets may render job data in JavaScript variables or data attributes.
 */
function extractAlliboEmbeddedData(html = '') {
  const jobs = [];

  // Look for aw_dataArray JSON embedded in script tags
  const dataMatch = html.match(/aw_dataArray\[[^\]]+\]\s*=\s*(\{[\s\S]*?\});/);
  if (dataMatch) {
    try {
      const data = JSON.parse(dataMatch[1]);
      const adsList = data?.WidgetData?.AdsList || data?.Content?.WidgetData?.AdsList || [];
      for (const ad of adsList) {
        if (ad?.Title) {
          jobs.push({
            title: ad.Title,
            location: ad.Location || ad.WorkPlace || '',
            description: ad.Description || ad.Excerpt || '',
            url: ad.Url || ad.ApplyUrl || '',
            department: ad.Department || ad.Category || '',
          });
        }
      }
    } catch { /* JSON parse failed, skip */ }
  }

  // Look for job postings in JSON-LD
  const jsonLdRe = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRe.exec(html)) !== null) {
    try {
      const ld = JSON.parse(match[1]);
      if (ld['@type'] === 'JobPosting') {
        jobs.push({
          title: ld.title || '',
          location: ld.jobLocation?.address?.addressLocality || '',
          description: ld.description || '',
          url: ld.url || '',
          department: ld.occupationalCategory || '',
          datePosted: ld.datePosted || '',
        });
      }
    } catch { /* skip invalid JSON-LD */ }
  }

  return jobs;
}

/**
 * Discover all job URLs and embedded job data from Medacta category pages.
 * Crawls each of the 14 category pages in the EN locale.
 */
async function discoverMedactaJobs() {
  console.log('🔍 Discovering Medacta jobs from career category pages...\n');
  const allLinks = new Set();
  const embeddedJobs = [];
  let pagesOk = 0;
  let pagesFailed = 0;

  for (const category of CAREER_CATEGORIES) {
    const url = categoryPageUrl('EN', category);
    console.log(`  📄 ${CATEGORY_LABELS[category] || category}: ${url}`);

    const html = await fetchPage(url, 20000);
    if (!html) {
      console.warn(`     ⚠️ Failed to fetch`);
      pagesFailed++;
      continue;
    }

    pagesOk++;

    // Extract links
    const links = extractJobLinks(html, url);
    for (const link of links) allLinks.add(link);

    // Extract embedded job data
    const embedded = extractAlliboEmbeddedData(html);
    for (const job of embedded) {
      job.category = category;
      embeddedJobs.push(job);
    }

    console.log(`     ✅ ${links.length} links, ${embedded.length} embedded jobs`);

    // Polite delay
    await new Promise((r) => setTimeout(r, 500));
  }

  // Also try the main careers page
  const mainUrl = 'https://www.medacta.com/EN/careers';
  console.log(`\n  📄 Main careers page: ${mainUrl}`);
  const mainHtml = await fetchPage(mainUrl, 20000);
  if (mainHtml) {
    const mainLinks = extractJobLinks(mainHtml, mainUrl);
    for (const link of mainLinks) allLinks.add(link);
    const mainEmbedded = extractAlliboEmbeddedData(mainHtml);
    for (const job of mainEmbedded) embeddedJobs.push(job);
    console.log(`     ✅ ${mainLinks.length} links, ${mainEmbedded.length} embedded jobs`);
    pagesOk++;
  }

  // Also try the Italian careers page
  const itUrl = 'https://www.medacta.com/IT/careers';
  console.log(`  📄 Italian careers page: ${itUrl}`);
  const itHtml = await fetchPage(itUrl, 20000);
  if (itHtml) {
    const itLinks = extractJobLinks(itHtml, itUrl);
    for (const link of itLinks) allLinks.add(link);
    console.log(`     ✅ ${itLinks.length} links`);
    pagesOk++;
  }

  console.log(`\n📋 Discovery summary:`);
  console.log(`  📄 Pages crawled: ${pagesOk} OK, ${pagesFailed} failed`);
  console.log(`  🔗 Unique links found: ${allLinks.size}`);
  console.log(`  📊 Embedded jobs found: ${embeddedJobs.length}`);

  return { links: [...allLinks], embeddedJobs };
}

// ──────────────────────────────────────────────────────────────
// Adapter seed URL management
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the Medacta adapter JSON has the correct first-party seed URLs.
 */
function ensureAdapterSeedUrls() {
  const adapterPath = path.join(ADAPTERS_DIR, `${MEDACTA_KEY}.json`);

  // Build seed URLs from first-party category pages only.
  const seedUrls = [];

  // Add category pages as primary seeds
  for (const category of CAREER_CATEGORIES) {
    seedUrls.push(categoryPageUrl('EN', category));
  }

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = MEDACTA_KEY;
  adapter.companyName = MEDACTA_COMPANY_NAME;
  adapter.companyHost = MEDACTA_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['generic_ats', 'html', 'jsonld'];
  adapter.seedUrls = seedUrls;
  adapter.notes = 'Medacta International career portal seeded only from medacta.com category pages to avoid persisting third-party access URLs.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${MEDACTA_KEY} updated with ${seedUrls.length} first-party seed URLs.`);
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MEDACTA_KEY,
    localizeOnlyCompanyKeys: MEDACTA_KEY,
    forceLocalizeKeys: MEDACTA_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      // Medacta has ~50-100 positions across categories
      JOBS_CRAWLER_MAX_JOB_LINKS: '400',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '400',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing
// ──────────────────────────────────────────────────────────────

/**
 * Medacta standard boilerplate patterns to clean from descriptions.
 */
const MEDACTA_BOILERPLATE_RE = /Medacta International is a (?:leading )?global (?:orthopaedic|medical devices?) company[\s\S]*?(?=(?:The Role|Your Role|The Position|About the Role|Key Responsibilities|Main Responsibilities|What you will do|Your Profile|Responsibilities|Description|Purpose|Job Purpose|The Opportunity|About|We are looking|In this role|As a|Join|Reporting|Your tasks|Your Activities|Requirements|Qualifications|What we offer))/i;

/**
 * Clean a Medacta job description.
 */
function cleanMedactaDescription(desc = '') {
  let cleaned = desc;

  // Remove company boilerplate intro
  cleaned = cleaned.replace(MEDACTA_BOILERPLATE_RE, '');

  // Remove CTA/application footer
  cleaned = cleaned.replace(/(?:Apply now|Jetzt bewerben|Candidati ora|Postuler maintenant)[\s\S]*/i, '');
  cleaned = cleaned.replace(/Medacta is an equal opportunity employer[\s\S]*/i, '');
  cleaned = cleaned.replace(/We offer a dynamic and international working[\s\S]*/i, '');
  cleaned = cleaned.replace(/If you are interested[\s\S]*/i, '');
  cleaned = cleaned.replace(/Please send your application[\s\S]*/i, '');
  cleaned = cleaned.replace(/Invia la tua candidatura[\s\S]*/i, '');

  return cleaned.replace(/^\s+/, '').replace(/\s+$/, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Post-process all Medacta jobs in data/jobs.json.
 * Fix company name, location, canton, description.
 */
function postProcessMedactaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isMedactaJob(job)) continue;

    // Fix company name
    if (job.company !== MEDACTA_COMPANY_NAME) {
      job.company = MEDACTA_COMPANY_NAME;
      fixed++;
    }

    // Fix companyKey
    if (job.companyKey !== MEDACTA_KEY) {
      job.companyKey = MEDACTA_KEY;
      fixed++;
    }

    // Default location to Castel San Pietro (Medacta HQ)
    if (!job.location || normalize(job.location).length < 3) {
      job.location = DEFAULT_CITY;
      fixed++;
    }

    // Detect and set canton code
    const canton = detectCanton(job.location || '');
    if (canton) {
      job.canton = canton;
    } else {
      // Default to TI for Medacta (HQ in Castel San Pietro)
      job.canton = DEFAULT_CANTON;
    }

    // Set country
    job.country = 'CH';

    // Set sector
    if (!job.sector) {
      job.sector = 'Dispositivi medici';
    }

    // Fix title HTML entities (e.g. R&amp;D)
    const decodedTitle = decodeHtmlEntities(String(job.title || '')).trim();
    if (decodedTitle && decodedTitle !== job.title) {
      job.title = decodedTitle;
      fixed++;
    }

    // Canonical category + contract for JobBoard translations
    const normalizedSource = normalizeMedactaSourceCategory({
      category: job.category,
      categoryLabel: job.department,
      title: job.title,
      jobCategory: job.department,
    });
    const canonicalCategory = inferMedactaCategory({
      category: normalizedSource.categoryKey,
      categoryLabel: normalizedSource.categoryLabel,
      title: job.title,
      jobCategory: job.department,
    });
    if (job.category !== canonicalCategory) {
      job.category = canonicalCategory;
      fixed++;
    }
    const canonicalContract = inferMedactaContract({
      rawContract: job.contract,
      title: job.title,
      description: job.description,
      jobCategory: job.department,
    });
    if (job.contract !== canonicalContract) {
      job.contract = canonicalContract;
      fixed++;
    }

    // Ensure company website for high-quality branding assets.
    if (job.companyDomain !== MEDACTA_COMPANY_HOST) {
      job.companyDomain = MEDACTA_COMPANY_HOST;
      fixed++;
    }

    // Ensure department label is human-readable.
    const departmentLabel = decodeHtmlEntities(
      String(normalizedSource.categoryLabel || job.department || job.category || 'Operations')
    ).trim();
    if (departmentLabel && job.department !== departmentLabel) {
      job.department = departmentLabel;
      fixed++;
    }

    // Build rich structured descriptions if source text is missing/too short.
    const localizedDescriptions = buildMedactaLocalizedDescriptions({
      title: job.title,
      location: job.location || DEFAULT_CITY,
      category: canonicalCategory,
      categoryLabel: departmentLabel,
      departmentLabel,
      isUrgent: Boolean(job.featured),
      metaDescription: job.description || '',
    });

    const cleanedDesc = cleanMedactaDescription(job.description || '');
    const shouldReplaceBaseDescription =
      !cleanedDesc ||
      cleanedDesc.length < 220 ||
      !/^## /m.test(cleanedDesc);

    if (shouldReplaceBaseDescription) {
      job.description = localizedDescriptions.it;
      fixed++;
    } else {
      job.description = cleanedDesc;
    }

    // Ensure locale coverage with rich markdown sections.
    const currentDescByLocale = (job.descriptionByLocale && typeof job.descriptionByLocale === 'object')
      ? { ...job.descriptionByLocale }
      : {};
    for (const locale of LOCALES) {
      const cleaned = cleanMedactaDescription(String(currentDescByLocale[locale] || ''));
      if (!cleaned || cleaned.length < 220 || !/^## /m.test(cleaned)) {
        currentDescByLocale[locale] = localizedDescriptions[locale];
        fixed++;
      } else {
        currentDescByLocale[locale] = cleaned;
      }
    }
    job.descriptionByLocale = currentDescByLocale;

    // Ensure locale titles exist (non-empty for strict validation).
    const currentTitles = (job.titleByLocale && typeof job.titleByLocale === 'object')
      ? { ...job.titleByLocale }
      : {};
    for (const locale of LOCALES) {
      if (!String(currentTitles[locale] || '').trim()) {
        currentTitles[locale] = job.title;
        fixed++;
      }
    }
    job.titleByLocale = currentTitles;

    // Regenerate slug if too long or contains boilerplate
    if (job.slug && (job.slug.includes('medacta-international-is') || job.slug.includes('orthopaedic-company') || job.slug.length > 120)) {
      const slugBase = `${job.title || ''}-medacta`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 200);
      job.slug = slugBase;
      fixed++;
    }
  }

  const dedupedState = dedupeMedactaJobsForPersistence(jobs);
  const finalJobs = dedupedState.jobs;

  if (fixed > 0 || dedupedState.removed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(finalJobs, null, 2) + '\n');
    fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(finalJobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Medacta jobs (fixed company/location/canton/description).`);
    if (dedupedState.removed > 0) {
      console.log(`🧯 Medacta hard-dedup removed ${dedupedState.removed} duplicate rows during post-process.`);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logMedactaJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const medactaJobs = allJobs.filter(isMedactaJob);
  const ticinoJobs = medactaJobs.filter((j) => normalize(j?.canton) === 'ti');

  // Department breakdown
  const departments = {};
  for (const job of medactaJobs) {
    const dept = job.department || job.category || 'unknown';
    departments[dept] = (departments[dept] || 0) + 1;
  }

  console.log(`\n📊 === Medacta International SA Job Stats ===`);
  console.log(`  🏥 Job totali trovati (Medacta): ${medactaJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  if (medactaJobs.length > ticinoJobs.length) {
    console.log(`  📍 Job sedi extra-Ticino: ${medactaJobs.length - ticinoJobs.length}`);
  }

  if (Object.keys(departments).length > 0) {
    console.log(`  📋 Per dipartimento:`);
    for (const [dept, count] of Object.entries(departments).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${dept}: ${count}`);
    }
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(medactaJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Medacta');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Medacta');

  return { total: medactaJobs.length, ticino: ticinoJobs.length, crawlDiff };
}

function validateMedactaLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MEDACTA_STRICT',
    label: 'Medacta',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isMedactaJob,
    detectSourceLang: (text) => detectLang(text),
    deriveSlug: deriveLocalizedSlug,
    minDescriptionChars: 100,
    maxToleratedMissingDescriptions: 5,
    noJobsMessage: 'Nessun job Medacta trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(MEDACTA_KEY, 'Medacta');
  console.log('🏥 Running dedicated Medacta International SA jobs crawler...');
  console.log(`   Website: https://www.medacta.com`);
  console.log(`   ATS: Allibo (joblink.allibo.com)`);
  console.log(`   Categories: ${CAREER_CATEGORIES.length}\n`);

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(MEDACTA_KEY, DATA_JOBS).filter(isMedactaJob))

  // 1. Discover public job links without persisting third-party access URLs.
  const discovery = await discoverMedactaJobs();
  if (discovery.links.length > 0) {
    console.log(`\nℹ️ Runtime discovery found ${discovery.links.length} public job links; they will not be stored in git.`);
  }
  ensureAdapterSeedUrls();

  // 2. Run the base crawler against first-party category pages.
  await runBaseCrawler();

  // 3. Post-process: fix company name, location, canton, description
  postProcessMedactaJobs();

  // 4. Strict locale validation (IT/EN/DE/FR)
  validateMedactaLocaleCoverage();

  // 5. Log stats
  const stats = logMedactaJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Medacta trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  // 6. Print published URLs
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const endJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      const medJobs = Array.isArray(endJobs) ? endJobs.filter(isMedactaJob) : [];
      printPublishedJobUrls(medJobs, MEDACTA_KEY);
      writeJobsSummary(medJobs, MEDACTA_KEY);
    } catch {}
  }

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isMedactaJob) : [];
  writeJobsCrawlerSlice(MEDACTA_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MEDACTA_KEY,
    label: 'Medacta',
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

main().catch((err) => {
  console.error(`❌ Medacta crawler failed: ${err?.message || err}`);
  process.exit(1);
});
