#!/usr/bin/env node
/**
 * Dedicated Rivopharm SA crawler runner.
 *
 * Rivopharm SA is a Swiss pharmaceutical company headquartered in Manno, Canton Ticino.
 * Founded in 1961, it specialises in generic pharmaceuticals (psychiatric,
 * antidepressant, anti-inflammatory, epilepsy, diabetes medications).
 * ~200 employees, operating in over 50 countries.
 *
 * Career page: https://www.rivopharm.ch/ (no public careers page as of 2026-05-13;
 * site migrated from rivopharm.com to rivopharm.ch and dropped the careers section).
 *
 * Note (2026-05-13): both the old `.com` site (now 404) and the new `.ch` site
 * lack a public careers landing. The new WordPress install silently rewrites
 * unknown paths (e.g. `/careers`) to the homepage with HTTP 200, so we must
 * verify the response actually contains job content before parsing — otherwise
 * the parser would happily extract homepage marketing headings as fake "jobs".
 * Until Rivopharm publishes openings again (likely on LinkedIn or a third-party
 * ATS), this crawler writes an empty slice.
 *
 * Discovery flow:
 *   1. Fetch the careers page HTML
 *   2. Parse job listings from the HTML
 *   3. Build job objects with metadata
 *   4. Merge into data/jobs.json
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang } from './lib/dedicated-crawler-common.mjs';
import { parseRivopharmJobs, slugify, normalizeSpace, htmlToText } from './lib/rivopharm-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'rivopharm';
const HQ = getCompanyDefaults('rivopharm');
const COMPANY_NAME = 'Rivopharm SA';
const COMPANY_HOST = 'rivopharm.ch';
/**
 * Rivopharm's career page URLs to try, in order of preference.
 *
 * As of 2026-05-13 the site (`rivopharm.ch`, migrated from the now-404
 * `rivopharm.com`) has no public careers section — the sitemap lists only
 * Chi Siamo / Pazienti / Prodotti / Download Center / Contatti. WordPress
 * rewrites unknown paths to the homepage with HTTP 200, so the response
 * needs job-content sniffing (see `looksLikeCareersPage()`).
 *
 * We keep an ordered fallback list so the crawler self-recovers as soon as
 * Rivopharm publishes a real careers page on any of these slugs.
 */
const CAREERS_URLS = [
  'https://www.rivopharm.ch/lavora-con-noi/',
  'https://www.rivopharm.ch/carriere/',
  'https://www.rivopharm.ch/careers/',
  'https://www.rivopharm.ch/jobs/',
  'https://www.rivopharm.ch/posizioni-aperte/',
  'https://www.rivopharm.ch/it/lavora-con-noi/',
  'https://www.rivopharm.ch/de/karriere/',
  'https://www.rivopharm.ch/fr/carrieres/',
];
const CAREERS_URL = CAREERS_URLS[0]; // primary for display/config
const LOCALES = ['it', 'en', 'de', 'fr'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isRivopharmJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === COMPANY_KEY ||
    key.startsWith('rivopharm') ||
    company.includes('rivopharm') ||
    url.includes('rivopharm.ch') ||
    url.includes('rivopharm.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Accept current .ch domain (post-migration) and legacy .com (in case
    // redirects come back online or historical jobs still reference it).
    return (
      host === 'rivopharm.ch' ||
      host.endsWith('.rivopharm.ch') ||
      host === 'rivopharm.com' ||
      host.endsWith('.rivopharm.com')
    );
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/engineer|developer|software|it\b|system|data/i.test(t)) return 'technology';
  if (/qa|quality|validation|compliance|regulator/i.test(t)) return 'quality';
  if (/scientist|research|r&d|laboratory|lab\b|clinical/i.test(t)) return 'science';
  if (/produc|manufactur|operator|technic/i.test(t)) return 'production';
  if (/sales|commercial|marketing|communication/i.test(t)) return 'sales';
  if (/legal|counsel/i.test(t)) return 'legal';
  if (/account|financ|controller|audit/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/logistic|supply|warehouse|procurement/i.test(t)) return 'logistics';
  if (/pharma|formul|galenic|packaging|batch/i.test(t)) return 'pharma';
  if (/manag|director|head|lead|chief/i.test(t)) return 'management';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagist|apprenti/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief/i.test(t)) return 'SENIOR';
  return 'MID';
}

// ─────────────────────────────────────────────────────────────
// Fetch careers page
// ─────────────────────────────────────────────────────────────

/**
 * Heuristic: does the response body actually look like a careers / jobs page?
 *
 * The new rivopharm.ch WordPress install rewrites unknown URLs (e.g. `/careers`,
 * `/jobs`) to the homepage with HTTP 200, returning the corporate brochure. We
 * must reject those responses to avoid parsing homepage marketing copy as fake
 * "job listings". A page qualifies as a careers page if it contains at least one
 * careers-indicating keyword AND a structural job listing token (offer card,
 * application CTA, position list, etc.).
 */
function looksLikeCareersPage(html = '', sourceUrl = '') {
  if (!html || typeof html !== 'string') return false;
  // The homepage `<title>` is "Swiss Pharma Solutions | Rivopharm" — a careers
  // page would replace it with something like "Carriere | Rivopharm" or
  // "Lavora con noi | Rivopharm".
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].toLowerCase() : '';
  const titleHasCareerTerm = /(career|carrier|carrière|lavora|posizion|position|vacanc|jobs?|offerte|stell|karrier|recruit|hiring|opportun|join\s+(?:us|our\s+team))/i.test(title);

  const body = html.toLowerCase();
  const hasKeyword = /(posizioni\s+aperte|open\s+positions|lavora\s+con\s+noi|join\s+our\s+team|join\s+us|apply\s+now|candidat|invia\s+il\s+tuo\s+cv|send\s+your\s+cv|career\s+opportunit|offerte\s+di\s+lavoro|vacanc|stellenangebot|karriere)/i.test(body);
  const hasStructuralCue = /(class="[^"]*job[^"]*"|class="[^"]*position[^"]*"|class="[^"]*vacancy[^"]*"|class="[^"]*career[^"]*"|<form[^>]*[^>]*(?:job|candidat|career))/i.test(html);

  // Be liberal: accept either a clearly careers-themed <title>, OR a keyword
  // + structural cue combo. Either signal alone (e.g. "Apply now" in a privacy
  // boilerplate) is too weak.
  if (titleHasCareerTerm) return true;
  if (hasKeyword && hasStructuralCue) return true;
  return false;
}

async function fetchCareersPage() {
  const timeoutMs = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '15000', 10);
  const headers = {
    'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
      'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en,it-CH;q=0.9',
  };

  // Try each candidate URL until one succeeds AND looks like a careers page
  for (const url of CAREERS_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal, headers });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`  ⚠️ HTTP ${res.status} for ${url}`);
        continue;
      }
      const html = await res.text();
      if (!looksLikeCareersPage(html, url)) {
        // WordPress soft-404: fetched OK but content is homepage / unrelated.
        console.warn(`  ⚠️ HTTP 200 for ${url} but body does not look like a careers page (likely WP soft-404 → homepage).`);
        continue;
      }
      console.log(`  ✅ Found working career page: ${url}`);
      return html;
    } catch (err) {
      console.warn(`  ⚠️ Fetch failed for ${url}: ${err.message}`);
    }
  }

  console.warn('⚠️ All Rivopharm career page URLs returned errors or non-careers responses.');
  console.warn('   The company does not appear to have an active public careers page.');
  console.warn('   (As of 2026-05-13: rivopharm.ch sitemap exposes only 5 corporate pages, no /careers.)');
  return null;
}

// ─────────────────────────────────────────────────────────────
// Build job objects
// ─────────────────────────────────────────────────────────────

/**
 * Reject titles that are clearly NOT job listings — company names, slogans, etc.
 */
function isRealJobTitle(title = '') {
  if (!title || title.length < 5) return false;
  const t = title.toLowerCase().trim();
  // Reject company names / homepage headings
  if (/^rivopharm\b/i.test(t)) return false;
  if (/^about\s/i.test(t)) return false;
  if (/^welcome\b/i.test(t)) return false;
  if (/^home\b/i.test(t)) return false;
  // Reject if title is just the company domain or brand
  if (t === 'rivopharm' || t === 'rivopharm sa' || t === 'rivopharm international') return false;
  return true;
}

function buildJobFromParsed(parsed) {
  const title = parsed.title;
  if (!isRealJobTitle(title)) return null;
  const slug = slugify(title, 'rivopharm-sa');
  const descEn = parsed.descriptionText || `${title} position at Rivopharm SA in Manno, Canton Ticino, Switzerland.`;
  const descIt = `Posizione aperta presso Rivopharm SA a Manno, Cantone Ticino.\nRuolo: ${title}.\n\nRivopharm SA è un'azienda farmaceutica svizzera con sede a Manno, specializzata in farmaci generici.`;
  const url = parsed.url
    ? (parsed.url.startsWith('http') ? parsed.url : `https://www.rivopharm.ch${parsed.url.startsWith('/') ? '' : '/'}${parsed.url}`)
    : CAREERS_URL;

  return {
    url,
    applyUrl: url,
    title,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    location: parsed.location || 'Manno',
    canton: HQ.canton,
    country: 'CH',
    postalCode: HQ.postalCode,
    streetAddress: 'Via Cantonale 103',
    addressLocality: parsed.location || 'Manno',
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    description: descEn,
    descriptionByLocale: { en: descEn, it: descIt },
    titleByLocale: { en: title },
    slug,
    slugByLocale: { en: slug, it: slugify(title, 'rivopharm-sa') },
    category: detectCategory(title),
    datePosted: new Date().toISOString().split('T')[0],
    source: 'rivopharm-html-crawler',
    employmentType: 'FULL_TIME',
    experienceLevel: detectExperienceLevel(title),
    sector: 'Farmaceutica / Generici',
    _targetScope: { canton: HQ.canton, location: parsed.location || 'Manno' },
    sourceLang: detectLang(descEn || title, 'en'),
  };
}

// ─────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ─────────────────────────────────────────────────────────────

function canonicalizeUrl(url = '') {
  try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); }
  catch { return normalize(url); }
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
  const nonCompanyJobs = allJobs.filter((j) => !isRivopharmJob(j));
  const existingCompanyJobs = allJobs.filter(isRivopharmJob);
  const existingByUrl = new Map();
  for (const job of existingCompanyJobs) existingByUrl.set(canonicalizeUrl(job.url), job);
  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) discoveredByUrl.set(canonicalizeUrl(job.url), job);

  let added = 0, updated = 0, removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const existing = existingByUrl.get(key);
    if (existing) {
      merged.push({
        ...existing,
        title: discovered.title || existing.title,
        company: COMPANY_NAME, companyKey: COMPANY_KEY,
        location: discovered.location || existing.location,
        canton: HQ.canton, country: 'CH',
        source: 'rivopharm-html-crawler',
        sourceLang: discovered.sourceLang || existing.sourceLang,
        titleByLocale: mergeLocaleTextMap(existing.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existing.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existing.slugByLocale, discovered.slugByLocale, 3),
      });
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }
  for (const [url] of existingByUrl) { if (!discoveredByUrl.has(url)) removed++; }

  const final = [...nonCompanyJobs, ...merged];
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
// Adapter, base crawler, post-process, stats, validation
// ─────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const adapter = fs.existsSync(adapterPath) ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) : {};
  adapter.companyKey = COMPANY_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [CAREERS_URL];
  adapter.notes = 'Custom HTML parser on rivopharm.ch — Manno TI. Site migrated from .com → .ch (May 2026) and currently has no public careers page; crawler writes an empty slice until openings reappear.';
  adapter.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    localizeExistingOnly: true,
    extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '30', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '30' },
  });
}

function postProcess() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;
  for (const job of jobs) {
    if (!isRivopharmJob(job)) continue;
    if (job.company !== COMPANY_NAME) { job.company = COMPANY_NAME; fixed++; }
    if (job.companyKey !== COMPANY_KEY) { job.companyKey = COMPANY_KEY; fixed++; }
    job.country = 'CH';
    if (!job.canton) { job.canton = HQ.canton; fixed++; }
    if (!job.location) { job.location = 'Manno'; fixed++; }
  }
  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Rivopharm jobs.`);
  }
}

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) { console.log('ℹ️ jobs.json not found.'); return { total: 0 }; }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const companyJobs = allJobs.filter(isRivopharmJob);
  console.log(`\n📊 === Rivopharm SA Job Stats ===`);
  console.log(`  🏢 Total Rivopharm jobs: ${companyJobs.length}`);
  if (companyJobs.length > 0) {
    for (const job of companyJobs) console.log(`     - ${job.title} (${job.location || 'unknown'})`);
  }
  const afterSnapshot = snapshotJobSlugs(companyJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Rivopharm SA');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Rivopharm SA');
  return { total: companyJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RIVOPHARM_STRICT',
    label: 'Rivopharm SA',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isRivopharmJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_rivopharm_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Rivopharm jobs found — the company may not have active openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Rivopharm SA');
  console.log('═══════════════════════════════════════════════');
  console.log('  Rivopharm SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Career page: ${CAREERS_URL}\n`);

  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isRivopharmJob))

  // Phase 1: Fetch careers page
  const html = await fetchCareersPage();
  if (!html) {
    console.log('\n⚠️ Could not fetch Rivopharm careers page.');
    console.log('   Writing empty slice to clear stale data (career page unreachable).');
    const _dur = getCrawlerElapsedMs();
    writeJobsCrawlerSlice(COMPANY_KEY, []);
    writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Rivopharm SA', generatedAt: new Date().toISOString(), total: 0, newCount: crawlDiff.newJobs.length, updatedCount: crawlDiff.updatedJobs.length, removedCount: crawlDiff.removedJobs.length, unchangedCount: crawlDiff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedJobs: [] });
    await assembleJobsDataset();
    return;
  }

  // Phase 2: Parse jobs
  const parsed = parseRivopharmJobs(html);
  console.log(`  📋 Jobs parsed from HTML: ${parsed.length}`);
  const discoveredJobs = parsed.map(buildJobFromParsed).filter(Boolean);

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Rivopharm jobs discovered from careers page.');
    console.log('   Writing empty slice to clear stale data.');
    const _dur = getCrawlerElapsedMs();
    writeJobsCrawlerSlice(COMPANY_KEY, []);
    writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Rivopharm SA', generatedAt: new Date().toISOString(), total: 0, newCount: crawlDiff.newJobs.length, updatedCount: crawlDiff.updatedJobs.length, removedCount: crawlDiff.removedJobs.length, unchangedCount: crawlDiff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedJobs: [] });
    await assembleJobsDataset();
    logStats(beforeSnapshot);
    return;
  }

  // Phase 3: Update adapter config
  updateAdapterConfig();

  // Phase 4: Merge into data/jobs.json
  await mergeJobs(discoveredJobs);

  // Phase 5: Run base crawler for AI localization
  console.log('\n🌐 Running base crawler for AI localization...');
  await runBaseCrawler();

  // Phase 6: Post-process
  postProcess();

  // Phase 7: Log stats
  const stats = logStats(beforeSnapshot);
  crawlDiff = stats.crawlDiff || crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No Rivopharm jobs found after crawl.');
    return;
  }

  // Phase 8: Validate locale coverage
  validateLocales();

  console.log('\n✅ Rivopharm SA crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isRivopharmJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY, label: 'Rivopharm SA', generatedAt: new Date().toISOString(),
    total: _sliceJobs.length, newCount: crawlDiff.newJobs.length, updatedCount: crawlDiff.updatedJobs.length, removedCount: crawlDiff.removedJobs.length, unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ Rivopharm SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
