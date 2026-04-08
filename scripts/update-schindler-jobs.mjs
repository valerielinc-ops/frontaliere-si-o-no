#!/usr/bin/env node
/**
 * Dedicated Schindler (Ticino) crawler runner — Direct HTML parsing.
 *
 * Source:
 *   https://job.schindler.com/search/?createNewAlert=false&q=&locationsearch=Ticino&optionsFacetsDD_country=
 *
 * Schindler uses a SuccessFactors/NES-based ATS. The search page is server-rendered
 * HTML (not a JS SPA). The base crawler extracts brand slogans instead of actual
 * job titles from these pages, so this script uses direct HTML parsing instead.
 *
 * This script:
 *   1. Fetches the Schindler Ticino search page and discovers job URLs + titles.
 *   2. Fetches each detail page and extracts description + metadata from HTML.
 *   3. Builds complete job objects and merges them into jobs.json.
 *   4. Validates locale coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  deriveLocalizedSlug,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './lib/target-swiss-locations.mjs';
import { TARGET_CANTONS } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const SCHINDLER_KEY = 'schindler';
const SCHINDLER_COMPANY_NAME = 'Schindler';
const SCHINDLER_HOST = 'job.schindler.com';
const SCHINDLER_COMPANY_DOMAIN = 'schindler.com';
const SCHINDLER_SEARCH_URL =
  'https://job.schindler.com/search/?createNewAlert=false&q=&locationsearch=Ticino&optionsFacetsDD_country=';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toIsoDate(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function isSchindlerJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim().toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === SCHINDLER_KEY ||
    key.includes('schindler') ||
    host.includes('job.schindler.com') ||
    host.endsWith('schindler.com') ||
    company.includes('schindler')
  );
}

function isTrustedSchindlerDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('schindler.com') || host === 'job.schindler.com';
  } catch {
    return false;
  }
}

function inferContract(title = '') {
  const t = normalize(title);
  if (/apprendist/i.test(t) || /lehrling|apprenti/i.test(t)) return 'apprenticeship';
  if (/stage|tirocinio|praktik/i.test(t)) return 'temporary';
  const pctMatch = t.match(/(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*%/);
  if (pctMatch) {
    const max = pctMatch[2] ? Number(pctMatch[2]) : Number(pctMatch[1]);
    if (max < 100) return 'part-time';
  }
  return 'full-time';
}

// ──────────────────────────────────────────────────────────────
// Discovery: fetch search page and extract job URLs + titles
// ──────────────────────────────────────────────────────────────

async function fetchSchindlerSearchResults() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  console.log('🔍 Fetching Schindler Ticino jobs from search page...');
  console.log(`  📡 ${SCHINDLER_SEARCH_URL}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let html;
  try {
    const res = await fetch(SCHINDLER_SEARCH_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent,
      },
    });
    clearTimeout(timer);
    html = await res.text();
    if (!res.ok) {
      console.error(`❌ HTTP ${res.status} for Schindler search page.`);
      return [];
    }
  } catch (err) {
    clearTimeout(timer);
    console.error(`❌ Schindler search page fetch failed: ${err?.message || err}`);
    return [];
  }

  // Extract job rows: jobTitle-link has href + title text; jobLocation has location; jobDate has date
  const results = [];
  const seen = new Set();

  const jobRowPattern =
    /class="jobTitle-link"[^>]*href="(\/[^"]+\/job\/[^"]+)"[^>]*>\s*([^<]+?)\s*<[\s\S]*?class="jobLocation"[^>]*>\s*([^<]+?)\s*</g;

  let rowMatch;
  while ((rowMatch = jobRowPattern.exec(html)) !== null) {
    const relativePath = rowMatch[1];
    const title = rowMatch[2].trim();
    const location = rowMatch[3].trim();
    const fullUrl = `https://${SCHINDLER_HOST}${relativePath}`;

    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    const city = location.split(',')[0]?.trim() || '';
    const canton = inferSwissTargetCanton(location) || TARGET_CANTONS[0];

    results.push({ url: fullUrl, title, city, location, canton });
    console.log(`  📌 ${title} — ${city} (${canton}) → ${fullUrl}`);
  }

  // Fallback: also scan for any /XXX/job/ links not caught by the row pattern
  const urlPattern = /href="(\/[^"]+\/job\/[^"]+)"/g;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(html)) !== null) {
    const relativePath = urlMatch[1];
    const fullUrl = `https://${SCHINDLER_HOST}${relativePath}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);
    results.push({ url: fullUrl, title: '', city: '', location: 'Ticino', canton: TARGET_CANTONS[0] });
    console.log(`  📌 (no title in search) → ${fullUrl}`);
  }

  console.log(`✅ Total unique Schindler jobs discovered: ${results.length}`);
  return results;
}

// ──────────────────────────────────────────────────────────────
// Detail page fetch: extract description + metadata from HTML
// ──────────────────────────────────────────────────────────────

async function fetchSchindlerJobDetail(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let html;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent,
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`  ⚠️ HTTP ${res.status} fetching ${url}`);
      return null;
    }
    html = await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`  ⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return null;
  }

  // Extract title from <h1 class="job-title">
  const titleMatch = html.match(/<h1[^>]*class="job-title"[^>]*>([\s\S]*?)<\/h1>/i);
  const detailTitle = titleMatch ? stripHtml(titleMatch[1]).trim() : '';

  // Fallback: extract title from <title> tag — format: "Job Title Dettagli lavoro | Schindler Group"
  let fallbackTitle = '';
  const pageTitleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (pageTitleMatch) {
    fallbackTitle = pageTitleMatch[1]
      .replace(/\s*Dettagli lavoro\s*\|\s*Schindler Group\s*/i, '')
      .replace(/\s*Job Details\s*\|\s*Schindler Group\s*/i, '')
      .trim();
  }

  // Extract description from <span class="jobdescription">...</span>
  // Content runs until "Candidati ora" apply button
  let description = '';
  const descMatch = html.match(/class="jobdescription"[^>]*>([\s\S]*?)Candidati ora/i);
  if (descMatch) {
    let rawDesc = descMatch[1];
    // Remove images
    rawDesc = rawDesc.replace(/<img[^>]*>/gi, '');
    // Remove slogan h1
    rawDesc = rawDesc.replace(/<h1[^>]*class="slogan"[^>]*>[\s\S]*?<\/h1>/gi, '');
    description = stripHtml(rawDesc);
  }

  // Extract Microdata: datePosted, addressLocality, addressRegion, hiringOrganization
  const dateMatch = html.match(/itemprop="datePosted"\s+content="([^"]+)"/i);
  const localityMatch = html.match(/itemprop="addressLocality"\s+content="([^"]+)"/i);
  const regionMatch = html.match(/itemprop="addressRegion"\s+content="([^"]+)"/i);

  return {
    detailTitle,
    fallbackTitle,
    description,
    datePosted: dateMatch ? dateMatch[1] : '',
    addressLocality: localityMatch ? localityMatch[1] : '',
    addressRegion: regionMatch ? regionMatch[1] : '',
  };
}

// ──────────────────────────────────────────────────────────────
// Parse: build a complete job object from search + detail data
// ──────────────────────────────────────────────────────────────

function parseSchindlerJob(searchResult, detailData) {
  // Title priority: search page title > detail page h1 > <title> tag fallback
  const title = searchResult.title || detailData?.detailTitle || detailData?.fallbackTitle || '';
  if (!title) {
    console.warn(`  ⚠️ No title for ${searchResult.url} — skipping`);
    return null;
  }

  const description = detailData?.description || '';
  if (description.length < 50) {
    console.warn(`  ⚠️ Thin description (${description.length} chars) for: ${title}`);
    // Still allow it — some SuccessFactors pages have very short descriptions
  }

  // Location: prefer detail page Microdata, fallback to search page
  const city = detailData?.addressLocality || searchResult.city || searchResult.location || 'Ticino';
  const canton = inferSwissTargetCanton(
    [detailData?.addressRegion, searchResult.location, searchResult.canton].filter(Boolean).join(' ')
  ) || 'TI';

  const postedDate = toIsoDate(detailData?.datePosted || '');
  const contract = inferContract(title);

  // Generate stable ID from URL
  const urlHash = createHash('sha1').update(searchResult.url).digest('hex').slice(0, 12);
  const id = `schindler-${urlHash}`;
  const slugBase = slugify(`${title}-schindler-${city}`);

  // Schindler posts only in Italian — set source locale only.
  // translate-pending pipeline will fill other locales.
  const titleByLocale = { it: title };
  const slugByLocale = {
    it: slugify(`${title}-schindler-${city}`),
  };
  // Schindler posts only in Italian — source locale only.
  const descriptionByLocale = {
    it: description,
  };

  return {
    id,
    slug: slugBase,
    slugByLocale,
    company: SCHINDLER_COMPANY_NAME,
    companyKey: SCHINDLER_KEY,
    companyDomain: SCHINDLER_COMPANY_DOMAIN,
    title,
    titleByLocale,
    description,
    descriptionByLocale,
    requirements: [],
    requirementsByLocale: { it: [] },
    location: city,
    canton,
    addressLocality: city,
    addressCountry: 'CH',
    country: 'CH',
    category: 'engineering',
    contract,
    currency: 'CHF',
    featured: false,
    postedDate,
    url: searchResult.url,
    source: 'Schindler Dedicated Parser (SuccessFactors HTML)',
    sourceLang: detectLang(description || title, 'it'),
    crawledAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
// Merge & write
// ──────────────────────────────────────────────────────────────

function writeJobsFiles(jobs) {
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  }
}

function mergeSchindlerJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(SCHINDLER_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const nonSchindler = allJobs.filter((job) => !isSchindlerJob(job));
  const schindlerExisting = allJobs.filter(isSchindlerJob);

  // Deduplicate by URL
  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];

  // Preserve existing locale translations and slugs
  const cleanJobs = mergePreserveLocaleData(schindlerExisting, deduped).sort(
    (a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );
  const merged = [...nonSchindler, ...cleanJobs];
  writeJobsFiles(merged);
  return cleanJobs;
}

// ──────────────────────────────────────────────────────────────
// Stats & diff
// ──────────────────────────────────────────────────────────────

function logSchindlerJobStats(parsedJobs, beforeSnapshot = new Map()) {
  const ticinoJobs = parsedJobs.filter((j) => normalize(j?.canton) === 'ti');

  console.log('\n📊 === Schindler Ticino Job Stats ===');
  console.log(`  🏗️ Job totali trovati (Schindler): ${parsedJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  for (const j of parsedJobs) {
    console.log(`    → ${j.title} — ${j.location} (${j.canton})`);
  }
  console.log('');

  const afterSnapshot = snapshotJobSlugs(parsedJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Schindler');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Schindler');
  return { crawlDiff };
}

// ──────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────

function validateSchindlerLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SCHINDLER_STRICT',
    label: 'Schindler',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isSchindlerJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedSchindlerDomain,
    untrustedDomainReason: 'untrusted_domain_for_schindler_job',
    noJobsMessage: 'Nessun job Schindler trovato dopo il crawl — niente da validare.',
  });
}

async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: SCHINDLER_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(SCHINDLER_KEY, 'Schindler');
  console.log('🏗️ Running dedicated Schindler Ticino jobs crawler (direct HTML parsing)...');
  console.log(`   Source: ${SCHINDLER_SEARCH_URL}`);
  console.log('   Scope: CH jobs in Ticino');
  console.log('');

  // Snapshot before for diff
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(SCHINDLER_KEY, DATA_JOBS).filter(isSchindlerJob))

  // Step 1: Discover jobs from search page (titles + URLs + locations)
  const searchResults = await fetchSchindlerSearchResults();
  if (searchResults.length === 0) {
    console.log('ℹ️ Nessun URL di dettaglio Schindler trovato. Uscita OK.');
    return;
  }

  // Step 2: Fetch each detail page and extract description + metadata
  console.log(`\n🔎 Fetching ${searchResults.length} detail pages...`);
  const parsedJobs = [];
  for (const sr of searchResults) {
    console.log(`  📄 ${sr.url}`);
    const detail = await fetchSchindlerJobDetail(sr.url);
    const job = parseSchindlerJob(sr, detail);
    if (job) {
      parsedJobs.push(job);
      console.log(`  ✅ ${job.title} — ${job.location} (${job.canton})`);
    }
  }
  console.log(`\n✅ Parsed Schindler jobs: ${parsedJobs.length}`);

  if (parsedJobs.length === 0) {
    console.log('⚠️ No valid jobs parsed — keeping existing Schindler jobs unchanged.');
    return;
  }

  // Step 3: Merge into jobs.json (replace all old Schindler jobs with new)
  const publishedJobs = mergeSchindlerJobs(parsedJobs);
  printPublishedJobUrls(publishedJobs, 'Schindler');
  writeJobsSummary(publishedJobs, 'Schindler');

  // Step 4: Stats & diff
  const _cdResult = logSchindlerJobStats(publishedJobs, beforeSnapshot);
  const crawlDiff = _cdResult.crawlDiff;

  // Step 5: Run shared localization pass
  await runBaseCrawler();

  // Step 6: Validate locale coverage
  validateSchindlerLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isSchindlerJob) : [];
  writeJobsCrawlerSlice(SCHINDLER_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: SCHINDLER_KEY,
    label: 'Schindler',
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
  console.error(`❌ Schindler crawler failed: ${err?.message || err}`);
  process.exit(1);
});
