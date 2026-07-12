#!/usr/bin/env node
/**
 * Dedicated Interroll Group (Sant'Antonino, TI) crawler runner.
 *
 * Interroll uses TYPO3 CMS with a custom jobs page at:
 *   https://www.interroll.com/company/careers/jobs/
 * Detail pages at: /company/careers/jobs/job-detail/{slug}
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseListingPage, isSwissLocation, slugify, detectCategory, detectExperienceLevel, inferEmploymentType } from './lib/interroll-job-parser.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'interroll';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Interroll Group';
const COMPANY_HOST = 'www.interroll.com';
const CAREERS_URL = 'https://www.interroll.com/company/careers/jobs/';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Interroll's only confirmed Swiss site is Sant'Antonino (HQ). Jobs surfaced
// at any other Swiss location must be skipped rather than mislabelled — the
// listing parser captures the city, the runner refuses to invent an address.
export const INTERROLL_SITES = [
  {
    key: 'sant-antonino',
    aliases: ['sant antonino', "sant'antonino", 'santantonino', "s. antonino", 's antonino'],
    location: "Sant'Antonino", addressLocality: "Sant'Antonino",
    canton: 'TI', addressRegion: 'TI', addressCountry: 'CH',
    postalCode: '6592', streetAddress: 'Via Gorelle 3',
  },
];

/**
 * Match a raw Interroll location string against the known sites registry.
 * Returns the site entry or null. Caller decides what to do with unknowns
 * (typically: skip with a log) — we never invent an address.
 */
export function resolveInterrollSiteAddress(rawLocation = '') {
  const text = String(rawLocation || '').toLowerCase().replace(/'/g, "'");
  for (const site of INTERROLL_SITES) {
    if (site.aliases.some((a) => text.includes(a))) return site;
  }
  return null;
}

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }
function isCompanyJob(job) {
  const key = normalize(job?.companyKey || ''); const company = normalize(job?.company || ''); const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('interroll') || company.includes('interroll') || url.includes('interroll.com');
}
function isTrustedDomain(rawUrl = '') { try { return new URL(rawUrl).hostname.toLowerCase().includes('interroll.com'); } catch { return false; } }

async function fetchPage(url, timeoutMs = 20000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,it-CH;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status}`); return null; } return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
  finally { clearTimeout(timer); }
}

async function fetchJobs() {
  console.log(`🔍 Fetching Interroll jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Interroll careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 Total jobs: ${listings.length}`);
  const swissJobs = listings.filter((j) => isSwissLocation(j.location));
  console.log(`  🇨🇭 Swiss jobs: ${swissJobs.length}`);

  const mapped = [];
  for (const raw of swissJobs) {
    const site = resolveInterrollSiteAddress(raw.location);
    if (!site) {
      console.log(`  ⏭️ Skipping job at unknown Interroll Swiss site: "${raw.title}" (${raw.location})`);
      continue;
    }
    const slug = slugify(raw.title, 'interroll');
    mapped.push({
      url: raw.url, applyUrl: raw.url, title: raw.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: site.location, canton: site.canton, country: 'CH',
      addressLocality: site.addressLocality, addressRegion: site.addressRegion, addressCountry: site.addressCountry,
      postalCode: site.postalCode, streetAddress: site.streetAddress,
      description: `${raw.title} position at Interroll Group in ${site.location}, ${site.canton}. Interroll is a global technology company providing material handling solutions.`,
      titleByLocale: { en: raw.title }, descriptionByLocale: {},
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(raw.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'interroll-careers-crawler', employmentType: inferEmploymentType(raw.title, raw.snippet || ''),
      sourceLang: detectLang(raw.title, 'en'),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Industria / Logistica',
    });
  }
  return mapped;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingCompanyJobs = (Array.isArray(existing) ? existing : []).filter(isCompanyJob);

  const existingKeys = new Set(existingCompanyJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingCompanyJobs, discoveredJobs);

  const final = [...nonCompanyJobs, ...merged];
  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);
  console.log(`📦 Merge: ➕ ${added}, 🔄 ${updated}, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: "TYPO3 CMS careers page — Interroll Group jobs in Sant'Antonino, TI.", updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Interroll Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Interroll Swiss jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_INTERROLL_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_interroll_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Interroll crawler complete.');
}

main().catch((err) => exitCrawlerOnError(err, 'Interroll'));
