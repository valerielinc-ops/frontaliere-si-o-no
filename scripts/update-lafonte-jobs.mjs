#!/usr/bin/env node
/**
 * Dedicated Fondazione La Fonte crawler runner.
 *
 * Fondazione La Fonte is a social services foundation in Lugano, Ticino,
 * that supports people with disabilities through housing, workshops,
 * and professional training programs.
 *
 * Jobs are listed on the HubSpot-powered careers page at:
 *   https://www.lafonte.ch/inizia-con-noi
 *
 * Discovery flow:
 *   1. Fetch the single careers page
 *   2. Parse job listings from <div class="pwr-simple-list-item"> blocks
 *   3. Extract title, location, and description from inline HTML
 *   4. Build job objects with structured descriptions
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  htmlToMarkdown,
  validateLaFonteDescription,
} from './lib/lafonte-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'la-fonte';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Fondazione La Fonte';
const COMPANY_HOST = 'www.lafonte.ch';
const CAREERS_URL = 'https://www.lafonte.ch/inizia-con-noi';
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
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"');
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
    key === 'fondazione-la-fonte' ||
    key.startsWith('la-fonte') ||
    (company.includes('la fonte') && company.includes('fondazione')) ||
    (url.includes('lafonte.ch'))
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'lafonte.ch' || host === 'www.lafonte.ch';
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
 * Parse the HubSpot-powered careers page.
 *
 * Each job card is a <div class="pwr-simple-list-item"> block containing:
 *  - Location after the SVG map icon: </svg></span></span>Location Text</div>
 *  - Title in <h4><strong>Title</strong></h4>
 *  - Description in <span class="pwr-rich-text pwr-simple-list-item__desc">HTML</span>
 */
function parseListingPage(html) {
  const jobs = [];

  // Split by job card blocks
  const cardRegex =
    /<div\s+class="pwr-simple-list-item\s+pwr-simple-list-item--text-style[^"]*"[^>]*>([\s\S]*?)(?=<div\s+class="pwr-simple-list-item\s|<div\s+class="pwr-adc-content|$)/gi;

  let m;
  while ((m = cardRegex.exec(html)) !== null) {
    const block = m[1];

    // Extract location: text between closing SVG/spans and </div>
    const locMatch = block.match(
      /<\/svg><\/span><\/span>([\s\S]*?)<\/div>/i
    );
    const location = locMatch ? normalizeSpace(stripHtml(locMatch[1])) : 'Lugano';

    // Extract title from <h4><strong>...</strong></h4>
    const titleMatch = block.match(/<h4>\s*<strong>([\s\S]*?)<\/strong>\s*<\/h4>/i);
    if (!titleMatch) continue;  // Skip if no title found
    const title = normalizeSpace(stripHtml(titleMatch[1]));
    if (!title) continue;

    // Extract description from <span class="pwr-rich-text pwr-simple-list-item__desc">
    const descMatch = block.match(
      /<span\s+class="pwr-rich-text\s+pwr-simple-list-item__desc">([\s\S]*?)<\/span>\s*<\/div>/i
    );
    const rawDescHtml = descMatch ? descMatch[1] : '';
    const detail = htmlToMarkdown(rawDescHtml);
    const rawDesc = detail.markdown;

    // Validate quality
    const validation = validateLaFonteDescription(detail);
    if (!validation.ok) {
      console.warn(`  ⚠️ Quality warnings for "${title}":`);
      for (const w of validation.warnings) console.warn(`    - ${w}`);
    }

    jobs.push({ title, location, rawDesc, _descDetail: detail });
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Description building
// ─────────────────────────────────────────────────────────────

function buildDescription(title, location, rawDesc) {
  const parts = [];

  parts.push(`## Descrizione`);
  parts.push(
    `${COMPANY_NAME}, con sede a Lugano (TI), è alla ricerca di: ${title}.`
  );
  parts.push('');

  if (rawDesc) {
    // Insert the structured markdown content
    parts.push(rawDesc);
    parts.push('');
  }

  parts.push(`## Mansioni`);
  if (!rawDesc || rawDesc.length < 100) {
    parts.push(`Contattare ${COMPANY_NAME} per i dettagli della posizione.`);
  }

  parts.push('');
  parts.push(`**Settore:** Servizi sociali / Assistenza disabilità`);
  parts.push(`**Sede:** Via A. Giacometti 1, 6900 Lugano (TI), Svizzera`);
  if (location && location !== 'Lugano') {
    parts.push(`**Luogo di lavoro:** ${location}`);
  }
  parts.push(`**Candidatura:** recruiting@lafonte.ch`);

  return parts.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────
// Category & experience detection
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/contabil|finanzi|amministra|conteg/i.test(t)) return 'admin';
  if (/stage|stagiaire|stagist/i.test(t)) return 'internship';
  if (/apprendist|afc|cfp|formazione/i.test(t)) return 'apprenticeship';
  if (/operatore|operatrice|socioassistenziale|assistente|educatore/i.test(t))
    return 'social-services';
  if (/infermier|medico|sanitar/i.test(t)) return 'healthcare';
  if (/cuoco|cucina|panettier|pasticcer|fornaio/i.test(t)) return 'hospitality';
  if (/responsabile|dirett|manager|coordinat/i.test(t)) return 'management';
  return 'general';
}

function detectExperienceLevel(title = '', rawDesc = '') {
  const t = normalize(title);
  const d = normalize(rawDesc);
  if (/apprendist|afc|cfp|stage|stagist|stagiaire|junior/i.test(t)) return 'ENTRY';
  if (/senior|responsabile|capo|dirett|manager|head|esperienza.*anni/i.test(t))
    return 'SENIOR';
  if (/esperienza.*(?:3|4|5)\s*anni/i.test(d)) return 'MID';
  return 'ENTRY';
}

function detectEmploymentType(title = '', rawDesc = '') {
  const combined = `${title} ${rawDesc}`;
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (pctMatch) {
    const max = parseInt(pctMatch[2], 10);
    return max >= 100 ? 'FULL_TIME' : 'PART_TIME';
  }
  if (/100\s*%|full[\s-]?time/i.test(combined)) return 'FULL_TIME';
  if (/part[\s-]?time|50%|60%|70%|80%/i.test(combined)) return 'PART_TIME';
  if (/stage|stagiaire/i.test(combined)) return 'INTERN';
  if (/apprendist/i.test(combined)) return 'FULL_TIME';
  return 'FULL_TIME';
}

// ─────────────────────────────────────────────────────────────
// Main discovery
// ─────────────────────────────────────────────────────────────

async function fetchLaFonteJobs() {
  console.log(`📡 Fetching careers page: ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL);
  if (!html) {
    console.warn('⚠️ Failed to fetch careers page.');
    return [];
  }

  const listings = parseListingPage(html);
  console.log(`📋 Found ${listings.length} job listing(s) on page.`);

  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.title} (${listing.location})`);

    const description = buildDescription(
      listing.title,
      listing.location,
      listing.rawDesc
    );

    // Normalize location to the primary city
    const locationCity = listing.location
      .replace(/Regione del\s+/i, '')
      .replace(/\s+e\s+/i, ', ')
      .trim() || 'Lugano';

    // Build location-aware slug
    const locationSuffix = locationCity
      ? `${COMPANY_KEY}-${slugify(locationCity)}`
      : COMPANY_KEY;
    const slug = slugify(listing.title, locationSuffix);

    // Each job needs a unique URL for dedup in the base crawler's fingerprintJob(),
    // which uses canonicalizeJobUrl (strips hashes but preserves query params).
    const jobUrl = `${CAREERS_URL}?role=${encodeURIComponent(slug)}`;

    const job = {
      title: listing.title,
      slug,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location: locationCity,
      canton: HQ.canton,
      country: 'CH',
      url: jobUrl,
      applyUrl: 'mailto:recruiting@lafonte.ch',
      description,
      category: detectCategory(listing.title),
      sector: 'Servizi sociali / Non-profit',
      employmentType: detectEmploymentType(listing.title, listing.rawDesc),
      experienceLevel: detectExperienceLevel(listing.title, listing.rawDesc),
      source: 'la-fonte-crawler',
      postedDate: new Date().toISOString().slice(0, 10),
      titleByLocale: { it: listing.title },
      descriptionByLocale: { it: description },
      slugByLocale: { it: slug },
      sourceLang: detectLang(description || listing.title, 'it'),
      _targetScope: { canton: HQ.canton, location: 'Lugano' },
    };

    jobs.push(job);
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────

function jobMatchKey(job) {
  // Use slugified title + company key as match key since all jobs share the same URL
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
        applyUrl: discovered.applyUrl || ex.applyUrl,
        category: discovered.category || ex.category,
        sector: discovered.sector || ex.sector,
        source: 'la-fonte-crawler',
        titleByLocale: mergeLocaleTextMap(ex.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(ex.slugByLocale, discovered.slugByLocale, 3),
      };

      if (
        discovered.description &&
        discovered.description.length > (ex.description || '').length
      ) {
        updatedJob.description = discovered.description;
        // Clear stale locale translations when description changes significantly
        const prevLen = (ex.description || '').length;
        const newLen = discovered.description.length;
        if (Math.abs(newLen - prevLen) > 100) {
          updatedJob.descriptionByLocale = {
            ...filterEmpty(discovered.descriptionByLocale),
          };
        }
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
    'HubSpot CMS — single careers page with inline job cards (pwr-simple-list-item blocks).';
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
      job.location = 'Lugano';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🔧 Post-processed ${fixed} La Fonte jobs (fixed company/location/canton).`
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

  console.log(`\n📊 === Fondazione La Fonte Job Stats ===`);
  console.log(`  🏢 Total La Fonte jobs: ${targetJobs.length}`);

  if (targetJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Lugano'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'La Fonte');
  writeCrawlChangeSummaryToGH(crawlDiff, 'La Fonte');
  return { total: targetJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LA_FONTE_STRICT',
    label: 'La Fonte',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_lafonte_domain',
    failWhenNoJobs: false,
    noJobsMessage:
      'No La Fonte jobs found — the foundation may not have active openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'La Fonte');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Fondazione La Fonte — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching La Fonte jobs...');

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchLaFonteJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No La Fonte jobs discovered.');
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
    '\n🌐 Running base crawler for AI localization of La Fonte jobs...'
  );
  await runBaseCrawler();

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Phase 5: Post-process
  postProcessJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log(
      'ℹ️ No La Fonte jobs found after crawl. No error — exiting OK.'
    );
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Fondazione La Fonte crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'La Fonte',
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
  console.error(`❌ La Fonte crawler failed: ${err?.message || err}`);
  process.exit(1);
});
