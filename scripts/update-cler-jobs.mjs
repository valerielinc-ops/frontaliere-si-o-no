#!/usr/bin/env node
/**
 * Dedicated Banca Cler crawler.
 * Fetches jobs from the Cler jobssearch API, scrapes detail pages for rich descriptions,
 * and runs AI localization for SEO-critical fields.
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import {
  htmlToMarkdown,
  validateClerDescription,
} from './lib/cler-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'banca-cler';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Banca Cler';
const API_BASE = 'https://www.cler.ch';
// German API returns results; Italian returns 0 (locale mismatch on server side)
const API_PATH = '/de/api/jobssearch/search?sc_site=bc&jobs=%7B3F115DCF-9CE3-4466-9E05-53D8D9B5DAC0%7D&predefinedFilter=&pageSize=50';

const TIMEOUT_MS = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '15000', 10);
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoCrawler/1.0)';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function slugify(title, companyKey = COMPANY_KEY) {
  const base = `${title} ${companyKey}`
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return base;
}

function filterEmpty(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

function isTargetJob(job) {
  if (!job) return false;
  if (job.companyKey === COMPANY_KEY) return true;
  const cn = normalize(job.company || '');
  const url = normalize(job.url || '');
  return cn.includes('cler') || url.includes('cler.ch');
}

function jobMatchKey(job) {
  return job.url || job.slug || '';
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isTrustedDomain(rawUrl = '') {
  try {
    return new URL(rawUrl).hostname.toLowerCase().endsWith('cler.ch');
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Category inference
// ─────────────────────────────────────────────────────────────

function inferCategory(field = '', title = '') {
  const hay = `${field} ${title}`.toLowerCase();
  if (/(private banking|privatkunden|vermögen|anlage|wealth)/i.test(hay)) return 'finance';
  if (/(digital|it|software|data|cyber)/i.test(hay)) return 'it';
  if (/(marketing|communication|kommunikation)/i.test(hay)) return 'marketing';
  if (/(hr|human|personal|talent)/i.test(hay)) return 'hr';
  if (/(compliance|legal|recht|risk)/i.test(hay)) return 'legal';
  if (/(operation|betrieb|logist)/i.test(hay)) return 'operations';
  if (/(sales|vertrieb|kundenberater)/i.test(hay)) return 'sales';
  return 'finance';
}

function inferEmploymentType(title = '', workload = '') {
  const t = `${title} ${workload}`.toLowerCase();
  if (/praktik|intern|trainee|stage/i.test(t)) return 'internship';
  if (/teilzeit|part.?time/i.test(t)) return 'part_time';
  if (/temporär|befristet/i.test(t)) return 'temporary';
  return 'full_time';
}

// ─────────────────────────────────────────────────────────────
// Fetch & Parse
// ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/json,*/*',
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJobListings() {
  const url = `${API_BASE}${API_PATH}`;
  console.log(`  📡 Fetching API: ${url}`);
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`API returned ${res.status}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  console.log(`  📋 API returned ${results.length} listings`);
  return results;
}

async function fetchDetailPage(relativeUrl) {
  const url = `${API_BASE}${relativeUrl}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.warn(`  ⚠️ Detail page ${res.status}: ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`  ⚠️ Detail page error: ${url} — ${err.message}`);
    return null;
  }
}

function buildDescription(title, html) {
  if (!html) {
    // Fallback: minimal description from title only
    return `## ${title}\n\nBanca Cler — per i dettagli consultare la pagina dell'offerta.`;
  }

  const markdown = htmlToMarkdown(html);
  if (markdown && markdown.length >= 200) return markdown;

  // Fallback if parser returned too little
  return `## ${title}\n\nBanca Cler — per i dettagli consultare la pagina dell'offerta.`;
}

async function fetchClerJobs() {
  const listings = await fetchJobListings();
  const jobs = [];

  for (const listing of listings) {
    const title = (listing.title || '').trim();
    if (!title) continue;

    const detailPath = listing.link?.url || '';
    if (!detailPath) continue;

    const detailUrl = `${API_BASE}${detailPath}`;
    const field = listing.fieldofactivity || '';
    const workload = listing.workload || '';
    const date = listing.date || '';

    console.log(`  🔍 ${title}`);

    // Fetch detail page for rich description
    const detailHtml = await fetchDetailPage(detailPath);
    const description = buildDescription(title, detailHtml);
    const sourceTextLength = detailHtml
      ? detailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length
      : 0;

    // Validate description quality
    const validation = validateClerDescription(description, sourceTextLength);
    if (!validation.ok) {
      for (const w of validation.warnings) {
        console.warn(`    ⚠️ ${w}`);
      }
    }

    const slug = slugify(title);
    const sourceLang = detectLang(description, 'de');
    const category = inferCategory(field, title);
    const empType = inferEmploymentType(title, workload);

    // Parse posted date (DD.MM.YYYY → YYYY-MM-DD)
    let postedDate = todayIso();
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(date)) {
      const [d, m, y] = date.split('.');
      postedDate = `${y}-${m}-${d}`;
    }

    const job = {
      title,
      slug,
      url: detailUrl,
      applyUrl: detailUrl,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: 'cler.ch',
      location: 'Bellinzona',
      addressLocality: 'Bellinzona',
      addressRegion: 'Ticino',
      addressCountry: 'CH',
      canton: DEFAULT_CANTON,
      country: 'CH',
      category,
      sector: 'Banca / Servizi finanziari',
      department: field,
      source: 'cler-dedicated-crawler',
      sourceLang,
      postedDate,
      validThrough: '',
      employmentType: empType,
      contractType: empType === 'internship' ? 'stage' : 'permanent',
      description,
      titleByLocale: { de: title },
      descriptionByLocale: { de: description },
      slugByLocale: { de: slugify(title) },
      crawledAt: new Date().toISOString(),
    };

    console.log(`    ✅ ${description.length} chars | lang=${sourceLang} | cat=${category}`);
    jobs.push(job);
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((j) => !isTargetJob(j));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((j) => [jobMatchKey(j), j]));

  const discoveredByKey = new Map(discoveredJobs.map((j) => [jobMatchKey(j), j]));

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = jobMatchKey(discovered);
    const prev = existingByKey.get(key);
    if (!prev) {
      added++;
      merged.push(discovered);
      continue;
    }
    updated++;

    const prevDesc = (prev.description || '').trim();
    const newDesc = (discovered.description || '').trim();
    const descChanged = newDesc.length > 0 && prevDesc.length > 0 &&
      Math.abs(newDesc.length - prevDesc.length) > 100;

    const prevLocaleDescs = descChanged ? {} : (prev.descriptionByLocale || {});

    merged.push({
      ...prev,
      ...discovered,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, discovered.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prevLocaleDescs, discovered.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, discovered.slugByLocale, 3),
    });
  }

  // Count removed (existing jobs not in new crawl)
  for (const [key] of existingByKey) {
    if (!discoveredByKey.has(key)) removed++;
  }

  const allJobs = [...nonTargetJobs, ...merged];
  writeJson(DATA_JOBS, allJobs);
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, allJobs);
  }

  const afterSnapshot = snapshotJobSlugs(merged);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${allJobs.length}`);

  return { total: allJobs.length, added, updated, removed, targetCount: merged.length, diff };
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_MIN_DESCRIPTION_CHARS: '80',
      JOBS_MIN_QUALITY_SCORE: '4',
    },
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CLER_STRICT',
    label: 'Cler',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    minDescriptionChars: 80,
    noJobsMessage: 'No Cler jobs found after crawl.',
    detectSourceLang: (text) => detectLang(text, 'de'),
    isTrustedDomain,
    untrustedDomainReason: 'untrusted_domain_for_cler_job',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Cler');
  console.log('═══════════════════════════════════════════════');
  console.log('  Banca Cler — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Source: cler.ch jobssearch API (German)`);
  console.log(`  Company key: ${COMPANY_KEY}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob))

  // Phase 1: Fetch and parse jobs
  console.log('🔍 Phase 1: Fetch Cler jobs...');
  const discoveredJobs = await fetchClerJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Cler jobs discovered from API.');
    console.log('   Keeping existing jobs unchanged.');
    return;
  }

  // Phase 2: Merge into data/jobs.json
  console.log('\n📦 Phase 2: Merge...');
  const stats = mergeJobs(discoveredJobs);
  const diff = stats.diff;

  // Phase 3: Run base crawler for AI localization
  console.log('\n🌐 Phase 3: AI localization...');
  await runBaseCrawler();

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Phase 4: Validate locale coverage
  console.log('\n✅ Phase 4: Validate...');
  validateLocales();

  // Phase 5: Summary
  {
    const raw = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
    const jobs = (Array.isArray(raw) ? raw : []).filter(isTargetJob);
    printPublishedJobUrls(jobs);
    writeJobsSummary(COMPANY_KEY, { total: stats.total, targetCount: stats.targetCount });
  }

  console.log(`\n📈 Result: ${stats.targetCount} Cler jobs (${stats.added} new, ${stats.updated} updated)`);
  console.log(`   Total jobs in file: ${stats.total}`);
  console.log('\n✅ Banca Cler crawler complete.\n');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Cler',
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

main().catch((err) => {
  console.error(`❌ Cler crawler failed: ${err?.message || err}`);
  process.exit(1);
});
