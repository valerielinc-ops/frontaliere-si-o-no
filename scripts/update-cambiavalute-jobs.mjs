#!/usr/bin/env node
/**
 * Dedicated CambiaValute.ch (Chiasso) crawler runner.
 *
 * Source:
 *   https://cambiavalute.ch/annunci-di-lavoro/
 *
 * This script:
 *   1. Fetches the cambiavalute.ch careers listing page.
 *   2. Extracts detail URLs matching /annuncio-di-lavoro/{slug}/.
 *   3. Updates adapter seed URLs + seedMetaByUrl.
 *   4. Runs shared crawler scoped to cambiavalute company key.
 *   5. Post-processes rows for canonical consistency + dedupe.
 *   6. Enforces locale coverage in strict mode.
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './lib/ensure-chromium.mjs';
import { fetchViaJinaWithRetry, detectJinaErrorBody } from './lib/jina-proxy.mjs';
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
} from './lib/dedicated-crawler-common.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const CAMBIAVALUTE_KEY = 'cambiavalute';
const HQ = getCompanyDefaults(CAMBIAVALUTE_KEY);
const CAMBIAVALUTE_COMPANY_NAME = 'CambiaValute.ch';
const CAMBIAVALUTE_COMPANY_DOMAIN = 'cambiavalute.ch';
const CAMBIAVALUTE_HOST = 'cambiavalute.ch';
const CAMBIAVALUTE_LISTING_URL = 'https://cambiavalute.ch/annunci-di-lavoro/';
// Yoast sitemap for the "career" (annuncio-di-lavoro) custom post type. Used as
// a discovery fallback when the listing-page DOM yields 0 links — it lists the
// canonical job URLs as plain <loc> entries, so it survives Elementor layout
// changes and is a second path past the same WAF (gated by the same UA window).
const CAMBIAVALUTE_SITEMAP_URL = 'https://cambiavalute.ch/career-sitemap.xml';
const CAMBIAVALUTE_LOCALES = ['it', 'en', 'de', 'fr'];

/* ── HTML helpers ──────────────────────────────────────────── */
function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function toAbsoluteUrl(rawUrl = '') {
  const value = decodeHtmlEntities(rawUrl);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  }
  const pathname = value.startsWith('/') ? value : `/${value}`;
  return `https://${CAMBIAVALUTE_HOST}${pathname}`;
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === CAMBIAVALUTE_HOST || host.endsWith(`.${CAMBIAVALUTE_HOST}`);
  } catch {
    return false;
  }
}

function isCambiavalute(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === CAMBIAVALUTE_KEY ||
    key.includes('cambiavalute') ||
    company.includes('cambiavalute') ||
    host === CAMBIAVALUTE_HOST ||
    host.endsWith(`.${CAMBIAVALUTE_HOST}`)
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
/**
 * Extract job detail links from the listing page HTML.
 * Links match the pattern /annuncio-di-lavoro/{slug}/
 */
function parseJobLinksFromHtml(html = '') {
  const source = String(html || '');
  const hrefRe = /href=(["'])(.*?)\1/gi;
  const seen = new Map();
  let match = null;
  while ((match = hrefRe.exec(source)) !== null) {
    const rawHref = decodeHtmlEntities(match[2] || '');
    if (!rawHref) continue;
    const absolute = toAbsoluteUrl(rawHref);
    if (!absolute) continue;
    // Only keep links to job detail pages
    if (!/\/annuncio-di-lavoro\/[^/?#]+/i.test(absolute)) continue;
    try {
      const url = new URL(absolute);
      if (url.hostname.toLowerCase() !== CAMBIAVALUTE_HOST) continue;
      // Normalize: remove trailing slash differences, hash, etc.
      const canonical = `${url.origin}${url.pathname.replace(/\/+$/, '/')}`
        .replace(/([^/])$/, '$1/');
      const key = canonical.toLowerCase();
      if (!seen.has(key)) seen.set(key, canonical);
    } catch {
      // skip malformed URLs
    }
  }
  return [...seen.values()];
}

/**
 * Extract job detail links from a Yoast sitemap XML body. Same /annuncio-di-lavoro/
 * filter + canonicalization as parseJobLinksFromHtml, but over <loc> entries.
 */
function parseJobLinksFromSitemap(xml = '') {
  const source = String(xml || '');
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  const seen = new Map();
  let match = null;
  while ((match = locRe.exec(source)) !== null) {
    const absolute = toAbsoluteUrl(decodeHtmlEntities(match[1] || ''));
    if (!absolute) continue;
    if (!/\/annuncio-di-lavoro\/[^/?#]+/i.test(absolute)) continue;
    try {
      const url = new URL(absolute);
      if (url.hostname.toLowerCase() !== CAMBIAVALUTE_HOST) continue;
      const canonical = `${url.origin}${url.pathname.replace(/\/+$/, '/')}`
        .replace(/([^/])$/, '$1/');
      const key = canonical.toLowerCase();
      if (!seen.has(key)) seen.set(key, canonical);
    } catch {
      // skip malformed URLs
    }
  }
  return [...seen.values()];
}

// Realistic browser User-Agents rotated across attempts to defeat anti-bot
// 403s (cambiavalute.ch blocks the bot UA — issues #1277/#1303/#1363).
//
// IMPORTANT — the WAF gates on the Chrome MAJOR version, not just "browser vs
// bot": empirically (2026-06-04, residential probe) Chrome/122–130 return 200
// while Chrome/120 and Chrome/131+ return 403. The previous UAs were ALL
// Chrome/131, so every plain-fetch attempt AND the Playwright fallback (which
// sets page UA = BROWSER_USER_AGENTS[0]) were served the anti-bot page → 0 job
// links parsed in CI. Pin a few versions inside the known-good window. If the
// window drifts and these start 403'ing again, the run skips gracefully (no
// false-failure issue) — bump the versions then.
const BROWSER_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

async function fetchListingPage(url, timeoutMs, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Mirror a real Chrome top-level navigation. The Sec-Fetch-* metadata +
        // Upgrade-Insecure-Requests are sent by every modern browser; their
        // absence is a strong bot tell for the WAF. `Accept-Encoding` is left
        // unset on purpose so undici negotiates it (a manual `gzip, deflate, br`
        // is not needed here — undici auto-decompresses the body from its
        // `Content-Encoding` whether or not the caller pins `Accept-Encoding`,
        // verified on Node 22; res.text() is decompressed either way).
        // No fake `Referer` — a direct navigation has Sec-Fetch-Site: none.
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'User-Agent': userAgent,
      },
    });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return html;
  } finally {
    clearTimeout(timer);
  }
}

// Playwright fallback for when plain fetch is 403'd by anti-bot every time.
// A real headless Chromium passes the JS/TLS fingerprint checks that block
// node's fetch. Lazy-imported so the dependency is only loaded on fallback.
async function fetchListingPageViaBrowser(url, timeoutMs) {
  const browser = await launchChromium({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: BROWSER_USER_AGENTS[0] });
    // domcontentloaded (not networkidle): the listing is static HTML; networkidle
    // can hang past the timeout on pages with ads/polling/keep-alive, silently
    // skipping a parsable run. The job links are in the initial document.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 45000) });
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function fetchListingPageWithRetry(url, timeoutMs, userAgent, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Rotate realistic browser UAs unless the env explicitly pins one.
    const attemptUa = userAgent || BROWSER_USER_AGENTS[(attempt - 1) % BROWSER_USER_AGENTS.length];
    try {
      return await fetchListingPage(url, timeoutMs, attemptUa);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
      const delayMs = attempt * 1500;
      console.warn(`⚠️ Listing fetch attempt ${attempt}/${attempts} failed: ${err?.message || err}. Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // All plain-fetch attempts failed (typically a hard 403 anti-bot block).
  // Try a real headless browser before giving up.
  console.warn(`⚠️ Plain fetch exhausted (${lastError?.message || lastError}). Trying Playwright browser fallback...`);
  try {
    return await fetchListingPageViaBrowser(url, timeoutMs);
  } catch (pwErr) {
    const combined = new Error(`All fetch methods failed. Last fetch: ${lastError?.message || lastError}. Playwright: ${pwErr?.message || pwErr}`);
    combined.antiBotBlocked = true;
    throw combined;
  }
}

async function fetchCambiavalute() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;
  // Empty by default → fetchListingPageWithRetry rotates realistic browser UAs.
  // An explicit env override still wins (manual debugging / future tuning).
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || '';

  console.log(`🔍 Fetching CambiaValute.ch jobs from ${CAMBIAVALUTE_LISTING_URL}...`);

  let html = '';
  try {
    html = await fetchListingPageWithRetry(CAMBIAVALUTE_LISTING_URL, timeoutMs, userAgent);
  } catch (err) {
    // cambiavalute.ch is a known volatile anti-bot source (#1277/#1303): even a
    // genuine browser fallback can be hard-403'd. The source still exists, so
    // per owner rule we do NOT auto-retire it — instead treat a total fetch
    // failure as a non-fatal WARNING (return zero seedUrls → main() skips the
    // crawl without exiting 1, so no false-positive failure issue is filed).
    // Retiring the source needs explicit owner OK.
    console.warn(`⚠️ Failed to fetch CambiaValute.ch listing after browser fallback: ${err?.message || err}.`);
    console.warn('⚠️ Treating as transient anti-bot block — skipping this run without failure (source not retired; needs owner OK to retire).');
    return { seedUrls: [], seedMetaByUrl: {} };
  }

  let links = parseJobLinksFromHtml(html);
  console.log(`📦 Found ${links.length} job detail link(s) on the listing page.`);

  // Fallback: the listing DOM yielded nothing (anti-bot challenge page, or an
  // Elementor layout change). Try the career sitemap, which lists the canonical
  // job URLs as plain <loc> entries and is far harder to break.
  if (links.length === 0) {
    console.log(`🗺️  Listing empty — trying career sitemap ${CAMBIAVALUTE_SITEMAP_URL}...`);
    try {
      const sitemapXml = await fetchListingPageWithRetry(
        CAMBIAVALUTE_SITEMAP_URL,
        timeoutMs,
        userAgent,
      );
      links = parseJobLinksFromSitemap(sitemapXml);
      console.log(`📦 Found ${links.length} job detail link(s) via sitemap.`);
    } catch (err) {
      console.warn(`⚠️ Sitemap fallback failed: ${err?.message || err}.`);
    }
  }

  // Still nothing → the egress IP is WAF-blocked (datacenter IP on CI gets a
  // challenge page even with a perfect browser UA — see #1363). Fetch the
  // sitemap through the Jina Reader proxy (clean IP) for discovery; the detail
  // pages are then fetched through the same proxy by the shared crawler via
  // JOBS_CRAWLER_FETCH_PROXY (set in runBaseCrawler below).
  if (links.length === 0) {
    try {
      console.log('🛰️  Sitemap empty from direct fetch — retrying via egress proxy...');
      const res = await fetchViaJinaWithRetry(CAMBIAVALUTE_SITEMAP_URL, { timeoutMs });
      if (res.ok) {
        const body = await res.text();
        // Jina answers 200 even when it never reached the target (challenge /
        // error page, or empty body) → the link union below would silently be 0.
        // Log an explicit "200-but-not-target" warning so a degraded proxy is
        // diagnosable, then parse the body unchanged (#1422 item 1).
        const reason = detectJinaErrorBody(body);
        if (reason) console.warn(`⚠️ Proxied sitemap 200 but not the target page (${reason}) — link union will likely be empty.`);
        // Jina with X-Return-Format: html renders the XML sitemap as an HTML
        // page (<a href> links, not <loc>), so parse with both extractors and
        // union — robust whether the proxy returns raw XML or rendered HTML.
        const merged = new Map();
        for (const link of [...parseJobLinksFromSitemap(body), ...parseJobLinksFromHtml(body)]) {
          merged.set(link.toLowerCase(), link);
        }
        links = [...merged.values()];
        console.log(`📦 Found ${links.length} job detail link(s) via proxied sitemap.`);
      } else {
        console.warn(`⚠️ Proxied sitemap returned HTTP ${res.status}.`);
      }
    } catch (err) {
      console.warn(`⚠️ Proxied sitemap fallback failed: ${err?.message || err}.`);
    }
  }

  const seedMetaByUrl = {};
  for (const link of links) {
    seedMetaByUrl[link] = {
      location: 'Chiasso',
      canton: HQ.canton,
      country: 'CH',
      company: CAMBIAVALUTE_COMPANY_NAME,
      companyDomain: CAMBIAVALUTE_COMPANY_DOMAIN,
    };
  }

  return { seedUrls: links, seedMetaByUrl };
}

/* ── Adapter update ────────────────────────────────────────── */
function updateAdapter(seedUrls, seedMetaByUrl) {
  const adapterPath = path.join(ADAPTERS_DIR, `${CAMBIAVALUTE_KEY}.json`);
  let adapter = {};
  try {
    adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  } catch { /* first run, will create new */ }

  adapter = {
    ...adapter,
    companyKey: CAMBIAVALUTE_KEY,
    companyName: CAMBIAVALUTE_COMPANY_NAME,
    companyHost: CAMBIAVALUTE_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html', 'jsonld'],
    seedUrls,
    seedDetailUrls: seedUrls,
    seedMetaByUrl,
    notes:
      'Dedicated CambiaValute.ch crawler — discovers job listings from cambiavalute.ch/annunci-di-lavoro/ and extracts detail page URLs under /annuncio-di-lavoro/{slug}/.',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath} (${seedUrls.length} seed URLs)`);
}

/* ── Run shared crawler ────────────────────────────────────── */
async function runBaseCrawler() {
  console.log('🚀 Running shared crawler scoped to CambiaValute.ch...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: CAMBIAVALUTE_KEY,
    disableWorkdayForce: true,
    forceLocalizationWhenAiEnabledOnly: true,
    // Route cambiavalute.ch fetches (the detail pages) through the Jina Reader
    // egress proxy: the WAF blocks GitHub Actions datacenter IPs regardless of
    // UA/headers (#1363), but the jobs are reachable from a clean IP. Scoped to
    // this host only — every other crawler's fetch path is untouched.
    extraEnv: { JOBS_CRAWLER_FETCH_PROXY: CAMBIAVALUTE_HOST },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcess() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;

  let changed = false;
  const seenKeys = new Map();

  const processed = jobs.filter((job) => {
    if (!isCambiavalute(job)) return true; // keep non-cambiavalute as-is

    // Canonicalize company fields
    if (job.company !== CAMBIAVALUTE_COMPANY_NAME) {
      job.company = CAMBIAVALUTE_COMPANY_NAME;
      changed = true;
    }
    if (job.companyKey !== CAMBIAVALUTE_KEY) {
      job.companyKey = CAMBIAVALUTE_KEY;
      changed = true;
    }
    if (!job.canton || job.canton !== HQ.canton) {
      job.canton = HQ.canton;
      changed = true;
    }
    if (!job.country || job.country !== 'CH') {
      job.country = 'CH';
      changed = true;
    }
    if (!job.sourceLang) {
      job.sourceLang = detectLang(job.description || job.title, 'it');
      changed = true;
    }

    // Deduplicate by URL
    const url = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const dedupKey = url || normalizeKey(job.slug || job.title || '');
    if (seenKeys.has(dedupKey)) return false;
    seenKeys.set(dedupKey, true);

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
  const after = snapshotJobSlugs(Array.isArray(jobs) ? jobs.filter(isCambiavalute) : []);
  const diff = computeCrawlDiff(before, after);
  printCrawlChangeSummary(diff, 'CambiaValute.ch');
  writeCrawlChangeSummaryToGH(diff, 'CambiaValute.ch');
  return diff;
}

/* ── Locale validation ─────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CAMBIAVALUTE_STRICT',
    label: 'CambiaValute.ch',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCambiavalute,
    locales: CAMBIAVALUTE_LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_cambiavalute_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No CambiaValute.ch jobs found — the company may not have active openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(CAMBIAVALUTE_KEY, 'Cambiavalute');
  console.log('═══════════════════════════════════════════════');
  console.log('  CambiaValute.ch — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  // Snapshot before
  const beforeMap = snapshotJobSlugs(readExistingCrawlerJobs(CAMBIAVALUTE_KEY, DATA_JOBS).filter(isCambiavalute))

  // Phase 1: discover detail URLs
  const { seedUrls, seedMetaByUrl } = await fetchCambiavalute();

  if (seedUrls.length === 0) {
    console.log('ℹ️ No job listings found on CambiaValute.ch — skipping crawl.');
    return;
  }

  // Phase 2: update adapter
  updateAdapter(seedUrls, seedMetaByUrl);

  // Phase 3: run shared crawler
  await runBaseCrawler();

  // Phase 4: post-process
  postProcess();

  // Phase 5: log stats
  const diff = logStats(beforeMap);

  // Phase 6: locale validation
  validateLocales();

  console.log('✅ CambiaValute.ch crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCambiavalute) : [];
  writeJobsCrawlerSlice(CAMBIAVALUTE_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: CAMBIAVALUTE_KEY,
    label: 'Cambiavalute',
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

main().catch((err) => exitCrawlerOnError(err, 'CambiaValute.ch'));