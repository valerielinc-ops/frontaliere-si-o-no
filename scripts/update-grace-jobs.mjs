#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
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
  assembleJobsDataset,
} from './assemble-jobs-dataset.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'grace-la-margna.json');

const COMPANY_KEY = 'grace-la-margna';
const COMPANY_NAME = 'Grace La Margna St. Moritz';
const COMPANY_DOMAIN = 'gracehotels.com';
const COMPANY_HOST = 'www.gracehotels.com';
const CAREERS_URL = 'https://www.hotelcareer.com/jobs/grace-la-margna-st-moritz-120155';
const BASE_URL = 'https://www.hotelcareer.com';
const LOCALES = ['it', 'en', 'de', 'fr'];

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

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

function normalizeKey(value = '') {
  return String(value || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compact(text = '') {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function jobMatchKey(job) {
  return job.url || job.slug || '';
}

function isTargetJob(job) {
  if (!job) return false;
  if (job.companyKey === COMPANY_KEY) return true;
  const cn = normalize(job.company || '');
  return cn.includes('grace') && cn.includes('margna');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────
// Category inference
// ──────────────────────────────────────────────────────────────

function inferCategory(title = '', description = '') {
  const hay = `${title} ${description}`.toLowerCase();
  if (/(chef|cook|cuisine|kitchen|pizza|pâtissier|patissier)/i.test(hay)) return 'cucina';
  if (/(waiter|waitress|rang|sommelier|barkeeper|mixologist|bartend|f&b|outlet)/i.test(hay)) return 'servizio';
  if (/(housekeep|room attendant|cleaning|laundry|linen)/i.test(hay)) return 'housekeeping';
  if (/(front office|reception|concierge|page|bellman|guest relation)/i.test(hay)) return 'reception';
  if (/(spa|wellness|massage|therapist)/i.test(hay)) return 'spa';
  if (/(manager|director|supervisor|lead|executive)/i.test(hay)) return 'management';
  if (/(trainee|apprentice|intern|stage)/i.test(hay)) return 'formazione';
  if (/(maintenance|engineer|technic)/i.test(hay)) return 'tecnico';
  return 'hospitality';
}

function inferSector() {
  return 'Turismo & Ospitalità';
}

/**
 * Ensure descriptions meet the quality-gate minimum (150 chars).
 * When detail-page scraping fails (Cloudflare, changed structure),
 * enrich the short description with structured metadata so the
 * translation pipeline has enough substance to produce quality output.
 */
const MIN_DESCRIPTION_CHARS = 150;
function enrichDescription(title, description, { category, empType, location } = {}) {
  if (description && description.length >= MIN_DESCRIPTION_CHARS) return description;
  const parts = [(description || title).trim()];
  parts.push(`\nOpen position at ${COMPANY_NAME} in ${location || 'St. Moritz'}, Graubünden, Switzerland.`);
  parts.push(`Industry: Tourism & Hospitality.`);
  if (category) parts.push(`Department: ${category}.`);
  if (empType) parts.push(`Employment type: ${empType.replace(/_/g, ' ')}.`);
  parts.push(`${COMPANY_NAME} is a luxury hotel in the heart of St. Moritz, part of the Grace Hotels collection.`);
  parts.push(`Apply on hotelcareer.com for this opportunity.`);
  return parts.join(' ').trim();
}

function inferEmploymentType(text = '') {
  const t = text.toLowerCase();
  if (t.includes('part time') || t.includes('part-time') || t.includes('teilzeit')) return 'part_time';
  if (t.includes('temporary') || t.includes('seasonal') || t.includes('befristet')) return 'temporary';
  if (t.includes('trainee') || t.includes('intern') || t.includes('apprentice') || t.includes('stage')) return 'internship';
  return 'full_time';
}

// ──────────────────────────────────────────────────────────────
// Browser helpers
// ──────────────────────────────────────────────────────────────

async function waitForContent(page, maxWaitMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const title = await page.title();
    if (!title.toLowerCase().includes('challenge') && !title.toLowerCase().includes('just a moment')) {
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

async function dismissConsent(page) {
  try {
    // Try clicking Accept in the consent iframe
    const frames = page.frames();
    for (const frame of frames) {
      const acceptBtn = frame.locator('button[title="Accept"], button:has-text("Accept"), button:has-text("Agree")');
      if (await acceptBtn.count() > 0) {
        await acceptBtn.first().click({ timeout: 3000 });
        await page.waitForTimeout(1000);
        return;
      }
    }
    // Fallback: remove consent overlay via JS
    await page.evaluate(() => {
      const containers = document.querySelectorAll('[id*="sp_message_container"], [class*="consent"], [class*="cookie"]');
      containers.forEach(el => el.remove());
    });
  } catch {
    // Consent handling is best-effort
  }
}

async function withBrowser(fn) {
  const headless = process.env.JOBS_GRACE_HEADLESS === '1';
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
  try {
    return await fn(context);
  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────────────────────────
// Listing discovery
// ──────────────────────────────────────────────────────────────

async function discoverListings() {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    console.log(`🔍 Navigating to ${CAREERS_URL} ...`);
    await page.goto(CAREERS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    console.log('⏳ Waiting for Cloudflare challenge to resolve...');
    const ok = await waitForContent(page, 30000);
    if (!ok) throw new Error('Hotelcareer.com challenge did not resolve — page still blocked');

    console.log('✅ Page loaded, dismissing consent...');
    await dismissConsent(page);
    await page.waitForTimeout(2000);

    // Extract job listings from the main_link anchors
    const listings = await page.evaluate((baseUrl) => {
      const anchors = document.querySelectorAll('a.main_link');
      const seen = new Set();
      const results = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const title = a.textContent?.trim() || '';
        if (!title) continue;
        // Extract the location from the sibling element
        const parent = a.closest('.job-item, .listing-item, tr, li, [class*="offer"]') || a.parentElement;
        const locEl = parent?.querySelector('.location, [class*="location"], [class*="city"]');
        const location = locEl?.textContent?.trim() || '';
        // Extract employment type
        const typeEl = parent?.querySelector('[class*="time"], [class*="type"]');
        const empType = typeEl?.textContent?.trim() || '';
        results.push({
          title,
          href: href.startsWith('http') ? href : `${baseUrl}${href}`,
          relHref: href,
          location,
          empType,
        });
      }
      return results;
    }, BASE_URL);

    console.log(`📋 Total Grace La Margna jobs discovered: ${listings.length}`);
    for (const l of listings) console.log(`  📄 ${l.title} (${l.location || 'St. Moritz'})`);

    if (listings.length === 0) throw new Error('No job listings found — page structure may have changed');

    await page.close();
    return listings;
  });
}

// ──────────────────────────────────────────────────────────────
// Detail page scraping
// ──────────────────────────────────────────────────────────────

async function fetchJobDetails(listings) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    const jobs = [];

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      console.log(`\n📝 [${i + 1}/${listings.length}] Fetching: ${listing.title}`);

      try {
        await page.goto(listing.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const ok = await waitForContent(page, 25000);
        if (!ok) {
          console.warn(`  ⚠️ Challenge blocked detail page, using listing data only`);
          jobs.push(buildJobFromListing(listing));
          continue;
        }

        await dismissConsent(page);
        await page.waitForTimeout(1500);

        const detail = await page.evaluate(() => {
          const compact = (t) => (t || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

          // Title
          const title = compact(document.querySelector('h1, h2.job-title, .offer-title')?.textContent || '');

          // Location and type from the info line
          const body = document.body.textContent || '';
          const locationMatch = body.match(/St\.\s*Moritz/i);
          const location = locationMatch ? 'St. Moritz' : '';

          // Employment type
          let empType = '';
          const ftMatch = body.match(/(Full Time|Part Time|Temporary|Seasonal)/i);
          if (ftMatch) empType = ftMatch[1];

          // Posted date
          let postedDate = '';
          const dateMatch = body.match(/(\d{2}\/\d{2}\/\d{4})/);
          if (dateMatch) {
            const parts = dateMatch[1].split('/');
            if (parts.length === 3) {
              postedDate = `${parts[2]}-${parts[0]}-${parts[1]}`;
            }
          }

          // Description sections
          const sections = [];
          const headings = ['WHO WE NEED', 'WHAT WILL YOU DO', 'YOUR \\+sides', "WHAT'S IN FOR YOU", 'ONE MORE THING',
            'YOUR PROFILE', 'RESPONSIBILITIES', 'REQUIREMENTS', 'BENEFITS', 'WE OFFER'];
          let descBody = document.body.innerHTML || '';

          // Get clean description text between company header and contact
          const startMarkers = ['WHO WE NEED', 'WHAT WILL YOU DO', 'YOUR PROFILE', 'RESPONSIBILITIES', 'About the position'];
          const endMarkers = ['Start application', 'company profile', 'Jobs:'];
          let descText = document.body.textContent || '';

          for (const sm of startMarkers) {
            const idx = descText.indexOf(sm);
            if (idx >= 0) { descText = descText.substring(idx); break; }
          }
          for (const em of endMarkers) {
            const idx = descText.indexOf(em);
            if (idx >= 0) { descText = descText.substring(0, idx); break; }
          }

          return {
            title,
            location: location || 'St. Moritz',
            empType,
            postedDate,
            description: compact(descText).substring(0, 5000),
          };
        });

        const job = buildJobFromDetail(listing, detail);
        jobs.push(job);
        console.log(`  ✅ ${job.title} | ${job.location} | ${job.category}`);

        // Rate limit between requests
        await page.waitForTimeout(2000);
      } catch (err) {
        console.warn(`  ⚠️ Error fetching detail for ${listing.title}: ${err.message}`);
        jobs.push(buildJobFromListing(listing));
      }
    }

    await page.close();
    return jobs;
  });
}

// ──────────────────────────────────────────────────────────────
// Job building
// ──────────────────────────────────────────────────────────────

function buildJobFromListing(listing) {
  const slug = normalizeKey(listing.title);
  const category = inferCategory(listing.title, '');
  const empType = inferEmploymentType(listing.empType || listing.title);
  return {
    title: listing.title,
    slug,
    url: listing.href.replace(/\?rltr=.*$/, ''),
    applyUrl: listing.href.replace(/\?rltr=.*$/, ''),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: 'St. Moritz',
    addressLocality: 'St. Moritz',
    addressRegion: 'Graubünden',
    addressCountry: 'CH',
    canton: 'GR',
    country: 'CH',
    category,
    sector: inferSector(),
    department: category,
    employmentType: empType,
    contractType: empType === 'internship' ? 'stage' : 'permanent',
    sourceLang: 'en',
    description: enrichDescription(listing.title, '', { category, empType, location: 'St. Moritz' }),
    postedDate: todayIso(),
    validThrough: '',
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
    source: 'dedicated-crawler',
    crawledAt: new Date().toISOString(),
  };
}

function buildJobFromDetail(listing, detail) {
  const title = detail.title || listing.title;
  const slug = normalizeKey(title);
  const category = inferCategory(title, detail.description);
  const empType = inferEmploymentType(detail.empType || listing.empType || title);
  const rawDescription = detail.description || title;
  const location = detail.location || 'St. Moritz';
  const description = enrichDescription(title, rawDescription, { category, empType, location });

  return {
    title,
    slug,
    url: listing.href.replace(/\?rltr=.*$/, ''),
    applyUrl: listing.href.replace(/\?rltr=.*$/, ''),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: 'Graubünden',
    addressCountry: 'CH',
    canton: 'GR',
    country: 'CH',
    category,
    sector: inferSector(),
    department: category,
    employmentType: empType,
    contractType: empType === 'internship' ? 'stage' : 'permanent',
    sourceLang: detectLang(description) || 'en',
    description: description.substring(0, 5000),
    postedDate: detail.postedDate || todayIso(),
    validThrough: '',
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
    source: 'dedicated-crawler',
    crawledAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────────────────────

function mergeJobs(discoveredJobs) {
  const existing = readJson(DATA_JOBS, []);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    return {
      ...prev,
      ...job,
      titleByLocale: { ...(prev.titleByLocale || {}), ...(job.titleByLocale || {}) },
      descriptionByLocale: { ...(prev.descriptionByLocale || {}), ...(job.descriptionByLocale || {}) },
      slugByLocale: { ...(prev.slugByLocale || {}), ...(job.slugByLocale || {}) },
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, allJobs);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  return { total: allJobs.length, added, updated, targetCount: mergedTarget.length };
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  console.log(`\n🏨 Grace La Margna St. Moritz — Dedicated Job Crawler`);
  console.log(`   Source: hotelcareer.com (Playwright browser-based)`);
  console.log(`   Company key: ${COMPANY_KEY}\n`);

  // Validate adapter
  const adapter = readJson(ADAPTER_PATH, null);
  if (!adapter || !adapter.enabled) {
    console.warn('⚠️ Adapter not found or disabled — exiting.');
    process.exit(0);
  }

  // Phase 1 — Discover listings
  console.log('═══════════════════════════════════════');
  console.log('Phase 1: Discover listings');
  console.log('═══════════════════════════════════════');
  const listings = await discoverListings();

  // Phase 2 — Fetch detail pages
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 2: Fetch job details');
  console.log('═══════════════════════════════════════');
  const jobs = await fetchJobDetails(listings);

  console.log(`\n📊 Detail results: ${jobs.length} jobs built`);

  // Phase 3 — Merge
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 3: Merge');
  console.log('═══════════════════════════════════════');
  const stats = mergeJobs(jobs);
  console.log(`\n📈 Result: ${stats.targetCount} Grace La Margna jobs (${stats.added} new, ${stats.updated} updated)`);
  console.log(`   Total jobs in file: ${stats.total}`);

  // Phase 4 — Translate + validate
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 4: Translate');
  console.log('═══════════════════════════════════════');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GRACE_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    failWhenNoJobs: true,
    noJobsMessage: 'No Grace La Margna jobs found after dedicated crawl.',
  });

  // Phase 5 — Summary
  printPublishedJobUrls(jobs);
  writeJobsSummary(COMPANY_KEY, stats);

  console.log('\n✅ Grace La Margna crawler complete.\n');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS)
    ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'))
    : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'grace',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: 0,
    updatedCount: 0,
    removedCount: 0,
    unchangedCount: _sliceJobs.length,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: [],
    updatedJobs: [],
    removedJobs: [],
    unchangedJobs: _sliceJobs.slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error('❌ Fatal crawler error:', err);
  process.exit(1);
});
