#!/usr/bin/env node
/**
 * Dedicated Casale SA (Lugano, TI) crawler runner.
 *
 * Casale uses Recruitee platform at recruit.casale.ch.
 * API endpoint: https://casale.recruitee.com/api/offers
 * Fallback HTML: https://recruit.casale.ch/
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseApiResponse, buildJobFromApi, buildCasaleDescriptionFields, parseListingPage, slugify, detectCategory, detectExperienceLevel } from './lib/casale-job-parser.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { dropFabricatedDescription } from './lib/drop-fabricated-description.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'casale';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const HQ = getCompanyDefaults(COMPANY_KEY);
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
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status}`); return null; } return await res.json();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; } finally { clearTimeout(timer); }
}

async function fetchJobs() {
  console.log(`🔍 Fetching Casale SA jobs from API: ${API_URL}`);
  const apiData = await fetchJson(API_URL, 25000);
  if (!apiData) { console.error('❌ Failed to fetch Casale API.'); return []; }

  const swissOffers = parseApiResponse(apiData);
  console.log(`  📋 Swiss offers: ${swissOffers.length}`);

  return swissOffers.map((offer) => {
    const built = buildJobFromApi(offer);
    // Slug-only guard: `built.city` can be the literal "undefined"/"null" string
    // (truthy) → `-undefined` in an active slug (#952, class #900/#901). location/
    // addressLocality keep raw `built.city` (choke-point normalizer owns de-index).
    const slug = slugify(`${built.title} casale ${safeLocationToken(built.city, 'Lugano')}`);
    // Source text only, in its own slot (issue 5253): see buildCasaleDescriptionFields.
    const { description, descriptionByLocale, sourceLang } = buildCasaleDescriptionFields(built);
    return {
      url: built.detailUrl, applyUrl: built.applyUrl, title: built.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: built.location || 'Lugano', canton: HQ.canton, country: 'CH',
      addressLocality: built.city || 'Lugano', addressRegion: HQ.addressRegion, addressCountry: 'CH',
      postalCode: HQ.postalCode, streetAddress: 'Via Giulio Pocobelli 6',
      description,
      titleByLocale: { en: built.title }, descriptionByLocale,
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(built.title),
      datePosted: built.datePosted,
      source: 'casale-careers-crawler', sourceLang, employmentType: built.employmentType,
      experienceLevel: detectExperienceLevel(built.title),
      sector: 'Ingegneria / Chimica',
      _targetScope: { canton: HQ.canton, location: built.city || 'Lugano' },
    };
  });
}

// The text the runner used to publish INSTEAD of an offer under 220 characters:
// "<title> — posizione aperta presso Casale SA a Lugano… Casale SA è un'azienda globale…".
// Only ever recognised, to be removed from stored records (issue 5253).
const CASALE_FABRICATED_RE = /posizione aperta presso Casale SA a Lugano|Casale SA è un'azienda globale di ingegneria con sede a Lugano/;

/**
 * Remove, from a stored job, the text this runner used to write itself
 * (CASALE_FABRICATED_RE): the slots that carry it, the flat
 * `description`, and the translations made from it, flagging the job for
 * retranslation (`dropFabricatedDescription`). The merge keeps stored locale
 * slots, so without this they would outlive the fix; the runner calls it on
 * its stored jobs right before the merge.
 *
 * @returns {boolean} true when the job changed.
 */
export function dropCasaleFabricatedText(job) {
  return dropFabricatedDescription(job, CASALE_FABRICATED_RE);
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingCompanyJobs = (Array.isArray(existing) ? existing : []).filter(isCompanyJob);
  const fossils = existingCompanyJobs.filter((job) => dropCasaleFabricatedText(job)).length;
  if (fossils > 0) console.log(`  🧹 Removed the former invented description from ${fossils} stored Casale job(s); they will be retranslated`);

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
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html', 'jsonld'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'Recruitee platform — Casale SA engineering jobs in Lugano, TI.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

// The zero-job exits keep the stored slice: remove from it the text the
// crawler once wrote, as the merge does (stored-jobs-soft-exit.mjs).
function cleanStoredJobsOnSoftExit() {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => { for (const job of jobs) dropCasaleFabricatedText(job); },
    storedJobs: readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob),
    companyKey: COMPANY_KEY,
    companyLabel: COMPANY_NAME,
    write: (jobs) => writeJobsCrawlerSlice(COMPANY_KEY, jobs),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Casale SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Casale Swiss jobs discovered.'); await cleanStoredJobsOnSoftExit(); return; }
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
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Casale SA crawler complete.');
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Casale'));
}
