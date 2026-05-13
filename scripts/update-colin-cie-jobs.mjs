#!/usr/bin/env node
/**
 * Dedicated Colin&Cie Wealth Management crawler runner.
 *
 * Colin&Cie is a leading independent wealth management firm with offices
 * in Switzerland (Lugano, Zürich, Schaffhausen, Basel, Bern, Luzern, Zug)
 * and Luxembourg (Munsbach).
 *
 * The careers page at https://www.colin-cie.com/de/karriere lists jobs as
 * cards with individual detail-page URLs. Each card contains:
 *   <div id='jobspostNNN' class='... Kundenberatung Schweiz Lugano' data-filter*>
 *     <h3 class='autoHyphens'>Title</h3>
 *     <a href='de/karriere/slug' class='buttonStyle readMoreLink'>Mehr erfahren</a>
 *     <span class='jobTag'>Category</span> <span class='jobTag'>Country</span> <span class='jobTag'>City</span>
 *   </div>
 *
 * This crawler:
 *   1. Fetches the /de/karriere listing page.
 *   2. Parses job cards to extract title, detail URL, city, country, date.
 *   3. Fetches each detail page for the full job description.
 *   4. Builds job objects and merges them into jobs.json.
 *   5. Translates and validates locale coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'colin-cie.json');

const COMPANY_KEY = 'colin-cie';
const COMPANY_NAME = 'Colin&Cie Wealth Management';
const COMPANY_HOST = 'www.colin-cie.com';
const COMPANY_DOMAIN = 'colin-cie.com';
const CAREERS_URL = 'https://www.colin-cie.com/de/karriere';
const BASE_URL = 'https://www.colin-cie.com/';
const LOCALES = ['it', 'en', 'de', 'fr'];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

/* city tag → { location, canton, country } */
const CITY_MAP = {
  lugano:       { location: 'Lugano',       canton: 'TI', country: 'CH' },
  zürich:       { location: 'Zürich',       canton: 'ZH', country: 'CH' },
  zurich:       { location: 'Zürich',       canton: 'ZH', country: 'CH' },
  schaffhausen: { location: 'Schaffhausen', canton: 'SH', country: 'CH' },
  basel:        { location: 'Basel',        canton: 'BS', country: 'CH' },
  bern:         { location: 'Bern',         canton: 'BE', country: 'CH' },
  luzern:       { location: 'Luzern',       canton: 'LU', country: 'CH' },
  zug:          { location: 'Zug',          canton: 'ZG', country: 'CH' },
  munsbach:     { location: 'Munsbach',     canton: '',   country: 'LU' },
};

/* ── Helpers ───────────────────────────────────────────────── */
function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deriveSlug(title, city) {
  return normalizeKey(`${title} ${COMPANY_KEY} ${city || 'ch'}`);
}

/* ── Matchers ──────────────────────────────────────────────── */
function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('colin') || url.includes('colin-cie.com');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host.endsWith('.colin-cie.com');
  } catch { return false; }
}

/* ── Fetch ─────────────────────────────────────────────────── */
async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 30000;

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
          'User-Agent': USER_AGENTS[attempt],
          Referer: 'https://www.google.com/',
        },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2) {
        const delay = 3000 * (attempt + 1);
        console.log(`  ⚠️  fetch attempt ${attempt + 1} failed (${err.message}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.log(`  ⚠️  all fetch attempts failed (${err.message}), trying Playwright fallback...`);
        try {
          const { chromium } = await import('playwright');
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage({ userAgent: USER_AGENTS[0] });
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
            return await page.content();
          } finally {
            await browser.close();
          }
        } catch (pwErr) {
          throw new Error(`All fetch methods failed. Last fetch: ${err.message}. Playwright: ${pwErr.message}`);
        }
      }
    }
  }
}

/**
 * Parse job cards from the Colin&Cie careers listing page.
 *
 * Each card:
 *   <div id='jobspostNNN' class='grid-item blockStyle prevboxStyle-jobs Kundenberatung Schweiz Lugano'
 *        data-filterfunction='2' data-filtercountry='1' data-filtercities='4'>
 *     <span class='newsDate'>13.09.2024</span>
 *     <h3 class='autoHyphens'>Title</h3>
 *     <a href='de/karriere/slug' class='buttonStyle readMoreLink'>Mehr erfahren</a>
 *     <span class='jobTag'>Kundenberatung</span> <span class='jobTag'>Schweiz</span> <span class='jobTag'>Lugano</span>
 *   </div>
 */
function parseListingPage(html) {
  const jobs = [];
  const cardRegex = /<div\s+id='jobspost(\d+)'[^>]*class='([^']*)'[^>]*>([\s\S]*?)(?=<div\s+id='jobspost|<div\s+class='width-100[^']*jobsInitiativ|$)/gi;
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const postId = match[1];
    const classes = match[2];
    const cardHtml = match[3];

    // Title
    const titleMatch = cardHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!titleMatch) continue;
    const title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim());

    // Detail URL
    const urlMatch = cardHtml.match(/href='([^']*karriere[^']*)'/i);
    if (!urlMatch) continue;
    const detailPath = urlMatch[1];
    const detailUrl = detailPath.startsWith('http') ? detailPath : BASE_URL + detailPath;

    // Date
    const dateMatch = cardHtml.match(/<span\s+class='newsDate'>\s*(\d{2}\.\d{2}\.\d{4})\s*<\/span>/i);
    const dateStr = dateMatch ? dateMatch[1] : '';
    let postedDate = '';
    if (dateStr) {
      const [d, m, y] = dateStr.split('.');
      postedDate = `${y}-${m}-${d}`;
    }

    // Tags (category, country, city)
    const tagRegex = /<span\s+class='jobTag'>(.*?)<\/span>/gi;
    const tags = [];
    let tagMatch;
    while ((tagMatch = tagRegex.exec(cardHtml)) !== null) {
      tags.push(tagMatch[1].trim());
    }
    // Typically: [Kundenberatung, Schweiz, Lugano] or [Kundenberatung, Luxemburg, Munsbach]
    const category = tags[0] || '';
    const country = tags[1] || '';
    const city = tags[2] || '';

    jobs.push({ postId, title, detailUrl, postedDate, category, country, city });
  }
  return jobs;
}

/**
 * Fetch a detail page and extract the job description.
 * Sections: intro h4, "Das bieten wir Ihnen", "Ihre Hauptaufgaben bei uns", "Das bringen Sie mit"
 */
async function fetchJobDescription(url) {
  try {
    const html = await fetchPage(url);
    const sections = [];

    // Intro paragraph (h4 with strong/mediumStyle)
    const introMatch = html.match(/<h4><strong><span[^>]*class="mediumStyle"[^>]*>([\s\S]*?)<\/span><\/strong><\/h4>/i);
    if (introMatch) {
      sections.push(decodeHtmlEntities(stripHtml(introMatch[1])));
    }

    // Named sections: "Das bieten wir Ihnen", "Ihre Hauptaufgaben", "Das bringen Sie mit"
    const sectionRegex = /<h3[^>]*><span[^>]*class="pinkStyle"[^>]*>([\s\S]*?)<\/span><\/h3>\s*<ul[^>]*>([\s\S]*?)<\/ul>/gi;
    let sMatch;
    while ((sMatch = sectionRegex.exec(html)) !== null) {
      const heading = decodeHtmlEntities(stripHtml(sMatch[1]));
      const listHtml = sMatch[2];
      const items = [];
      const itemRegex = /<li>([\s\S]*?)<\/li>/gi;
      let iMatch;
      while ((iMatch = itemRegex.exec(listHtml)) !== null) {
        items.push(decodeHtmlEntities(stripHtml(iMatch[1])));
      }
      if (items.length > 0) {
        sections.push(`## ${heading}\n${items.map(i => `• ${i}`).join('\n')}`);
      }
    }

    return sections.join('\n\n') || '';
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch detail page ${url}: ${err.message}`);
    return '';
  }
}

/* ── Category inference ────────────────────────────────────── */
function inferCategory(rawCategory = '', title = '') {
  const cat = normalize(rawCategory);
  const t = normalize(title);
  if (cat.includes('kundenberatung') || t.includes('berater') || t.includes('advisor')) return 'consulting';
  if (cat.includes('teamleitung') || t.includes('leiter') || t.includes('head')) return 'management';
  if (cat.includes('business') || t.includes('business')) return 'business';
  if (t.includes('analyst') || t.includes('compliance') || t.includes('risk')) return 'finance';
  if (t.includes('admin') || t.includes('assistant')) return 'admin';
  return 'other';
}

/* ── Build job object ──────────────────────────────────────── */
function buildJob(row, description) {
  const cityKey = normalize(row.city);
  const geo = CITY_MAP[cityKey] || { location: row.city || 'Schweiz', canton: '', country: 'CH' };
  const slug = deriveSlug(row.title, row.city);

  return {
    title: row.title,
    slug,
    url: row.detailUrl,
    applyUrl: row.detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: geo.location,
    addressLocality: geo.location,
    addressRegion: geo.canton,
    addressCountry: geo.country,
    canton: geo.canton,
    country: geo.country,
    category: inferCategory(row.category, row.title),
    sector: 'Finanza / Wealth Management',
    source: 'colin-cie-dedicated-crawler',
    sourceLang: 'de',
    postedDate: row.postedDate || new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description,
    titleByLocale: { de: row.title },
    descriptionByLocale: { de: description },
    slugByLocale: { it: slug },
  };
}

/* ── Merge ─────────────────────────────────────────────────── */
function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) { added += 1; return job; }
    updated += 1;
    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter ───────────────────────────────────────────────── */
function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = { location: job.location, canton: job.canton, company: COMPANY_NAME };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Colin&Cie — independent wealth management firm. Swiss HQ, Lugano office on Via Nassa. Careers listing at /de/karriere with individual detail pages.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Validation ────────────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_COLIN_CIE_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_colin_cie_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Colin&Cie jobs found after dedicated crawl.',
    detectSourceLang: () => 'de',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'colin-cie');
  console.log('═══════════════════════════════════════════════');
  console.log('  Colin&Cie Wealth Management — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  // 1. Fetch and parse listing
  console.log('🔍 Fetching Colin&Cie careers page...');
  const html = await fetchPage(CAREERS_URL);
  const listings = parseListingPage(html);
  console.log(`📋 Found ${listings.length} job listings:`);
  for (const l of listings) {
    console.log(`  📄 ${l.title} (${l.city}, ${l.country})`);
  }

  if (listings.length === 0) {
    console.log('ℹ️ No job listings found on the Colin&Cie careers page.');
    return;
  }

  // 2. Fetch detail pages for descriptions
  console.log('\n📥 Fetching job detail pages...');
  const jobs = [];
  for (const listing of listings) {
    console.log(`  🔗 ${listing.detailUrl}`);
    const description = await fetchJobDescription(listing.detailUrl);
    jobs.push(buildJob(listing, description));
    // Small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  // 3. Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  // 4. Translate missing locales
  console.log('\n🌐 Running locale fill for Colin&Cie jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // 5. Validate
  validateLocales();

  console.log('\n📊 === Colin&Cie Job Stats ===');
  console.log(`  💼 Total Colin&Cie jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'colin-cie',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((error) => {
  console.error(`❌ Colin&Cie crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
