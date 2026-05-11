#!/usr/bin/env node
/**
 * Dedicated Caseificio del Gottardo crawler runner.
 *
 * Caseificio dimostrativo del Gottardo SA is a cheese-making demonstration
 * factory in Airolo (TI), offering dairy-related positions and apprenticeships.
 *
 * Job postings are listed at:
 *   https://www.caseificiodelgottardo.ch/Offerte-di-impiego-e-tirocinio
 *
 * Discovery flow:
 *   1. Fetch the listings page
 *   2. Parse job cards: category label + title + location + detail link
 *   3. Optionally fetch detail pages for full descriptions
 *   4. Merge into data/jobs.json (add new, update existing, prune stale)
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'caseificio-gottardo';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Caseificio dimostrativo del Gottardo SA';
const COMPANY_HOST = 'www.caseificiodelgottardo.ch';
const CAREERS_URL = 'https://www.caseificiodelgottardo.ch/Offerte-di-impiego-e-tirocinio';
const BASE_URL = 'https://www.caseificiodelgottardo.ch/';
const LOCALES = ['it', 'en', 'de', 'fr'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
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

function decodeHtmlEntities(html = '') {
  return String(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#039;/gi, "'")
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '\u2019');
}

function stripHtml(html = '') {
  return decodeHtmlEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function isTargetJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === COMPANY_KEY ||
    key.startsWith('caseificio-gottardo') ||
    key.includes('caseificio-del-gottardo') ||
    (company.includes('caseificio') && company.includes('gottardo')) ||
    url.includes('caseificiodelgottardo.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.caseificiodelgottardo.ch' || host === 'caseificiodelgottardo.ch';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// HTML fetching
// ─────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; FrontaliereBot/1.0; +https://frontaliereticino.ch)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return '';
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// Job listing parsing
// ─────────────────────────────────────────────────────────────

/**
 * Parse the job listings page.
 *
 * Each job card follows this structure:
 *   <category label> (Posti di tirocinio | Offerte d'impiego)
 *   <title text>
 *   <location – percentage>
 *   <optional extra info>
 *   <a href="IT/...">Più informazioni</a>
 */
function parseListingPage(html) {
  const jobs = [];

  // Match each job block: category label through "Più informazioni" link
  const pattern =
    /((?:Posti di tirocinio|Offerte d.impiego)[\s\S]*?)<a[^>]*href="([^"]+)"[^>]*>\s*Più informazioni/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const block = match[1];
    const relativeUrl = match[2];

    // Strip HTML tags, decode entities
    const text = decodeHtmlEntities(
      block
        .replace(/<[^>]+>/g, '|')
        .replace(/\|+/g, '|')
    );
    const parts = text
      .split('|')
      .map((p) => normalizeSpace(p))
      .filter(Boolean);

    if (parts.length < 2) continue;

    // First part is category label, second is title
    const category = parts[0];
    const title = parts[1];
    if (!title) continue;

    // Location is typically the third part (e.g., "6780 Airolo – Impiego al 100%")
    const locationPart = parts[2] || '';

    // Build full URL for detail page
    let detailUrl = relativeUrl;
    if (!detailUrl.startsWith('http')) {
      detailUrl = `${BASE_URL}${detailUrl.replace(/^\//, '')}`;
    }

    jobs.push({
      title,
      category,
      location: locationPart,
      detailUrl,
    });
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Detail page fetching
// ─────────────────────────────────────────────────────────────

async function fetchDetailDescription(url) {
  const html = await fetchPage(url);
  if (!html) return '';

  // Extract main content — find the area after the title heading
  // The page has the job title as an H1, then content divs with the description
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleText = titleMatch ? stripHtml(titleMatch[1]).trim() : '';

  // Try to extract the main content body
  // Look for the content between the header section and the footer contact section
  const contentMatch = html.match(
    /class="[^"]*content[^"]*"[^>]*>([\s\S]*?)(?=Caseificio dimostrativo del Gottardo|<footer|class="[^"]*footer)/i
  );

  let description = '';
  if (contentMatch) {
    description = stripHtml(contentMatch[1]);
  } else {
    // Fallback: extract all text after h1 title until footer
    const afterTitle = html.split(/<\/h1>/i).slice(1).join('');
    const beforeFooter = afterTitle.split(/Caseificio dimostrativo del Gottardo SA/i)[0] || afterTitle;
    description = stripHtml(beforeFooter);
  }

  // Clean up CSS/JS noise that may leak through
  description = description
    .replace(/\.Menu_[^}]+\}/g, '')
    .replace(/@[\w-]+keyframes[^}]+\}/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s{3,}/g, '\n\n')
    .trim();

  // Limit length
  if (description.length > 3000) {
    description = description.slice(0, 3000) + '…';
  }

  return description || `${titleText}\n\nPer maggiori dettagli, consultare la pagina dell'offerta.`;
}

// ─────────────────────────────────────────────────────────────
// Description building
// ─────────────────────────────────────────────────────────────

function buildFallbackDescription(title, category, locationInfo) {
  const parts = [];

  const categoryLabel =
    /tirocinio/i.test(category) ? 'posto di tirocinio' : 'offerta di impiego';

  parts.push(
    `Caseificio dimostrativo del Gottardo SA pubblica il seguente ${categoryLabel}: ${title}.`
  );
  if (locationInfo) {
    parts.push(`Sede: ${locationInfo}`);
  }
  parts.push('');
  parts.push('Per i dettagli completi, consultare la pagina dell\'offerta.');
  parts.push('');
  parts.push('Settore: Industria lattiero-casearia / Alimentare');
  parts.push('Sede aziendale: Via Fontana 3, 6780 Airolo (TI), Svizzera');
  parts.push('Contatto: direzione@cdga.ch | Tel. +41 91 869 11 80');

  return parts.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────
// Category & experience detection
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '', categoryLabel = '') {
  const t = normalize(title);
  if (/apprendist|tirocinio|afc|cfp|formazione/i.test(t) || /tirocinio/i.test(categoryLabel))
    return 'apprenticeship';
  if (/tecnologo|casaro|latte|formaggio|caseario/i.test(t)) return 'production';
  if (/contabil|finanz|amministra/i.test(t)) return 'admin';
  if (/vendita|shop|negozio|commerc/i.test(t)) return 'sales';
  if (/ristoran|cuoc|cucin|servizio/i.test(t)) return 'hospitality';
  if (/pulizia|manutenz/i.test(t)) return 'operations';
  if (/stage|stagiaire|stagist/i.test(t)) return 'internship';
  return 'general';
}

function detectExperienceLevel(title = '', categoryLabel = '') {
  const t = normalize(title);
  if (/apprendist|tirocinio|afc|cfp|stage|stagist|stagiaire|aiuto/i.test(t) || /tirocinio/i.test(categoryLabel))
    return 'ENTRY';
  if (/senior|capo|dirett|manager|head|responsabile/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(title = '', locationInfo = '') {
  const combined = `${title} ${locationInfo}`;
  if (/100\s*%|full[\s-]?time/i.test(combined)) return 'FULL_TIME';
  if (/part[\s-]?time|50%|60%|70%|80%/i.test(combined)) return 'PART_TIME';
  if (/tirocinio|apprendist/i.test(combined)) return 'APPRENTICESHIP';
  return 'FULL_TIME';
}

// ─────────────────────────────────────────────────────────────
// Main discovery
// ─────────────────────────────────────────────────────────────

async function fetchCaseificioJobs() {
  console.log(`📡 Fetching careers page: ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL);
  if (!html) {
    console.warn('⚠️ Failed to fetch careers page.');
    return [];
  }

  const listings = parseListingPage(html);
  console.log(`📋 Found ${listings.length} offerta(e) on page.`);

  const seenUrls = new Set();
  const jobs = [];

  for (const listing of listings) {
    // Deduplicate by detail URL
    if (seenUrls.has(listing.detailUrl)) {
      console.log(`  ⏭️  Skipping duplicate: ${listing.title}`);
      continue;
    }
    seenUrls.add(listing.detailUrl);

    console.log(`  📄 Processing: ${listing.title}`);

    // Fetch detail page for full description
    let description = '';
    try {
      description = await fetchDetailDescription(listing.detailUrl);
    } catch (err) {
      console.warn(`  ⚠️  Could not fetch detail page: ${err?.message || err}`);
    }

    if (!description || description.length < 50) {
      description = buildFallbackDescription(listing.title, listing.category, listing.location);
    }

    const slug = slugify(listing.title, COMPANY_KEY);

    const job = {
      title: listing.title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location: 'Airolo',
      canton: HQ.canton,
      country: 'CH',
      url: listing.detailUrl,
      applyUrl: listing.detailUrl,
      description,
      category: detectCategory(listing.title, listing.category),
      sector: 'Industria lattiero-casearia / Alimentare',
      employmentType: detectEmploymentType(listing.title, listing.location),
      experienceLevel: detectExperienceLevel(listing.title, listing.category),
      source: 'caseificio-gottardo-crawler',
      postedDate: new Date().toISOString().slice(0, 10),
      titleByLocale: { it: listing.title },
      descriptionByLocale: { it: description },
      slugByLocale: { it: slug },
      sourceLang: detectLang(description || listing.title, 'it'),
      _targetScope: { canton: HQ.canton, location: 'Airolo' },
    };

    jobs.push(job);
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────

function jobMatchKey(job) {
  return `${slugify(job.title)}-${COMPANY_KEY}`;
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonTargetJobs = allJobs.filter((j) => !isTargetJob(j));
  const existingTargetJobs = allJobs.filter(isTargetJob);

  const existingByKey = new Map();
  for (const job of existingTargetJobs) {
    existingByKey.set(jobMatchKey(job), job);
  }

  const discoveredByKey = new Map();
  for (const job of discoveredJobs) {
    discoveredByKey.set(jobMatchKey(job), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = jobMatchKey(discovered);
    const ex = existingByKey.get(key);

    if (ex) {
      const updatedJob = {
        ...ex,
        title: discovered.title || ex.title,
        company: COMPANY_NAME,
        companyKey: COMPANY_KEY,
        location: discovered.location || ex.location,
        canton: HQ.canton,
        country: 'CH',
        url: discovered.url || ex.url,
        applyUrl: discovered.applyUrl || ex.applyUrl,
        category: discovered.category || ex.category,
        sector: discovered.sector || ex.sector,
        source: 'caseificio-gottardo-crawler',
        titleByLocale: mergeLocaleTextMap(ex.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(ex.slugByLocale, discovered.slugByLocale, 3),
      };

      if (
        discovered.description &&
        discovered.description.length > (ex.description || '').length
      ) {
        updatedJob.description = discovered.description;
      }

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  for (const [key] of existingByKey) {
    if (!discoveredByKey.has(key)) removed++;
  }

  const final = [...nonTargetJobs, ...merged];

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

// ─────────────────────────────────────────────────────────────
// Adapter management
// ─────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = COMPANY_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [CAREERS_URL];
  adapter.notes =
    'Custom CMS — job cards with category labels, titles, and "Più informazioni" detail links.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '10',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '10',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isTargetJob(job)) continue;

    if (job.company !== COMPANY_NAME) {
      job.company = COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== COMPANY_KEY) {
      job.companyKey = COMPANY_KEY;
      fixed++;
    }
    job.canton = HQ.canton;
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Airolo';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🔧 Post-processed ${fixed} Caseificio del Gottardo jobs (fixed company/location/canton).`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Stats & validation
// ─────────────────────────────────────────────────────────────

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const targetJobs = allJobs.filter(isTargetJob);

  console.log(`\n📊 === Caseificio del Gottardo Job Stats ===`);
  console.log(`  🧀 Total Caseificio del Gottardo jobs: ${targetJobs.length}`);

  if (targetJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Airolo'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Caseificio del Gottardo');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Caseificio del Gottardo');
  return { total: targetJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CASEIFICIO_GOTTARDO_STRICT',
    label: 'Caseificio del Gottardo',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_caseificio_gottardo_domain',
    failWhenNoJobs: false,
    noJobsMessage:
      'No Caseificio del Gottardo jobs found — the company may not have active openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Caseificio del Gottardo');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Caseificio del Gottardo — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching Caseificio del Gottardo jobs...');

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchCaseificioJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Caseificio del Gottardo jobs discovered.');
    console.log(
      '   The careers page may have changed structure or have no current openings.'
    );
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization
  console.log(
    '\n🌐 Running base crawler for AI localization of Caseificio del Gottardo jobs...'
  );
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log(
      'ℹ️ No Caseificio del Gottardo jobs found after crawl. No error — exiting OK.'
    );
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Caseificio del Gottardo crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Caseificio del Gottardo',
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
  console.error(`❌ Caseificio del Gottardo crawler failed: ${err?.message || err}`);
  process.exit(1);
});
