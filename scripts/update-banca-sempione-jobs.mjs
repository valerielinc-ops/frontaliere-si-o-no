#!/usr/bin/env node
/**
 * Dedicated Banca del Sempione crawler runner.
 *
 * Source:
 *   https://www.bancasempione.ch/lavora-con-noi/
 *   WP REST API: https://www.bancasempione.ch/wp-json/wp/v2/job?per_page=100
 *
 * This script:
 *   1. Fetches job listings from the WordPress REST API (custom post type "job").
 *   2. Parses title, URL, content, and date from the structured JSON response.
 *   3. Infers location (Lugano, Zurich, Dubai, etc.) and canton from job content.
 *   4. Merges discovered jobs into data/jobs.json.
 *   5. Updates the adapter config with discovered seed URLs.
 *   6. Runs the shared base crawler for AI localization.
 *   7. Post-processes rows for canonical consistency.
 *   8. Validates locale coverage.
 *
 * Swiss offices: Lugano (HQ), Bellinzona, Locarno, Chiasso (all TI), Zurich (ZH).
 * Only Ticino jobs are kept in the board dataset.
 */
import { getCompanyDefaults, isTargetCanton } from './lib/crawler-location-config.mjs';
import { isTargetSwissLocation } from './lib/target-swiss-locations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
  normalize,
  normalizeKey,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';


/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const BANCA_SEMPIONE_KEY = 'banca-sempione';
const HQ = getCompanyDefaults(BANCA_SEMPIONE_KEY);
const BANCA_SEMPIONE_COMPANY_NAME = 'Banca del Sempione';
const BANCA_SEMPIONE_HOST = 'www.bancasempione.ch';
const BANCA_SEMPIONE_API_URL = 'https://www.bancasempione.ch/wp-json/wp/v2/job?per_page=100';
const BANCA_SEMPIONE_CAREERS_URL = 'https://www.bancasempione.ch/lavora-con-noi/';
const BANCA_SEMPIONE_LOCALES = ['it', 'en', 'de', 'fr'];

/* ── HTML / text helpers ───────────────────────────────────── */
function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à')
    .replace(/&ugrave;/g, 'ù')
    .replace(/&ograve;/g, 'ò')
    .replace(/&igrave;/g, 'ì')
    .replace(/&#\d+;/g, (m) => {
      const code = parseInt(m.slice(2, -1), 10);
      return isFinite(code) ? String.fromCharCode(code) : m;
    })
    .trim();
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Matcher ───────────────────────────────────────────────── */
function isBancaSempioneJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === BANCA_SEMPIONE_KEY ||
    key === 'banca-del-sempione' ||
    key.includes('banca-sempione') ||
    key.includes('banca-del-sempione') ||
    company.includes('banca del sempione') ||
    company.includes('banca sempione') ||
    host === BANCA_SEMPIONE_HOST ||
    host === 'bancasempione.ch'
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === BANCA_SEMPIONE_HOST || host === 'bancasempione.ch';
  } catch {
    return false;
  }
}

/* ── Location inference ────────────────────────────────────── */
/**
 * Infer city and canton from job title and content text.
 * Priority: explicit city mentions, then title hints, then default to Lugano.
 */
export function inferLocation(title = '', contentText = '') {
  const titleLower = String(title || '').toLowerCase();
  const contentLower = String(contentText || '').toLowerCase();
  const combined = `${titleLower} ${contentLower}`;

  // Explicit foreign-market roles must win over generic corporate references to Lugano.
  if (/\bdubai\b|\bmiddle east\b|\bdifc\b/i.test(titleLower)) {
    return { location: 'Dubai', canton: '', country: 'AE' };
  }

  // Zurich office
  if (/\bzurich\b|\bzürich\b|\boffice in zurich\b|\bzurigo\b/i.test(combined)) {
    return { location: 'Zurich', canton: 'ZH' };
  }
  // Bellinzona
  if (/\bbellinzona\b/i.test(combined)) {
    return { location: 'Bellinzona', canton: HQ.canton };
  }
  // Locarno
  if (/\blocarno\b|\bmuralto\b/i.test(combined)) {
    return { location: 'Locarno', canton: HQ.canton };
  }
  // Chiasso
  if (/\bchiasso\b/i.test(combined)) {
    return { location: 'Chiasso', canton: HQ.canton };
  }
  // Dubai / Middle East in body copy
  if (/\bdubai\b|\bmiddle east\b|\bdifc\b/i.test(contentLower)) {
    return { location: 'Dubai', canton: '', country: 'AE' };
  }

  // Default: headquarters in Lugano
  return { location: 'Lugano', canton: HQ.canton };
}

export function shouldKeepBancaSempioneJob({ location = '', canton = '', country = '' } = {}) {
  const normalizedCanton = String(canton || '').trim().toUpperCase();
  const normalizedCountry = String(country || '').trim().toUpperCase();
  if (normalizedCountry && normalizedCountry !== 'CH') return false;
  if (normalizedCanton && isTargetCanton(normalizedCanton)) return true;
  return isTargetSwissLocation(String(location || ''));
}

/* ── Category detection ────────────────────────────────────── */
function detectCategory(title = '', contentText = '') {
  const combined = `${title} ${contentText}`.toLowerCase();
  if (/relationship manager|private banker|wealth management|consulente.*clientela/i.test(combined)) return 'finance';
  if (/compliance|legal|regulatory|aml|kyc/i.test(combined)) return 'legal';
  if (/assistant|support|segretari|receptionist/i.test(combined)) return 'administration';
  if (/analyst|analista|research/i.test(combined)) return 'finance';
  if (/it\b|software|developer|system|network|cyber/i.test(combined)) return 'technology';
  if (/marketing|communication|social media/i.test(combined)) return 'marketing';
  if (/hr\b|human resource|risorse umane/i.test(combined)) return 'hr';
  if (/operation|back office|settlement/i.test(combined)) return 'operations';
  return 'finance'; // Default for a bank
}

/* ── Description builders ──────────────────────────────────── */
function buildDescriptionEn(title, contentText) {
  const snippet = contentText.length > 300 ? contentText.slice(0, 300).replace(/\s+\S*$/, '…') : contentText;
  return `${title} at Banca del Sempione, a Swiss private bank headquartered in Lugano (Ticino). ${snippet}`;
}

function buildDescriptionIt(title, contentText) {
  const snippet = contentText.length > 300 ? contentText.slice(0, 300).replace(/\s+\S*$/, '…') : contentText;
  return `${title} presso Banca del Sempione, banca privata svizzera con sede a Lugano (Ticino). ${snippet}`;
}

/* ── Fetch jobs from WP REST API ───────────────────────────── */
async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBancaSempioneJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;

  console.log(`🔍 Fetching Banca del Sempione jobs from WP REST API...`);

  let wpJobs;
  try {
    wpJobs = await fetchJson(BANCA_SEMPIONE_API_URL, timeoutMs);
  } catch (err) {
    console.error(`❌ Failed to fetch WP REST API: ${err?.message || err}`);
    throw err;
  }

  if (!Array.isArray(wpJobs) || wpJobs.length === 0) {
    console.log('ℹ️  No job listings found via WP REST API.');
    return [];
  }

  console.log(`📋 WP REST API returned ${wpJobs.length} job listing(s).`);

  const jobs = [];

  for (const wpJob of wpJobs) {
    if (wpJob.status !== 'publish') continue;

    const title = decodeHtmlEntities(wpJob.title?.rendered || '');
    const url = wpJob.link || '';
    const contentHtml = wpJob.content?.rendered || '';
    const contentText = decodeHtmlEntities(stripHtml(contentHtml));
    const postedDate = wpJob.date || '';

    if (!title || !url) continue;

    // Basic URL validation
    try {
      const parsed = new URL(url);
      if (parsed.hostname.toLowerCase() !== BANCA_SEMPIONE_HOST) {
        console.log(`⚠️  Skipping non-Banca Sempione URL: ${url}`);
        continue;
      }
    } catch {
      console.log(`⚠️  Skipping invalid URL: ${url}`);
      continue;
    }

    const { location, canton, country } = inferLocation(title, contentText);
    const category = detectCategory(title, contentText);
    const lang = detectLang(contentText);

    if (!shouldKeepBancaSempioneJob({ location, canton, country })) {
      console.log(`  ⏭️  Skipping non-Ticino role: ${title} (${location}, ${canton || country || '?'})`);
      continue;
    }

    // Build description
    const descEn = buildDescriptionEn(title, contentText);
    const descIt = buildDescriptionIt(title, contentText);

    // Build slug from WP slug
    const wpSlug = wpJob.slug || '';
    const baseSlug = wpSlug
      ? `banca-del-sempione-${wpSlug}`
      : deriveLocalizedSlug(title, 'it');

    const job = {
      title,
      company: BANCA_SEMPIONE_COMPANY_NAME,
      companyKey: BANCA_SEMPIONE_KEY,
      url,
      location: location || 'Lugano',
      canton: canton || HQ.canton,
      country: country || 'CH',
      category,
      description: descEn,
      descriptionIt: descIt,
      postedDate: postedDate ? new Date(postedDate).toISOString().slice(0, 10) : '',
      source: 'company-website',
      slug: baseSlug,
      slugByLocale: {
        it: baseSlug,
        en: deriveLocalizedSlug(title, 'en') || baseSlug,
        de: deriveLocalizedSlug(title, 'de') || baseSlug,
        fr: deriveLocalizedSlug(title, 'fr') || baseSlug,
      },
      titleByLocale: {
        it: title,
      },
      sourceLang: detectLang(descEn || title, 'it'),
    };

    console.log(`  ✅ ${title} (${location}, ${canton || country || '?'})`);
    jobs.push(job);
  }

  console.log(`📋 Total unique Banca del Sempione jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge into jobs.json ──────────────────────────────────── */
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function mergeBancaSempioneJobs(discoveredJobs) {
  let allJobs = [];
  if (fs.existsSync(DATA_JOBS)) {
    allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    if (!Array.isArray(allJobs)) allJobs = [];
  }

  // Index existing jobs by URL
  const existingByUrl = new Map();
  for (const j of allJobs) {
    if (isBancaSempioneJob(j)) {
      const key = String(j.url || '').toLowerCase().replace(/\/+$/, '');
      existingByUrl.set(key, j);
    }
  }

  let added = 0;
  let updated = 0;

  for (const job of discoveredJobs) {
    const key = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const existing = existingByUrl.get(key);
    if (existing) {
      // Update fields but preserve locale data from AI
      existing.title = job.title;
      existing.company = job.company;
      existing.companyKey = job.companyKey;
      existing.location = job.location;
      existing.canton = job.canton;
      existing.country = job.country;
      existing.category = job.category;
      existing.description = job.description;
      existing.descriptionIt = job.descriptionIt;
      existing.postedDate = job.postedDate || existing.postedDate;
      existing.source = job.source;
      // Always merge locale data to preserve AI translations
      existing.slugByLocale = mergeLocaleTextMap(existing.slugByLocale, job.slugByLocale, 3);
      existing.titleByLocale = mergeLocaleTextMap(existing.titleByLocale, job.titleByLocale, 2);
      existing.descriptionByLocale = mergeLocaleTextMap(existing.descriptionByLocale, job.descriptionByLocale, 30);
      updated++;
      existingByUrl.delete(key); // track processed
    } else {
      allJobs.push(job);
      added++;
    }
  }

  // Remove jobs no longer on the website
  const discoveredUrls = new Set(
    discoveredJobs.map((j) => String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  );
  const removed = allJobs.filter(
    (j) =>
      isBancaSempioneJob(j) &&
      !discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  ).length;

  const finalJobs = allJobs.filter(
    (j) =>
      !isBancaSempioneJob(j) ||
      discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  );

  writeJson(DATA_JOBS, finalJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, finalJobs);

  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  ➖ Removed: ${removed}`);
  console.log(`  📦 Total jobs in file: ${finalJobs.length}`);
}

/* ── Adapter update ────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${BANCA_SEMPIONE_KEY}.json`);
  let adapter = {};
  try {
    adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  } catch { /* first run */ }

  const seedMetaByUrl = {};
  for (const url of seedUrls) {
    seedMetaByUrl[url] = {
      company: BANCA_SEMPIONE_COMPANY_NAME,
      companyDomain: 'bancasempione.ch',
    };
  }

  adapter = {
    ...adapter,
    companyKey: BANCA_SEMPIONE_KEY,
    companyName: BANCA_SEMPIONE_COMPANY_NAME,
    companyHost: BANCA_SEMPIONE_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['api'],
    seedUrls,
    seedMetaByUrl,
    notes:
      'WordPress REST API crawler — /wp-json/wp/v2/job. Swiss private bank HQ in Lugano (TI) with offices in Bellinzona, Locarno, Chiasso, and Zurich.',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Run shared crawler for localization ───────────────────── */
async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: BANCA_SEMPIONE_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcessBancaSempioneJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;

  let changed = false;
  const seenKeys = new Map();

  const processed = jobs.filter((job) => {
    if (!isBancaSempioneJob(job)) return true;

    // Canonicalize company fields
    if (job.company !== BANCA_SEMPIONE_COMPANY_NAME) {
      job.company = BANCA_SEMPIONE_COMPANY_NAME;
      changed = true;
    }
    if (job.companyKey !== BANCA_SEMPIONE_KEY) {
      job.companyKey = BANCA_SEMPIONE_KEY;
      changed = true;
    }

    // Deduplicate by URL
    const url = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const dedupKey = url || normalizeKey(job.slug || job.title || '');
    if (seenKeys.has(dedupKey)) return false;
    seenKeys.set(dedupKey, true);

    if (!shouldKeepBancaSempioneJob(job)) {
      changed = true;
      return false;
    }

    return true;
  });

  if (changed || processed.length !== jobs.length) {
    writeJson(DATA_JOBS, processed);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, processed);
    console.log(`🔧 Post-processed: ${jobs.length} → ${processed.length} jobs`);
  }
}

/* ── Stats ─────────────────────────────────────────────────── */
function logStats(before) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const bsJobs = Array.isArray(jobs) ? jobs.filter(isBancaSempioneJob) : [];
  const after = snapshotJobSlugs(bsJobs);
  const diff = computeCrawlDiff(before, after);
  printCrawlChangeSummary(diff, 'Banca del Sempione');
  writeCrawlChangeSummaryToGH(diff, 'Banca del Sempione');

  console.log(`\n🏦 Total Banca del Sempione jobs: ${bsJobs.length}`);
  for (const j of bsJobs) {
    console.log(`  • ${j.title} (${j.location}, ${j.canton || j.country || '?'})`);
  return diff;
  }
}

/* ── Locale validation ─────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BANCA_SEMPIONE_STRICT',
    label: 'Banca del Sempione',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isBancaSempioneJob,
    locales: BANCA_SEMPIONE_LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_bancasempione_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Banca del Sempione jobs found — the company may not have active openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(BANCA_SEMPIONE_KEY, 'Banca del Sempione');
  console.log('═══════════════════════════════════════════════');
  console.log('  Banca del Sempione — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  // Snapshot before
  const beforeMap = snapshotJobSlugs(readExistingCrawlerJobs(BANCA_SEMPIONE_KEY, DATA_JOBS).filter(isBancaSempioneJob))

  // Phase 1: discover jobs via WP REST API
  const discoveredJobs = await fetchBancaSempioneJobs();

  if (discoveredJobs.length === 0) {
    console.log('ℹ️  No job listings found — skipping crawl.');
    return;
  }

  // Phase 2: merge into jobs.json
  const seedUrls = discoveredJobs.map((j) => j.url);
  mergeBancaSempioneJobs(discoveredJobs);

  // Phase 3: update adapter
  updateAdapterConfig(seedUrls);

  // Phase 4: run shared crawler for AI localization
  await runBaseCrawler();

  // Phase 5: post-process
  postProcessBancaSempioneJobs();

  // Phase 6: log stats
  const diff = logStats(beforeMap);

  // Phase 7: locale validation
  validateLocales();

  console.log('✅ Banca del Sempione crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isBancaSempioneJob) : [];
  writeJobsCrawlerSlice(BANCA_SEMPIONE_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: BANCA_SEMPIONE_KEY,
    label: 'Banca del Sempione',
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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('❌ Banca del Sempione crawler failed:', err);
    process.exit(1);
  });
}
