#!/usr/bin/env node
/**
 * Dedicated Hugo Boss Switzerland crawler runner.
 *
 * Hugo Boss uses the Phenom People platform at careers.hugoboss.com.
 * Job data is embedded in the phApp.ddo JavaScript object on the search
 * results page. We fetch the national result set and filter Swiss positions
 * with the shared location helper.
 *
 * Discovery flow:
 *   1. Fetch the unfiltered national search endpoint
 *   2. Extract phApp.ddo.eagerLoadRefineSearch.data.jobs
 *   3. Filter for Swiss positions across all 26 cantons
 *   4. Build job objects with detail URLs
 *   5. Merge into data/jobs.json
 *   6. Run base crawler for AI localization
 *   7. Post-process and validate
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveFallbackAddress } from '../build-plugins/shared/companyHqAddresses.ts';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { assertHugoBossNationalReadComplete, extractPhenomDdo, parseSearchPage, isHugoBossTargetLocation, buildDetailUrl, detectCategory, detectExperienceLevel, inferEmploymentType } from './lib/hugo-boss-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'hugo-boss';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Hugo Boss';
const COMPANY_HOST = 'careers.hugoboss.com';
const CAREERS_URL = 'https://careers.hugoboss.com/global/en/search-results?keywords=';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(value = '') { return String(value || '').trim().toLowerCase(); }

function isCompanyJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('hugo-boss') || company.includes('hugo boss') || url.includes('hugoboss.com');
}

function isTrustedDomain(rawUrl = '') {
  try { return new URL(rawUrl).hostname.toLowerCase().includes('hugoboss.com'); } catch { return false; }
}

async function fetchPage(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
  finally { clearTimeout(timer); }
}

function slugify(value = '') {
  const slug = String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 200);
}

export async function fetchJobs({ fetchHtml = fetchPage } = {}) {
  console.log(`🔍 Fetching Hugo Boss jobs from ${CAREERS_URL}`);
  const allJobsById = new Map();
  let from = 0;
  let totalHits = null;
  let recordsSeen = 0;
  let terminationProven = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageUrl = new URL(CAREERS_URL);
    pageUrl.searchParams.set('from', String(from));
    pageUrl.searchParams.set('pageSize', String(PAGE_SIZE));
    const html = await fetchHtml(pageUrl.href, 25000);
    if (!html) {
      if (page === 0) console.error('❌ Failed to fetch Hugo Boss careers page.');
      break;
    }
    const ddo = extractPhenomDdo(html);
    const reportedTotal = Number(
      ddo?.eagerLoadRefineSearch?.data?.totalHits
      ?? ddo?.eagerLoadRefineSearch?.data?.total
      ?? ddo?.eagerLoadRefineSearch?.totalHits
      ?? 0,
    );
    if (reportedTotal > 0) totalHits = reportedTotal;
    const rawPageJobs = ddo?.eagerLoadRefineSearch?.data?.jobs;
    const rawPageCount = Array.isArray(rawPageJobs) ? rawPageJobs.length : 0;
    const pageJobs = parseSearchPage(html);
    console.log(`  📄 Page ${page + 1}: ${pageJobs.length} parsed jobs from ${rawPageCount} DDO records (from=${from}${totalHits ? `, total=${totalHits}` : ''})`);
    for (const job of pageJobs) {
      const key = job.jobId || job.reqId;
      if (key && !allJobsById.has(key)) allJobsById.set(key, job);
    }
    // A short page is NOT proof that the result set ended: the Phenom DDO
    // serves short pages mid-set while still declaring a higher totalHits.
    // Stop only on a genuinely empty page (no forward progress possible) or
    // once the declared total has been reached; fall back to the short-page
    // heuristic only when the portal declares no total at all.
    if (rawPageCount === 0) {
      terminationProven = true;
      break;
    }
    recordsSeen += rawPageCount;
    from += rawPageCount;
    if (totalHits !== null && recordsSeen >= totalHits) {
      terminationProven = true;
      break;
    }
    if (totalHits === null && rawPageCount < PAGE_SIZE) {
      terminationProven = true;
      break;
    }
  }

  const allJobs = [...allJobsById.values()];
  console.log(`  📋 Total jobs in national DDO: ${allJobs.length}`);

  // A partial read cannot prove the absence of Swiss jobs — the missing
  // records may be exactly the ones we are looking for. Fail loudly rather
  // than publish "0 Swiss jobs" derived from a truncated result set.
  assertHugoBossNationalReadComplete({ terminationProven, totalHits, recordsSeen });

  const swissJobs = allJobs.filter(isHugoBossTargetLocation);
  console.log(`  🎯 Swiss jobs across all cantons: ${swissJobs.length}`);

  return swissJobs.map((raw) => {
    const location = raw.city || raw.cityState || raw.cityStateCountry || '';
    const canton = inferAnyCanton([
      raw.city,
      raw.state,
      raw.cityState,
      raw.cityStateCountry,
      raw.address,
    ].filter(Boolean).join(' '));
    if (!canton) return null;
    const fallbackAddress = resolveFallbackAddress(undefined, location, canton);
    const detailUrl = buildDetailUrl(raw);
    const locationToken = location || canton;
    const slug = slugify(`${raw.title} hugo-boss ${locationToken}`);
    return {
      url: detailUrl || CAREERS_URL,
      applyUrl: raw.applyUrl ? `https://${COMPANY_HOST}${raw.applyUrl}` : detailUrl,
      title: raw.title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location,
      canton,
      country: 'CH',
      addressLocality: raw.city || location,
      addressRegion: canton,
      addressCountry: 'CH',
      postalCode: raw.postalCode || fallbackAddress.postalCode,
      streetAddress: raw.address || fallbackAddress.streetAddress,
      description: raw.description || `${raw.title} position at Hugo Boss in ${locationToken}, Switzerland.`,
      titleByLocale: { en: raw.title },
      descriptionByLocale: { en: raw.description || '' },
      slug,
      slugByLocale: { en: slug, it: slug },
      category: detectCategory(raw.title),
      datePosted: raw.postedDate || new Date().toISOString().split('T')[0],
      source: 'hugo-boss-careers-crawler',
      sourceLang: detectLang(raw.description || raw.title, 'en'),
      employmentType: inferEmploymentType(raw.title, raw.description),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Moda / Lusso',
    };
  }).filter(Boolean);
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isCompanyJob(j));
  const existingCompanyJobs = allJobs.filter(isCompanyJob);

  const existingKeys = new Set(
    existingCompanyJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const discoveredKeys = new Set(
    discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
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
  console.log(`📦 Merge: ➕ ${added} added, 🔄 ${updated} updated, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const adapter = fs.existsSync(adapterPath) ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) : {};
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html', 'jsonld'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'Phenom People platform — jobs extracted from phApp.ddo in search results page.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Hugo Boss — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const discovered = await fetchJobs();
  if (discovered.length === 0) { console.log('⚠️ No Hugo Boss jobs discovered. Keeping existing.'); return; }

  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);

  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_HUGO_BOSS_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_hugoboss_domain', failWhenNoJobs: false });

  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  const _durationMs = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Hugo Boss crawler complete.');
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => exitCrawlerOnError(err, 'Hugo Boss'));
}
