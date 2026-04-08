#!/usr/bin/env node
/**
 * Dedicated Casale SA (Lugano, TI) crawler runner.
 *
 * Casale uses Recruitee platform at recruit.casale.ch.
 * API endpoint: https://casale.recruitee.com/api/offers
 * Fallback HTML: https://recruit.casale.ch/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, mergeLocaleTextMap } from './lib/dedicated-crawler-common.mjs';
import { parseApiResponse, buildJobFromApi, parseListingPage, slugify, detectCategory, detectExperienceLevel } from './lib/casale-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'casale';
const COMPANY_NAME = 'Casale SA';
const COMPANY_HOST = 'recruit.casale.ch';
const API_URL = 'https://casale.recruitee.com/api/offers';
const CAREERS_URL = 'https://recruit.casale.ch/';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }
function isCompanyJob(job) {
  const key = normalize(job?.companyKey || ''); const company = normalize(job?.company || ''); const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('casale') || company.includes('casale') || url.includes('casale');
}
function isTrustedDomain(rawUrl = '') { try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('casale'); } catch { return false; } }

async function fetchJson(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    clearTimeout(timer); if (!res.ok) { console.warn(`⚠️ HTTP ${res.status}`); return null; } return await res.json();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
}

async function fetchJobs() {
  console.log(`🔍 Fetching Casale SA jobs from API: ${API_URL}`);
  const apiData = await fetchJson(API_URL, 25000);
  if (!apiData) { console.error('❌ Failed to fetch Casale API.'); return []; }

  const swissOffers = parseApiResponse(apiData);
  console.log(`  📋 Swiss offers: ${swissOffers.length}`);

  return swissOffers.map((offer) => {
    const built = buildJobFromApi(offer);
    const slug = slugify(`${built.title} casale ${built.city}`);
    const fallbackDesc = `${built.title} — posizione aperta presso Casale SA a Lugano, Canton Ticino, Svizzera. Casale SA è un'azienda globale di ingegneria con sede a Lugano, specializzata nella progettazione e costruzione di impianti per la produzione di fertilizzanti e prodotti chimici. L'azienda offre un ambiente di lavoro stimolante e internazionale nel cuore del Ticino.`;
    const description = (built.description && built.description.length >= 220) ? built.description : (built.description || fallbackDesc);
    return {
      url: built.detailUrl, applyUrl: built.applyUrl, title: built.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: built.location || 'Lugano', canton: 'TI', country: 'CH',
      addressLocality: built.city || 'Lugano', addressRegion: 'TI', addressCountry: 'CH',
      postalCode: '6900', streetAddress: 'Via Giulio Pocobelli 6',
      description,
      titleByLocale: { en: built.title }, descriptionByLocale: {},
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(built.title),
      datePosted: built.datePosted,
      source: 'casale-careers-crawler', sourceLang: detectLang(description || built.title, 'en'), employmentType: built.employmentType,
      experienceLevel: detectExperienceLevel(built.title),
      sector: 'Ingegneria / Chimica',
      _targetScope: { canton: 'TI', location: built.city || 'Lugano' },
    };
  });
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingByUrl = new Map();
  for (const job of (Array.isArray(existing) ? existing : []).filter(isCompanyJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const merged = []; let added = 0, updated = 0;
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url); const old = existingByUrl.get(key);
    if (old) { merged.push({
      ...old,
      ...d,
      titleByLocale: mergeLocaleTextMap(old.titleByLocale, d.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(old.descriptionByLocale, d.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(old.slugByLocale, d.slugByLocale, 3),
      previousSlugs: [...new Set([...(old.previousSlugs || []), ...(d.previousSlugs || [])])].slice(0, 20),
    }); updated++; }
    else { merged.push(d); added++; }
  }
  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`📦 Merge: ➕ ${added}, 🔄 ${updated}, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html', 'jsonld'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'Recruitee platform — Casale SA engineering jobs in Lugano, TI.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Casale SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Casale Swiss jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_CASALE_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_casale_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Casale SA crawler complete.');
}

main().catch((err) => { console.error(`❌ Casale crawler failed: ${err?.message || err}`); process.exit(1); });
