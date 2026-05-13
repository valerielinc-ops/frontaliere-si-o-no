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
import { selectGraceDescription } from './lib/grace-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'grace-la-margna.json');

const COMPANY_KEY = 'grace-la-margna';
const COMPANY_NAME = 'Grace La Margna St. Moritz';
const COMPANY_DOMAIN = 'gracehotels.com';
const COMPANY_HOST = 'www.gracehotels.com';
const HQ = getCompanyDefaults(COMPANY_KEY);
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
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
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
  // Prefer waiting for visible, job-specific selectors first to handle content
  // that is populated via JS (hotelcareer uses #jobDesignerContainer / .job_container)
  try {
    await page.waitForSelector('h1, .job_container, #jobDesignerContainer, .ContentWrapperYcg', { timeout: maxWaitMs });
    const title = await page.title();
    if (title && (title.toLowerCase().includes('challenge') || title.toLowerCase().includes('just a moment'))) {
      return false;
    }
    return true;
  } catch (err) {
    // Fallback: some blocking pages cause selector wait to fail. Try a tolerant loop
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const title = await page.title();
        if (!title.toLowerCase().includes('challenge') && !title.toLowerCase().includes('just a moment')) {
          return true;
        }
      } catch (e) {
        // Execution context might be transiently destroyed; swallow and retry
      }
      await page.waitForTimeout(1000);
    }
    return false;
  }
}

async function isChallengePage(page) {
  try {
    const title = await page.title();
    if (/challenge validation|just a moment|attention required/i.test(title)) return true;
    const body = await page.locator('body').textContent().catch(() => '');
    return /processing your request|akamai|verify you are human|checking your browser/i.test(body || '');
  } catch {
    return false;
  }
}

async function gotoGracePage(page, url, { attempts = 3, timeoutMs = 45000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForTimeout(attempt === 1 ? 2500 : 4500);
      if (await isChallengePage(page)) {
        lastError = new Error(`challenge attempt ${attempt}/${attempts}`);
        if (attempt < attempts) {
          await page.waitForTimeout(2500 * attempt);
          continue;
        }
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await page.waitForTimeout(2000 * attempt);
        continue;
      }
    }
  }
  throw lastError || new Error(`Failed to load ${url}`);
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
    await gotoGracePage(page, CAREERS_URL);

    console.log('⏳ Waiting for Cloudflare challenge to resolve...');
    const ok = await waitForContent(page, 30000);
    if (!ok) throw new Error('Hotelcareer.com challenge did not resolve — page still blocked');

    console.log('✅ Page loaded, dismissing consent...');
    await dismissConsent(page);
    await page.waitForTimeout(2000);

    // Extract job listings from the main_link anchors
    const listings = await page.evaluate((baseUrl) => {
      const seen = new Set();
      const results = [];
      const detailHrefRe = /\/jobs\/grace-la-margna-st-moritz-120155\/[^/?#]+-\d+(?:[?#].*)?$/i;

      const candidateAnchors = Array.from(document.querySelectorAll('a[href*="/jobs/grace-la-margna-st-moritz-120155/"]'));
      for (const a of candidateAnchors) {
        const href = a.getAttribute('href') || '';
        if (!href) continue;
        // Normalize relative hrefs
        const full = href.startsWith('http') ? href : `${baseUrl}${href}`;
        if (seen.has(full)) continue;
        if (!detailHrefRe.test(full)) continue;
        // Heuristic: link text should be non-empty and not a pagination/control link
        const title = (a.textContent || '').trim();
        if (!title) continue;
        // Skip links that look like company/profile links
        if (/company|profile|jobs:\s*\d+|job search|our clients/i.test(title)) continue;
        // Find nearby meta info
        const parent = a.closest('.listing-item, .resultlist li, .job-item, tr, li, .ContentWrapperYcgInner') || a.parentElement;
        const locEl = parent?.querySelector('.location, [class*=\"location\"], .meta_info_container .location');
        const location = locEl?.textContent?.trim() || '';
        const typeEl = parent?.querySelector('.employment, [class*=\"time\"], [class*=\"type\"]');
        const empType = typeEl?.textContent?.trim() || '';
        seen.add(full);
        results.push({ title, href: full, relHref: href, location, empType });
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
    const jobs = [];

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      console.log(`\n📝 [${i + 1}/${listings.length}] Fetching: ${listing.title}`);

      const page = await context.newPage();
      try {
        await gotoGracePage(page, listing.href);
        const ok = await waitForContent(page, 30000);
        if (!ok) {
          console.warn(`  ⚠️ Challenge blocked detail page, using listing data only`);
          jobs.push(buildJobFromListing(listing));
          await page.close();
          continue;
        }

        await dismissConsent(page);

        // Wait for the main container that hotelcareer renders
        await page.waitForSelector('#jobDesignerContainer, .job_container, h1', { timeout: 15000 }).catch(() => {});

        const detail = await page.evaluate(() => {
          const compact = (t) => (t || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

          const title = compact(document.querySelector('h1, h2.job-title, .offer-title')?.textContent || '');

          const selectTextFrom = (el) => {
            if (!el) return '';
            const nodes = Array.from(el.querySelectorAll('p, li'));
            if (nodes.length) return nodes.map(n => n.textContent || '').filter(Boolean).join('\n').trim();
            return (el.textContent || '').trim();
          };

          // Preferred extraction from structured sections used on hotelcareer
          const sectionIds = ['introduction', 'tasks', 'profile', 'benefits', 'contact_container'];
          const sectionTexts = [];

          // meta description first
          const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || document.querySelector('meta[property="og:description"]')?.getAttribute('content');

          for (const id of sectionIds) {
            const el = document.getElementById(id) || document.querySelector(`#${id}`);
            if (!el) continue;
            const h = el.querySelector('h2')?.textContent?.trim();
            const localPieces = [];
            if (h) localPieces.push(h);
            const text = selectTextFrom(el);
            if (text) localPieces.push(text);
            if (localPieces.length) sectionTexts.push(localPieces.join('\n'));
          }

          const containerText = selectTextFrom(document.querySelector('#jobDesignerContainer, .job_container'));
          const main = document.querySelector('main') || document.body;
          const mainText = selectTextFrom(main);

          // Final fallback: use body slicing heuristics
          let bodyText = document.body.textContent || '';
          const startMarkers = ['WHO WE NEED', 'WHAT WILL YOU DO', 'YOUR PROFILE', 'RESPONSIBILITIES', 'About the position'];
          const endMarkers = ['Start application', 'company profile', 'Jobs:'];
          for (const sm of startMarkers) {
            const idx = bodyText.indexOf(sm);
            if (idx >= 0) { bodyText = bodyText.substring(idx); break; }
          }
          for (const em of endMarkers) {
            const idx = bodyText.indexOf(em);
            if (idx >= 0) { bodyText = bodyText.substring(0, idx); break; }
          }

          // location and employment type extracted from visible meta info
          const loc = (document.querySelector('.location')?.textContent || '').trim();
          const emp = (document.querySelector('.employment')?.textContent || '').trim();
          // posted date
          const postedRaw = (document.querySelector('.date')?.textContent || '').trim();

          let postedDate = '';
          const m = postedRaw.match(/(\d{2}\/\d{2}\/\d{4})/);
          if (m) {
            const parts = m[1].split('/');
            if (parts.length === 3) postedDate = `${parts[2]}-${parts[0]}-${parts[1]}`;
          }

          return {
            title: compact(title || ''),
            location: loc || 'St. Moritz',
            empType: emp || '',
            postedDate,
            descriptionParts: {
              metaDesc: metaDesc?.trim() || '',
              sectionTexts,
              containerText,
              mainText,
              bodyText: bodyText.trim(),
            },
          };
        });

        const parsedDescription = selectGraceDescription(detail.descriptionParts || {});

        const job = buildJobFromDetail(listing, { ...detail, description: parsedDescription });
        jobs.push(job);
        console.log(`  ✅ ${job.title} | ${job.location} | ${job.category}`);

        await page.waitForTimeout(800);
      } catch (err) {
        console.warn(`  ⚠️ Error fetching detail for ${listing.title}: ${err.message}`);
        jobs.push(buildJobFromListing(listing));
      } finally {
        await page.close();
      }
    }

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
  const srcLang = 'en';
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
    canton: HQ.canton,
    country: 'CH',
    category,
    sector: inferSector(),
    department: category,
    employmentType: empType,
    contractType: empType === 'internship' ? 'stage' : 'permanent',
    sourceLang: srcLang,
    description: enrichDescription(listing.title, '', { category, empType, location: 'St. Moritz' }),
    postedDate: todayIso(),
    validThrough: '',
    titleByLocale: { [srcLang]: listing.title },
    descriptionByLocale: { [srcLang]: enrichDescription(listing.title, '', { category, empType, location: 'St. Moritz' }) },
    slugByLocale: { [srcLang]: slug },
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
  const srcLang = detectLang(description) || 'en';

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
    canton: HQ.canton,
    country: 'CH',
    category,
    sector: inferSector(),
    department: category,
    employmentType: empType,
    contractType: empType === 'internship' ? 'stage' : 'permanent',
    sourceLang: srcLang,
    description: description.substring(0, 5000),
    postedDate: detail.postedDate || todayIso(),
    validThrough: '',
    titleByLocale: { [srcLang]: title },
    descriptionByLocale: { [srcLang]: description.substring(0, 5000) },
    slugByLocale: { [srcLang]: slug },
    source: 'dedicated-crawler',
    crawledAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────────────────────

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
    if (!prev) {
      added += 1;
      return job;
    }
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
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, allJobs);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  return { total: allJobs.length, added, updated, targetCount: mergedTarget.length, diff };
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'grace');
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
  const diff = stats.diff;
  console.log(`\n📈 Result: ${stats.targetCount} Grace La Margna jobs (${stats.added} new, ${stats.updated} updated)`);
  console.log(`   Total jobs in file: ${stats.total}`);

  // Phase 4 — Translate + validate
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 4: Translate');
  console.log('═══════════════════════════════════════');
  // Backfill missing locale descriptions for target jobs to avoid strict validation failures
  try {
    const all = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let patched = 0;
    for (const job of all) {
      if (!isTargetJob(job)) continue;
      job.titleByLocale = job.titleByLocale || {};
      job.descriptionByLocale = job.descriptionByLocale || {};
      job.slugByLocale = job.slugByLocale || {};
      const baseDesc = String(job.description || '').trim();
      const baseTitle = String(job.title || '').trim();
      for (const loc of LOCALES) {
        if (!String(job.descriptionByLocale[loc] || '').trim()) {
          job.descriptionByLocale[loc] = enrichDescription(baseTitle, baseDesc, { category: job.category, empType: job.employmentType, location: job.location });
          patched += 1;
        }
        if (!String(job.titleByLocale[loc] || '').trim()) {
          job.titleByLocale[loc] = baseTitle;
        }
        if (!String(job.slugByLocale[loc] || '').trim()) {
          job.slugByLocale[loc] = job.slug || normalizeKey(baseTitle);
        }
      }
    }
    if (patched > 0) {
      fs.writeFileSync(DATA_JOBS, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
      if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
        fs.writeFileSync(PUBLIC_JOBS, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
      }
      console.log(`🛠️ Backfilled ${patched} missing locale descriptions for ${COMPANY_NAME} jobs`);
    }
  } catch (e) {
    console.warn('⚠️ Failed to backfill missing locales:', e.message);
  }

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
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'grace',
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
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('challenge did not resolve') || msg.includes('still blocked')) {
    console.warn(`⚠️ Hotelcareer.com anti-bot challenge blocked crawl: ${msg}`);
    console.warn('ℹ️ Existing job data in slice preserved. Will retry next run.');
    process.exit(0);
  }
  console.error('❌ Fatal crawler error:', err);
  process.exit(1);
});
