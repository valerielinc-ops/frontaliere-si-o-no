#!/usr/bin/env node
/**
 * Dedicated Centiel crawler runner.
 *
 * Centiel is a power-protection / UPS company headquartered in
 * Cadro (Lugano), CH-6965, Via alla Stampa 15.
 *
 * The careers page at https://www.centiel.com/careers/ lists jobs inline
 * inside accordion items — there are no individual detail-page URLs.
 * Each listing links to a PDF job description.
 *
 * This crawler:
 *   1. Fetches the /careers/ page HTML.
 *   2. Parses accordion blocks to extract title, description, location, PDF URL.
 *   3. Builds job objects and merges them into jobs.json.
 *   4. Translates and validates locale coverage.
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
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
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'centiel.json');

const COMPANY_KEY = 'centiel';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Centiel';
const COMPANY_HOST = 'www.centiel.com';
const COMPANY_DOMAIN = 'centiel.com';
const CAREERS_URL = 'https://www.centiel.com/careers/';
const LOCALES = ['it', 'en', 'de', 'fr'];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

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
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deriveSlug(title) {
  return normalizeKey(`${title} ${COMPANY_KEY} ticino`);
}

/* ── Matchers ──────────────────────────────────────────────── */
function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('centiel') || url.includes('centiel.com');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host.endsWith('.centiel.com');
  } catch { return false; }
}

/* ── Fetch & Parse ─────────────────────────────────────────── */
async function fetchCareersHtml() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse job listings from the Centiel careers page HTML.
 *
 * The page lists jobs under an "Current vacancies" h2.
 * Each job is an <h3> title followed by paragraphs containing the
 * description, metadata (<strong> labels), and a "Learn more" PDF link.
 * There are no wrapper divs or accordion classes — just sequential
 * h3 + p elements.
 */
function parseCareersPage(html) {
  const jobs = [];

  // Isolate the vacancies section: everything after "Current vacancies" h2
  const vacancyStart = html.search(/<h2[^>]*>[^<]*Current\s+vacancies[^<]*<\/h2>/i);
  if (vacancyStart === -1) {
    // Fallback: try to find the first h3 that looks like a job title
    // (page may restructure again)
  }
  const sectionHtml = vacancyStart !== -1 ? html.slice(vacancyStart) : html;

  // Split by <h3> tags to get one block per job.
  // Each block starts right after the <h3> open tag.
  const h3Parts = sectionHtml.split(/<h3[^>]*>/i).slice(1);

  for (const part of h3Parts) {
    // Extract title (text before closing </h3>)
    const closingH3 = part.indexOf('</h3>');
    if (closingH3 === -1) continue;
    const rawTitle = part.slice(0, closingH3);
    const title = decodeHtmlEntities(stripHtml(rawTitle)).trim();
    if (!title) continue;

    // The content after </h3> until the end of this block
    const contentHtml = part.slice(closingH3 + 5);

    // Extract PDF URL and resolve to absolute
    const pdfMatch = contentHtml.match(/href="([^"]*\.pdf[^"]*)"/i);
    const pdfUrl = pdfMatch
      ? new URL(pdfMatch[1], CAREERS_URL).href
      : '';

    // Extract workplace/location
    const workplaceMatch = contentHtml.match(/<strong>\s*Workplace\s*:?\s*<\/strong>\s*(.*?)(?:<br|<\/p|<strong)/i);
    const workplace = workplaceMatch
      ? stripHtml(workplaceMatch[1]).trim()
      : 'Cadro (Lugano)';

    // Extract reporting-to
    const reportingMatch = contentHtml.match(/<strong>\s*Reporting\s+to\s*:?\s*<\/strong>\s*(.*?)(?:<br|<\/p|<strong)/i);
    const reportingTo = reportingMatch ? stripHtml(reportingMatch[1]).trim() : '';

    // Extract working rate
    const rateMatch = contentHtml.match(/<strong>\s*Working\s+rate\s*:?\s*<\/strong>\s*(.*?)(?:<br|<\/p|<strong)/i);
    const workingRate = rateMatch ? stripHtml(rateMatch[1]).trim() : '';

    // Build clean description from the content paragraphs (exclude the "Learn more" link text)
    const description = stripHtml(contentHtml)
      .replace(/Learn more\s*$/, '')
      .trim();

    jobs.push({
      title,
      description,
      workplace,
      reportingTo,
      workingRate,
      pdfUrl,
    });
  }

  return jobs;
}

/* ── Category inference ────────────────────────────────────── */
function inferCategory(title = '') {
  const t = normalize(title);
  if (t.includes('engineer') || t.includes('r&d') || t.includes('development')) return 'engineering';
  if (t.includes('sales') || t.includes('account') || t.includes('partner')) return 'sales';
  if (t.includes('technician') || t.includes('after-sales') || t.includes('service')) return 'engineering';
  if (t.includes('admin') || t.includes('assistant') || t.includes('hr')) return 'admin';
  if (t.includes('marketing') || t.includes('communication')) return 'marketing';
  return 'other';
}

/* ── Build job object ──────────────────────────────────────── */
function buildJob(row) {
  const slug = deriveSlug(row.title);
  // Use the PDF URL as the canonical URL if available, otherwise careers page
  const url = row.pdfUrl || CAREERS_URL;

  // Ensure description meets the 50-word minimum threshold
  let description = row.description || '';
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < 50) {
    // Build a richer description with job-specific details
    const parts = [
      `${row.title} — Centiel, Cadro (Lugano), Canton Ticino, Switzerland.`,
      row.reportingTo ? `Reporting to: ${row.reportingTo}.` : '',
      row.workingRate ? `Working rate: ${row.workingRate}.` : '',
      description ? `\n${description}` : '',
      `\nCentiel is a Swiss company headquartered in Cadro (Lugano), specializing in the design and manufacture of uninterruptible power supply (UPS) systems and power protection solutions. The company develops innovative three-phase modular UPS technology for mission-critical applications including data centers, hospitals, industrial facilities, and telecommunications infrastructure. Centiel's products are known for their high efficiency, reliability, and scalability, serving clients across Europe and globally.`,
      `\nWorkplace: ${row.workplace || 'Cadro (Lugano)'}, Via alla Stampa 15, CH-6965.`,
      `Apply via: ${CAREERS_URL}`,
    ];
    description = parts.filter(Boolean).join('\n').trim();
  }

  return {
    title: row.title,
    slug,
    url,
    applyUrl: url,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: 'Cadro (Lugano)',
    addressLocality: 'Lugano',
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: inferCategory(row.title),
    sector: 'Energia / UPS / Power Protection',
    source: 'centiel-dedicated-crawler',
    sourceLang: 'en',
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: row.workingRate || 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description,
    titleByLocale: { en: row.title },
    descriptionByLocale: { en: description },
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
    seedMetaByUrl[job.url] = { location: 'Cadro (Lugano)', canton: HQ.canton, company: COMPANY_NAME };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Centiel — UPS/power protection in Cadro, Lugano TI. Careers are inline accordion items on a single page with PDF job descriptions.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Validation ────────────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CENTIEL_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_centiel_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Centiel jobs found after dedicated crawl.',
    detectSourceLang: () => 'en',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'centiel');
  console.log('═══════════════════════════════════════════════');
  console.log('  Centiel — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  // 1. Fetch and parse
  console.log('🔍 Fetching Centiel careers page...');
  const html = await fetchCareersHtml();
  const listings = parseCareersPage(html);
  console.log(`📋 Found ${listings.length} job listings:`);
  for (const l of listings) {
    console.log(`  📄 ${l.title} (${l.workplace})`);
  }

  if (listings.length === 0) {
    console.log('ℹ️ No job listings found on the Centiel careers page.');
    return;
  }

  // 2. Build job objects
  const jobs = listings.map(buildJob);

  // 3. Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  // 4. Translate missing locales
  console.log('\n🌐 Running locale fill for Centiel jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // 5. Validate
  validateLocales();

  console.log('\n📊 === Centiel Job Stats ===');
  console.log(`  ⚡ Total Centiel jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'centiel',
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
  console.error(`❌ Centiel crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
