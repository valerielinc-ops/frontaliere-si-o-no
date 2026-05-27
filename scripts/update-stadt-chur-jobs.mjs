#!/usr/bin/env node
import dns from 'node:dns';
import { Agent } from 'undici';
// Force IPv4-first DNS resolution (GitHub Actions runners sometimes prefer IPv6 which times out)
dns.setDefaultResultOrder('ipv4first');
/**
 * Dedicated Stadt Chur crawler.
 *
 * Source: Rexx Systems ATS — jobs.chur.ch
 *   Atom feed: https://jobs.chur.ch/rss_generator-rss0.php?unit=chur&lang=de
 *
 * Strategy:
 *   1. Fetch Atom RSS feed (all jobs in one page).
 *   2. Parse entries — all are Stadt Chur / Chur, GR by default.
 *   3. Optionally fetch detail pages for richer descriptions.
 *   4. Build standardized job objects + translate.
 *   5. Merge into data/jobs.json.
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'stadt-chur.json');

const COMPANY_KEY = 'stadt-chur';
const COMPANY_NAME = 'Stadt Chur';
const COMPANY_DOMAIN = 'chur.ch';
const HQ = getCompanyDefaults(COMPANY_KEY);
const FEED_URL = 'https://jobs.chur.ch/rss_generator-rss0.php?unit=chur&lang=de';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '30000', 10);
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoCrawler/1.0; +https://frontaliereticino.ch)';
const DETAIL_DELAY_MS = 800;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

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

function slugify(value = '') {
  return String(value || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(str = '') {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'");
}

function isTargetJob(job) {
  if (!job) return false;
  if (job.companyKey === COMPANY_KEY) return true;
  const cn = normalize(job.company || '');
  return cn.includes('stadt chur');
}

function jobMatchKey(job) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  const dispatcher = new Agent({ connect: { timeout: TIMEOUT_MS } });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        dispatcher,
        signal: AbortSignal.timeout(TIMEOUT_MS + 5000),
      });
      return res;
    } catch (err) {
      if (attempt < retries) {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(`  ⚠️ Attempt ${attempt}/${retries} failed: ${err.message}. Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Category inference from Rexx category terms
// ──────────────────────────────────────────────────────────────

function inferCategory(categoryTerm = '', title = '') {
  const hay = `${categoryTerm} ${title}`.toLowerCase();
  if (/(informatik|telekommunikation|software|applikation|cyber)/i.test(hay)) return 'it';
  if (/(finanzen|controlling|treuhand|recht|jurist|buchhalt|finanzkontrolle)/i.test(hay)) return 'finance';
  if (/(bildung|sozial|sport|schul|heilpäd|lehrer|lehrperson|kinder)/i.test(hay)) return 'education';
  if (/(gastronomie|hotellerie|tourismus|koch|köchin|servicemitarbeit)/i.test(hay)) return 'hospitality';
  if (/(handwerk|bau|mechanik|elektro|hlk|ingenieur|technik|architekt|geoinformatik)/i.test(hay)) return 'engineering';
  if (/(kaufm|kundendienst|verwaltung|projektleit|kultur|sekretär)/i.test(hay)) return 'administration';
  if (/(polizei|sicherheit|rettung|aspirant)/i.test(hay)) return 'public-safety';
  if (/(körperpflege|wellness|bademeister)/i.test(hay)) return 'wellness';
  if (/(gesundheit|pflege|dental|medizin)/i.test(hay)) return 'healthcare';
  if (/(praktik|lehr|ausbildung)/i.test(hay)) return 'apprenticeship';
  return 'public-administration';
}

function mapEmploymentType(title = '') {
  const t = title.toLowerCase();
  if (t.includes('praktik') || t.includes('praktikant')) return 'internship';
  if (t.includes('lehrstelle') || t.includes('lernende') || t.includes('aspirant')) return 'apprenticeship';
  // Extract percentage if present
  const pctMatch = t.match(/(\d+)\s*[-–]\s*(\d+)\s*%/) || t.match(/(\d+)\s*%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[2] || pctMatch[1], 10);
    if (pct < 100) return 'part_time';
  }
  if (t.includes('stundenlohn') || t.includes('teilzeit')) return 'part_time';
  if (t.includes('saison')) return 'temporary';
  return 'full_time';
}

// ──────────────────────────────────────────────────────────────
// Atom feed parsing
// ──────────────────────────────────────────────────────────────

function parseAtomEntries(xmlText) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeHtmlEntities(m[1].trim()) : '';
    };
    const getAttr = (tag, attr) => {
      const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`));
      return m ? decodeHtmlEntities(m[1].trim()) : '';
    };

    entries.push({
      title: get('title'),
      link: getAttr('link', 'href') || get('link'),
      id: get('id'),
      summary: get('summary'),
      updated: get('updated'),
      category: getAttr('category', 'term'),
    });
  }
  return entries;
}

// ──────────────────────────────────────────────────────────────
// Detail page scraping (optional enrichment)
// ──────────────────────────────────────────────────────────────

async function fetchDetailPage(url) {
  try {
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    }, 2);
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

function parseDetailPage(html) {
  if (!html) return null;
  const sections = [];
  const sectionRegex = /<h2[^>]*class="scheme-headline"[^>]*>\s*([\s\S]*?)\s*<\/h2>\s*<div class="content_text"[^>]*>([\s\S]*?)<\/div>/g;
  let match;
  while ((match = sectionRegex.exec(html)) !== null) {
    const heading = stripHtml(match[1]).trim();
    const body = stripHtml(match[2]).trim();
    if (body) sections.push({ heading, body });
  }
  // Combine sections into a description
  if (sections.length === 0) return null;
  return sections.map((s) => s.heading ? `${s.heading}\n${s.body}` : s.body).join('\n\n').slice(0, 3000);
}

// ──────────────────────────────────────────────────────────────
// Fetch
// ──────────────────────────────────────────────────────────────

async function fetchFeed() {
  console.log(`🔍 Fetching Atom feed from ${FEED_URL} ...`);
  const res = await fetchWithRetry(FEED_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/atom+xml, application/xml, text/xml' },
  });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const entries = parseAtomEntries(xml);
  console.log(`📋 Total entries in feed: ${entries.length}`);
  return entries;
}

// ──────────────────────────────────────────────────────────────
// Build
// ──────────────────────────────────────────────────────────────

function buildJob(entry, detailDescription = null) {
  const title = entry.title || '';
  const link = entry.link || '';
  // Extract job ID from URL (e.g., j1657 from "...-de-j1657.html")
  const jobIdMatch = link.match(/j(\d+)\.html/);
  const jobId = jobIdMatch ? jobIdMatch[1] : '';
  const slug = slugify(`${title}-stadt-chur-${jobId}`);

  const summaryText = stripHtml(entry.summary || '');
  const description = (detailDescription || summaryText).slice(0, 3000);
  const sourceLang = detectLang(title + ' ' + description) || 'de';
  const category = inferCategory(entry.category, title);
  const empType = mapEmploymentType(title);

  let postedDate = todayIso();
  if (entry.updated) {
    try {
      const d = new Date(entry.updated);
      if (!isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
    } catch { /* keep default */ }
  }

  return {
    title,
    slug,
    url: link,
    applyUrl: link,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: 'Chur',
    addressLocality: 'Chur',
    addressRegion: 'Graubünden',
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category,
    sector: 'Pubblica Amministrazione',
    department: entry.category || '',
    source: 'stadt-chur-dedicated-crawler',
    sourceLang,
    postedDate,
    validThrough: '',
    employmentType: empType,
    contractType: empType === 'internship' || empType === 'apprenticeship' ? 'stage' : empType === 'temporary' ? 'temporaneo' : 'permanent',
    description,
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
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
  registerCrawlerSummaryGuard(COMPANY_KEY, 'stadt-chur');
  console.log(`\n⚡ Stadt Chur — Dedicated Job Crawler`);
  console.log(`   Source: Rexx Systems ATS (jobs.chur.ch)`);
  console.log(`   Company key: ${COMPANY_KEY}\n`);

  // Validate adapter
  const adapter = readJson(ADAPTER_PATH, null);
  if (!adapter || !adapter.enabled) {
    console.warn('⚠️ Adapter not found or disabled — exiting.');
    process.exit(0);
  }

  // Phase 1 — Fetch feed
  console.log('═══════════════════════════════════════');
  console.log('Phase 1: Fetch Atom feed');
  console.log('═══════════════════════════════════════');
  const entries = await fetchFeed();

  if (entries.length === 0) {
    console.log('ℹ️ No jobs found in feed — nothing to update.');
    process.exit(0);
  }

  for (const entry of entries) {
    console.log(`  📄 ${entry.title} | ${entry.category}`);
  }

  // Phase 2 — Build + enrich from detail pages
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 2: Build jobs + fetch details');
  console.log('═══════════════════════════════════════');
  const jobs = [];
  for (const entry of entries) {
    console.log(`  🔗 Fetching detail: ${entry.title} ...`);
    const html = await fetchDetailPage(entry.link);
    const detailDesc = parseDetailPage(html);
    jobs.push(buildJob(entry, detailDesc));
    if (entries.indexOf(entry) < entries.length - 1) await sleep(DETAIL_DELAY_MS);
  }
  console.log(`📊 Built ${jobs.length} job objects`);

  // Phase 3 — Merge
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 3: Merge');
  console.log('═══════════════════════════════════════');
  const stats = mergeJobs(jobs);
  const diff = stats.diff;
  console.log(`\n📈 Result: ${stats.targetCount} Stadt Chur jobs (${stats.added} new, ${stats.updated} updated)`);
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
    strictEnvVar: 'JOBS_CHUR_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    failWhenNoJobs: true,
    noJobsMessage: 'No Stadt Chur jobs found after dedicated crawl.',
  });

  // Phase 5 — Summary
  printPublishedJobUrls(jobs);
  writeJobsSummary(COMPANY_KEY, stats);

  console.log('\n✅ Stadt Chur crawler complete.\n');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'stadt-chur',
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
  // Handle connection failures gracefully — jobs.chur.ch may block non-Swiss IPs
  const isConnectError = err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
    || err?.message?.includes('ConnectTimeoutError')
    || err?.message?.includes('fetch failed');
  if (isConnectError) {
    console.warn('⚠️ Cannot connect to jobs.chur.ch — server may restrict access to Swiss IPs.');
    console.warn('   Crawler will exit gracefully. Run manually from a Swiss network.');
    process.exit(0);
  }
  console.error('❌ Fatal crawler error:', err);
  process.exit(1);
});
