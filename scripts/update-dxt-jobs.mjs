#!/usr/bin/env node
/**
 * Dedicated DXT Commodities S.A. crawler runner.
 *
 * DXT Commodities is an energy/commodity trading company (Duferco Group)
 * headquartered in Lugano, Switzerland, with offices in London, Stamford, and Singapore.
 *
 * The DXT careers page at https://dxt.com/careers/ is a WordPress site using
 * the WPSM accordion plugin. Jobs are listed by location (London, Lugano,
 * Stamford, Singapore) with each location as an accordion group and each
 * job as an accordion panel within the group.
 *
 * There are NO individual job detail page URLs. All job titles and full
 * descriptions are embedded inline in accordion panels on a single page.
 *
 * Discovery flow:
 *   1. Fetch https://dxt.com/careers/ (server-side rendered HTML)
 *   2. Locate the Lugano/Switzerland accordion section(s)
 *   3. Parse each accordion panel: title from <h4> heading, description from panel body
 *   4. Build job objects with synthetic descriptions
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization of descriptions (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH } from './jobs-url-helper.mjs';
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const DXT_KEY = 'dxt-commodities';
const DXT_COMPANY_NAME = 'DXT Commodities S.A.';
const DXT_COMPANY_HOST = 'dxt.com';
const DXT_CAREERS_URL = 'https://dxt.com/careers/';
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Location sections on the DXT careers page, identified by their
 * accordion group IDs. Only Lugano/Switzerland jobs are relevant.
 * The accordion IDs may change — the parser also uses heading text heuristics.
 */
const LUGANO_SECTION_KEYWORDS = ['lugano', 'switzerland', 'svizzera', 'suisse'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
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
  return s.slice(0, 90);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isDxtJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === DXT_KEY ||
    key === 'dxt-commodities-s-a' ||
    key.startsWith('dxt-commodit') ||
    (company.includes('dxt') && company.includes('commodit')) ||
    url.includes('dxt.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'dxt.com' || host.endsWith('.dxt.com');
  } catch {
    return false;
  }
}

/**
 * Generate a stable panel ID from the accordion panel HTML id attribute.
 * e.g. "collapse_20897_1" → "20897-1"
 */
function panelStableId(rawId = '') {
  const m = rawId.match(/(\d+)[_-](\d+)/);
  return m ? `${m[1]}-${m[2]}` : rawId;
}

// ─────────────────────────────────────────────────────────────
// HTML fetching
// ─────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)',
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

// ─────────────────────────────────────────────────────────────
// HTML parsing — extract jobs from the WordPress accordion page
// ─────────────────────────────────────────────────────────────

/**
 * Identify which accordion groups belong to Lugano/Switzerland.
 *
 * The DXT page layout (Divi + WPSM accordion):
 *   <h3 id="lugano">LUGANO-SWITZERLAND</h3>
 *   ... (some wrapper divs) ...
 *   <div id="accordion_pro_XXXXX">
 *     <div class="wpsm_panel" id="offset_XXXXX_N">
 *       <h4 class="wpsm_panel-title"><a ...>Job Title</a></h4>
 *       <div id="collapse_XXXXX_N" class="wpsm_panel-collapse">
 *         <div class="wpsm_panel-body">... description ...</div>
 *       </div>
 *     </div>
 *   </div>
 *
 * We find the region heading, then locate the next accordion_pro_XXXXX after it.
 */
function findLuganoAccordionIds(html) {
  const ids = new Set();

  // Strategy 1: Find <h3> with Lugano/Switzerland text, then find the next accordion_pro_XXXXX
  const headingRe = /<h[23][^>]*>([^<]*(?:lugano|switzerland|svizzera|suisse)[^<]*)<\/h[23]>/gi;
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    // Look for the next accordion_pro_XXXXX after this heading
    const afterHeading = html.slice(m.index + m[0].length, m.index + m[0].length + 3000);
    const accMatch = afterHeading.match(/id="accordion_pro_(\d+)"/);
    if (accMatch) {
      ids.add(accMatch[1]);
    }
  }

  // Strategy 2: If we found nothing, try to match section divs with Lugano-related IDs
  if (ids.size === 0) {
    const sectionRe = /id="(?:lugano|switzerland)"/gi;
    while ((m = sectionRe.exec(html)) !== null) {
      const afterSection = html.slice(m.index, m.index + 5000);
      const accMatch = afterSection.match(/id="accordion_pro_(\d+)"/);
      if (accMatch) {
        ids.add(accMatch[1]);
      }
    }
  }

  return [...ids];
}

/**
 * Parse all job panels from a specific accordion group.
 *
 * Returns an array of { panelId, title, descriptionHtml, descriptionText }.
 * Skips panels with "no open positions" messages.
 */
function parseAccordionPanels(html, accordionGroupId) {
  const jobs = [];

  // Find all panels within this accordion group
  // Pattern: id="offset_GROUPID_N" ... <h4 class="wpsm_panel-title"><a ...>TITLE</a></h4>
  //          ... id="collapse_GROUPID_N" ... <div class="wpsm_panel-body">DESCRIPTION</div>
  const panelRe = new RegExp(
    `id="offset_${accordionGroupId}_(\\d+)"[\\s\\S]*?` +
    `class="[^"]*wpsm_panel-title[^"]*"[^>]*>\\s*<a[^>]*>([\\s\\S]*?)</a>\\s*</h4>[\\s\\S]*?` +
    `id="collapse_${accordionGroupId}_\\1"[\\s\\S]*?` +
    `class="[^"]*wpsm_panel-body[^"]*"[\\s\\S]*?` +
    `class="[^"]*wpsm_panel-body_inner[^"]*"[^>]*>([\\s\\S]*?)</div>\\s*</div>\\s*</div>\\s*</div>`,
    'g'
  );

  let match;
  while ((match = panelRe.exec(html)) !== null) {
    const panelNum = match[1];
    const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();
    const bodyHtml = match[3].trim();

    // Skip panels with no open positions
    if (/no\s+open\s+positions|nessuna\s+posizione/i.test(bodyHtml)) {
      console.log(`  ⏭️  Panel ${accordionGroupId}_${panelNum}: no open positions — skipped`);
      continue;
    }

    // Skip panels with empty titles (also indicates no open positions)
    if (!rawTitle || rawTitle.length < 3) {
      console.log(`  ⏭️  Panel ${accordionGroupId}_${panelNum}: empty title — skipped`);
      continue;
    }

    const title = normalizeSpace(rawTitle);
    const descriptionText = normalizeSpace(stripHtml(bodyHtml));

    jobs.push({
      panelId: `${accordionGroupId}_${panelNum}`,
      title,
      descriptionHtml: bodyHtml,
      descriptionText,
    });
  }

  return jobs;
}

/**
 * Fetch and parse all Lugano-based DXT jobs from the careers page.
 */
async function fetchDxtJobs() {
  console.log(`🔍 Fetching DXT Commodities jobs from ${DXT_CAREERS_URL}`);

  const html = await fetchPage(DXT_CAREERS_URL, 25000);
  if (!html) {
    console.error('❌ Failed to fetch DXT careers page.');
    return [];
  }

  console.log(`  📄 Page fetched (${html.length} chars)`);

  // Find Lugano accordion groups
  const luganoGroupIds = findLuganoAccordionIds(html);
  console.log(`  🗺️  Lugano accordion groups found: ${luganoGroupIds.length} (${luganoGroupIds.join(', ')})`);

  if (luganoGroupIds.length === 0) {
    console.warn('  ⚠️ No Lugano/Switzerland accordion section detected on the page.');
    console.warn('     The page structure may have changed. Check https://dxt.com/careers/ manually.');
    return [];
  }

  // Parse jobs from each Lugano accordion group
  const parsedJobs = [];
  for (const groupId of luganoGroupIds) {
    const panelJobs = parseAccordionPanels(html, groupId);
    console.log(`  📋 Group ${groupId}: ${panelJobs.length} job panels found`);
    parsedJobs.push(...panelJobs);
  }

  if (parsedJobs.length === 0) {
    console.log('  ℹ️ No active Lugano job listings found on DXT careers page.');
    return [];
  }

  // Build job objects
  const jobs = [];
  for (const parsed of parsedJobs) {
    const slug = slugify(parsed.title, 'dxt');
    const canonicalUrl = `${DXT_CAREERS_URL}?panel=${parsed.panelId}`;

    // Build a rich description combining the extracted text with company context
    const descIt = buildDescription(parsed, 'it');
    const descEn = buildDescription(parsed, 'en');

    const job = {
      url: canonicalUrl,
      applyUrl: DXT_CAREERS_URL,
      title: parsed.title,
      company: DXT_COMPANY_NAME,
      companyKey: DXT_KEY,
      location: 'Lugano',
      canton: 'TI',
      country: 'CH',
      description: descEn, // original content is in English
      descriptionByLocale: {
        en: descEn,
        it: descIt,
      },
      titleByLocale: {
        en: parsed.title,
      },
      slug,
      slugByLocale: {
        en: slug,
        it: slugify(parsed.title, 'dxt'),
      },
      category: detectCategory(parsed.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'dxt-careers-crawler',
      employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(parsed.title),
      sector: 'Energia / Trading materie prime',
      _targetScope: { canton: 'TI', location: 'Lugano' },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total unique DXT Lugano jobs discovered: ${jobs.length}`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Description building
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/legal|counsel|lawyer|avvocat/i.test(t)) return 'legal';
  if (/analyst|analista/i.test(t)) return 'finance';
  if (/engineer|developer|sviluppat/i.test(t)) return 'technology';
  if (/trader|trading|trader/i.test(t)) return 'trading';
  if (/intern|stage|stagist/i.test(t)) return 'internship';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager/i.test(t)) return 'SENIOR';
  return 'MID';
}

function buildDescription(parsed, locale = 'en') {
  // The DXT page content is in English — use the raw extracted text as base
  const rawDesc = parsed.descriptionText || '';

  if (locale === 'en') {
    // Append company context
    return `${rawDesc}\n\nDXT Commodities S.A. is an energy and commodity trading company headquartered in Lugano, Switzerland, part of the Duferco Group. The company operates globally with offices in London, Singapore, and Stamford (USA).`.trim();
  }

  if (locale === 'it') {
    // Build an Italian summary — the AI localization will produce a proper translation later
    return `Posizione aperta presso DXT Commodities S.A. a Lugano.\nRuolo: ${parsed.title}.\n\n${rawDesc}\n\nDXT Commodities S.A. è una società di trading di energia e materie prime con sede a Lugano, Svizzera, parte del Gruppo Duferco. L'azienda opera a livello globale con uffici a Londra, Singapore e Stamford (USA).`.trim();
  }

  return rawDesc;
}

// ─────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ─────────────────────────────────────────────────────────────

function canonicalizeUrl(url = '') {
  try {
    return new URL(url).href.replace(/\/$/, '').toLowerCase();
  } catch {
    return normalize(url);
  }
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeDxtJobs(discoveredJobs) {
  const existing = fs.existsSync(DATA_JOBS)
    ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'))
    : [];
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonDxtJobs = allJobs.filter((j) => !isDxtJob(j));
  const existingDxtJobs = allJobs.filter(isDxtJob);

  const existingByUrl = new Map();
  for (const job of existingDxtJobs) {
    existingByUrl.set(canonicalizeUrl(job.url), job);
  }

  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) {
    discoveredByUrl.set(canonicalizeUrl(job.url), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const existing = existingByUrl.get(key);

    if (existing) {
      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        company: DXT_COMPANY_NAME,
        companyKey: DXT_KEY,
        location: discovered.location || existing.location,
        canton: 'TI',
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'dxt-careers-crawler',
        titleByLocale: { ...existing.titleByLocale, ...filterEmpty(discovered.titleByLocale) },
        descriptionByLocale: { ...existing.descriptionByLocale, ...filterEmpty(discovered.descriptionByLocale) },
        slugByLocale: { ...existing.slugByLocale, ...filterEmpty(discovered.slugByLocale) },
      };

      if (discovered.description && discovered.description.length > (existing.description || '').length) {
        updatedJob.description = discovered.description;
      }

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  for (const [url] of existingByUrl) {
    if (!discoveredByUrl.has(url)) {
      removed++;
    }
  }

  // Combine non-DXT jobs with merged DXT jobs
  const final = [...nonDxtJobs, ...merged];

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
  const adapterPath = path.join(ADAPTERS_DIR, `${DXT_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = DXT_KEY;
  adapter.companyName = DXT_COMPANY_NAME;
  adapter.companyHost = DXT_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [DXT_CAREERS_URL];
  adapter.notes = 'WordPress + WPSM accordion at dxt.com/careers/ — job listings extracted directly from inline accordion panels, no individual detail pages.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${DXT_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: DXT_KEY,
    localizeOnlyCompanyKeys: DXT_KEY,
    forceLocalizeKeys: DXT_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessDxtJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isDxtJob(job)) continue;

    if (job.company !== DXT_COMPANY_NAME) {
      job.company = DXT_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== DXT_KEY) {
      job.companyKey = DXT_KEY;
      fixed++;
    }
    job.canton = 'TI';
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Lugano';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} DXT jobs (fixed company/location/canton).`);
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
  const dxtJobs = allJobs.filter(isDxtJob);

  console.log(`\n📊 === DXT Commodities S.A. Job Stats ===`);
  console.log(`  🏢 Total DXT Lugano jobs: ${dxtJobs.length}`);

  if (dxtJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of dxtJobs) {
      console.log(`     - ${job.title} (${job.location || 'Lugano'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(dxtJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'DXT Commodities');
  writeCrawlChangeSummaryToGH(crawlDiff, 'DXT Commodities');
  return { total: dxtJobs.length };
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DXT_STRICT',
    label: 'DXT Commodities',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDxtJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_dxt_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No DXT Commodities jobs found — the company may not have active openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  DXT Commodities S.A. — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${DXT_CAREERS_URL}\n`);

  // Snapshot before
  let beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isDxtJob) : []);
    } catch { /* ignore */ }
  }

  // Phase 1: Fetch and parse jobs from DXT careers page
  const discoveredJobs = await fetchDxtJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No DXT Lugano jobs discovered.');
    console.log('   The careers page may have changed structure or have no current openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    logStats(beforeSnapshot);
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeDxtJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of DXT jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessDxtJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No DXT jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ DXT Commodities crawler complete.');
}

main().catch((err) => {
  console.error(`❌ DXT Commodities crawler failed: ${err?.message || err}`);
  process.exit(1);
});
