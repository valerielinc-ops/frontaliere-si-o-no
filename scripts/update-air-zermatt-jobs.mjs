#!/usr/bin/env node
/**
 * Dedicated Air Zermatt AG (Raron/Zermatt, VS) crawler runner.
 *
 * Air Zermatt career page: https://www.air-zermatt.ch/jobs
 * Detail pages: https://www.air-zermatt.ch/de/service/offene-stellen/{slug}-{id}
 *
 * Small helicopter services company in Valais. Typically 2-5 positions.
 * Jobs are in Raron (base) and Zermatt (operations).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice, registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs } from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang } from './lib/dedicated-crawler-common.mjs';
import { parseListingPage, parseDetailPage, slugify, detectCategory, detectExperienceLevel, inferEmploymentType } from './lib/air-zermatt-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'air-zermatt';
const HQ = getCompanyDefaults('air-zermatt');
const COMPANY_NAME = 'Air Zermatt AG';
const COMPANY_HOST = 'www.air-zermatt.ch';
const CAREERS_URL = 'https://www.air-zermatt.ch/jobs';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }

function isCompanyJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('air zermatt') || company.includes('air-zermatt') || url.includes('air-zermatt.ch');
}

function isTrustedDomain(rawUrl = '') {
  try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('air-zermatt.ch'); } catch { return false; }
}

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de,it;q=0.9,en;q=0.8', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`  HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`  Fetch failed: ${err.message}`); return null; }
}

async function fetchJobs() {
  console.log(`  Fetching Air Zermatt jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('  Failed to fetch Air Zermatt careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    // Fetch detail page for full description
    let description = listing.snippet || '';
    if (listing.url) {
      const detailHtml = await fetchPage(listing.url);
      if (detailHtml) {
        const detail = parseDetailPage(detailHtml);
        if (detail.body && detail.body.length > description.length) {
          description = detail.body;
        }
      }
    }

    const slug = slugify(listing.title, 'air-zermatt');
    const location = listing.location || 'Raron';
    const canton = /zermatt/i.test(location) ? 'VS' : HQ.canton;

    jobs.push({
      url: listing.url,
      applyUrl: listing.url,
      title: listing.title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location,
      canton,
      country: 'CH',
      addressLocality: location.split('/')[0].trim(),
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      postalCode: HQ.postalCode,
      streetAddress: 'Heliport',
      description,
      titleByLocale: { de: listing.title },
      descriptionByLocale: {},
      slug,
      slugByLocale: { de: slug, it: slug },
      category: detectCategory(listing.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'air-zermatt-careers-crawler',
      employmentType: inferEmploymentType(listing.title, listing.snippet || ''),
      sourceLang: detectLang(listing.title, 'de'),
      experienceLevel: detectExperienceLevel(listing.title),
      sector: 'Aviazione / Servizi di soccorso',
    });
  }
  return jobs;
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingByUrl = new Map();
  for (const job of (Array.isArray(existing) ? existing : []).filter(isCompanyJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const merged = [];
  let added = 0, updated = 0;
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url);
    const old = existingByUrl.get(key);
    if (old) {
      merged.push({
        ...old,
        ...d,
        titleByLocale: mergeLocaleTextMap(old.titleByLocale, d.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(old.descriptionByLocale, d.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(old.slugByLocale, d.slugByLocale, 3),
        previousSlugs: [...new Set([...(old.previousSlugs || []), ...(d.previousSlugs || [])])].slice(0, 20),
      });
      updated++;
    } else {
      merged.push(d);
      added++;
    }
  }
  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`  Merge: +${added}, ~${updated}, ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html'],
    seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL],
    notes: 'Air Zermatt AG — helicopter services and rescue in Valais. CMS listing module with MixItUp filtering.',
    updatedAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Air Zermatt AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('  No Air Zermatt jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n  Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_AIR_ZERMATT_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_air_zermatt_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n  Air Zermatt crawler complete.');
}

main().catch((err) => { console.error(`  Air Zermatt crawler failed: ${err?.message || err}`); process.exit(1); });
