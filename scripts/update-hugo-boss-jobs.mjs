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
import { resolveFallbackAddress } from '../build-plugins/shared/companyHqAddresses.mjs';
import { resolveLocalityAddress } from './lib/swiss-structured-address.mjs';
import { exitCrawlerOnError, fetchHtml as sharedFetchHtml } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceLangOfBody, sourceSlotTitleAndSlug } from './lib/source-locale-slots.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { assertHugoBossNationalReadComplete, extractPhenomDdo, parseSearchPage, isHugoBossTargetLocation, buildDetailUrl, detectCategory, detectExperienceLevel, inferEmploymentType } from './lib/hugo-boss-job-parser.mjs';
import { inferAnyCanton, isKnownSwissCity } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';
import { isAuthoritativeEmptySnapshot, markAuthoritativeEmptySnapshot } from './lib/authoritative-empty-snapshot.mjs';

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
const DUPLICATE_PAGE_RETRIES = 2;
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
  try {
    return await sharedFetchHtml(url, {
      timeoutMs,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,it-CH;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
}

function slugify(value = '') {
  const slug = String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 200);
}

function rawHugoRecordKey(job = {}) {
  const id = [job.jobId, job.reqId]
    .map((value) => String(value ?? '').trim())
    .find(Boolean);
  return id ? `id:${id}` : '';
}

export async function fetchJobs({ fetchHtml = fetchPage } = {}) {
  console.log(`🔍 Fetching Hugo Boss jobs from ${CAREERS_URL}`);
  const allJobsById = new Map();
  const seenRawRecordKeys = new Set();
  let from = 0;
  let totalHits = null;
  let recordsSeen = 0;
  let terminationProven = false;
  let terminationReason = null;
  let maxObserved = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageUrl = new URL(CAREERS_URL);
    pageUrl.searchParams.set('from', String(from));
    pageUrl.searchParams.set('pageSize', String(PAGE_SIZE));
    let html = await fetchHtml(pageUrl.href, 25000);
    if (!html) {
      if (page === 0) console.error('❌ Failed to fetch Hugo Boss careers page.');
      break;
    }
    let rawPageJobs;
    let rawPageCount;
    let uniquePageRecordKeys;
    let newRecordKeys;
    for (let duplicateRetry = 0; ; duplicateRetry += 1) {
      const ddo = extractPhenomDdo(html);
      const reportedTotal = Number(
        ddo?.eagerLoadRefineSearch?.data?.totalHits
        ?? ddo?.eagerLoadRefineSearch?.data?.total
        ?? ddo?.eagerLoadRefineSearch?.totalHits
        ?? 0,
      );
      if (reportedTotal > 0) totalHits = reportedTotal;
      rawPageJobs = ddo?.eagerLoadRefineSearch?.data?.jobs;
      if (!Array.isArray(rawPageJobs)) {
        const coverage = totalHits === null
          ? 'totalHits is unavailable to confirm national coverage'
          : `declared totalHits=${totalHits} cannot confirm coverage after a missing DDO envelope`;
        throw new Error(
          `Hugo Boss page ${page + 1} is missing a valid Phenom DDO/data envelope `
          + `(expected eagerLoadRefineSearch.data.jobs); ${coverage}. `
          + 'Aborting without a proven terminal page.',
        );
      }
      rawPageCount = rawPageJobs.length;
      const pageRecordKeys = rawPageJobs.map(rawHugoRecordKey);
      if (pageRecordKeys.some((key) => !key)) {
        throw new Error(
          `Hugo Boss national DDO page ${page + 1} contains a record without a stable record identity (jobId/reqId). `
          + 'Refusing to count a source row that the final deduplication map cannot retain.',
        );
      }
      uniquePageRecordKeys = [...new Set(pageRecordKeys)];
      newRecordKeys = uniquePageRecordKeys.filter((key) => !seenRawRecordKeys.has(key));
      const madeNoProgress = uniquePageRecordKeys.length !== pageRecordKeys.length
        || newRecordKeys.length !== uniquePageRecordKeys.length;
      if (!madeNoProgress) break;
      if (duplicateRetry >= DUPLICATE_PAGE_RETRIES) {
        terminationReason = 'duplicate-page';
        maxObserved = true;
        console.warn(
          `⚠️ Hugo Boss national DDO page ${page + 1} made no progress after `
          + `${DUPLICATE_PAGE_RETRIES} retries; publishing the maximum observed deduplicated snapshot.`,
        );
        break;
      }
      console.warn(
        `⚠️ Hugo Boss national DDO page ${page + 1} repeated previously seen records; `
        + `retrying (${duplicateRetry + 1}/${DUPLICATE_PAGE_RETRIES}).`,
      );
      html = await fetchHtml(pageUrl.href, 25000);
      if (!html) {
        throw new Error(
          `Hugo Boss national DDO page ${page + 1} could not be refetched after a duplicated response. `
          + 'Aborting without a proven terminal page.',
        );
      }
    }
    for (const key of newRecordKeys) seenRawRecordKeys.add(key);
    const pageRecordCount = uniquePageRecordKeys.length;
    const pageJobs = parseSearchPage(html);
    if (rawPageCount > 0 && pageJobs.length !== rawPageCount) {
      throw new Error(
        `Hugo Boss page ${page + 1} parsed ${pageJobs.length} of ${rawPageCount} DDO records. `
        + 'A non-empty source page lost records (likely title/field drift); refusing to treat the result as an empty snapshot.',
      );
    }
    console.log(`  📄 Page ${page + 1}: ${pageJobs.length} parsed jobs from ${rawPageCount} DDO records (from=${from}${totalHits ? `, total=${totalHits}` : ''})`);
    for (const job of pageJobs) {
      const key = rawHugoRecordKey(job);
      if (key && !allJobsById.has(key)) allJobsById.set(key, job);
    }
    if (maxObserved) {
      recordsSeen += newRecordKeys.length;
      break;
    }
    // A short page is NOT proof that the result set ended: the Phenom DDO
    // serves short pages mid-set while still declaring a higher totalHits, and
    // a missing total cannot prove that the page was the final one. Stop only
    // on a genuinely empty page or once the declared total has been reached.
    if (pageRecordCount === 0) {
      terminationProven = true;
      break;
    }
    recordsSeen += newRecordKeys.length;
    from += newRecordKeys.length;
    if (totalHits !== null && recordsSeen >= totalHits) {
      terminationProven = true;
      break;
    }
  }

  const allJobs = [...allJobsById.values()];
  console.log(`  📋 Total jobs in national DDO: ${allJobs.length}`);

  // A partial read cannot prove the absence of Swiss jobs. The only tolerated
  // exception is the explicit duplicate-page contract: after bounded retries
  // we publish the maximum deduplicated snapshot observed so far and expose
  // the degraded coverage in the attached audit metadata.
  const readAudit = assertHugoBossNationalReadComplete({
    terminationProven,
    totalHits,
    recordsSeen,
    terminationReason,
    allowMaxObserved: maxObserved,
  });

  const swissJobs = allJobs.filter(isHugoBossTargetLocation);
  console.log(`  🎯 Swiss jobs across all cantons: ${swissJobs.length}`);

  const mapped = swissJobs.map((raw) => {
    const canton = inferAnyCanton([
      raw.city,
      raw.state,
      raw.cityState,
      raw.cityStateCountry,
      raw.address,
    ].filter(Boolean).join(' '));
    if (!canton) return null;

    // Country-only/canton-only source values are not localities. Accept a
    // source address only when raw.city resolves to a concrete Swiss city;
    // otherwise use the coherent canton fallback as the locality too.
    const sourceCity = isKnownSwissCity(raw.city, canton) ? raw.city : '';
    const fallbackAddress = resolveFallbackAddress(undefined, sourceCity, canton);
    // Una città reale senza via/NPA resta la località della vacancy: il
    // capoluogo di ripiego la sostituiva (issue 5253).
    const resolvedAddress = sourceCity && raw.address && raw.postalCode
      ? {
        addressLocality: sourceCity,
        streetAddress: raw.address,
        postalCode: raw.postalCode,
      }
      : sourceCity
        ? resolveLocalityAddress({ city: sourceCity, canton })
        : fallbackAddress;
    const location = resolvedAddress.addressLocality;
    const detailUrl = buildDetailUrl(raw);
    const locationToken = location || canton;
    const slug = slugify(`${raw.title} hugo-boss ${locationToken}`);
    // Title, body and slug in the posting's own language slot, read from the
    // body (a fixed `en` filed Italian and German postings as English).
    const sourceLang = sourceLangOfBody(raw.description, 'en');
    return {
      url: detailUrl || CAREERS_URL,
      applyUrl: raw.applyUrl ? `https://${COMPANY_HOST}${raw.applyUrl}` : detailUrl,
      title: raw.title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location,
      canton,
      country: 'CH',
      addressLocality: resolvedAddress.addressLocality,
      addressRegion: canton,
      addressCountry: 'CH',
      postalCode: resolvedAddress.postalCode,
      streetAddress: resolvedAddress.streetAddress,
      description: raw.description || `${raw.title} position at Hugo Boss in ${locationToken}, Switzerland.`,
      ...sourceSlotTitleAndSlug(raw.title, slug, sourceLang),
      descriptionByLocale: { [sourceLang]: raw.description || '' },
      slug,
      category: detectCategory(raw.title),
      datePosted: raw.postedDate || new Date().toISOString().split('T')[0],
      source: 'hugo-boss-careers-crawler',
      sourceLang,
      employmentType: inferEmploymentType(raw.title, raw.description),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Moda / Lusso',
    };
  }).filter(Boolean);
  const authoritativeEmptySnapshot = readAudit.complete && swissJobs.length === 0;
  if (authoritativeEmptySnapshot) {
    markAuthoritativeEmptySnapshot(
      mapped,
      `Completed national Phenom DDO read (${allJobs.length} parsed records; `
      + `totalHits=${totalHits ?? 'not reported'}); no Swiss postings matched the crawler scope.`,
    );
  }
  Object.defineProperty(mapped, 'hugoBossSnapshot', {
    value: Object.freeze({
      ...readAudit,
      totalHits,
      recordsSeen,
      discovered: allJobs.length,
      published: mapped.length,
      targetMatches: swissJobs.length,
      authoritativeEmptySnapshot,
    }),
    enumerable: false,
  });
  return mapped;
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
  // Non-source slots the merge kept that are not in their own language go
  // back to the translation pipeline.
  for (const job of merged) dropStaleLocaleDescriptions(job);

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

async function publishAuthoritativeEmptySnapshot({ beforeSnapshot, discovered }) {
  const snapshot = discovered.hugoBossSnapshot || {};
  const diff = computeCrawlDiff(beforeSnapshot, new Map());
  const durationMs = getCrawlerElapsedMs();

  updateAdapterConfig([]);
  const archived = archiveRemovedJobsToSlice(diff.removedJobs, COMPANY_KEY);
  // Clear the per-crawler scratch slice before emitting the verified empty
  // slice. This keeps a later base-crawler/localization pass from seeing the
  // retired jobs through the runner's private input path.
  await mergeJobs([]);
  writeJobsCrawlerSlice(COMPANY_KEY, [], { skipShrinkGuard: true });
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: COMPANY_NAME,
    generatedAt: new Date().toISOString(),
    total: 0,
    discovered: snapshot.discovered ?? 0,
    parsed: snapshot.published ?? 0,
    written: 0,
    lastFetchOutcome: 'ok',
    authoritativeEmptySnapshot: true,
    authoritativeSnapshotVerified: true,
    coverage: snapshot.coverage || 'complete',
    terminationReason: snapshot.terminationReason || null,
    sourceRecordsSeen: snapshot.recordsSeen ?? null,
    sourceTotalHits: snapshot.totalHits ?? null,
    newCount: 0,
    updatedCount: 0,
    removedCount: diff.removedJobs.length,
    unchangedCount: 0,
    durationMs,
    avgDurationMs: durationMs,
    durationHistory: [durationMs],
    newJobs: [],
    updatedJobs: [],
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: [],
  });
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  await assembleJobsDataset();
  console.log(`ℹ️ Persisted authoritative Hugo Boss zero; archived ${archived} expired route(s).`);
}

async function main() {
  setCrawlerStartTime();
  const summaryCounts = { discovered: null, parsed: null, lastFetchOutcome: null, abortKind: null };
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME, summaryCounts);
  console.log('═══════════════════════════════════════════════');
  console.log('  Hugo Boss — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));

  const discovered = await fetchJobs();
  const snapshot = discovered.hugoBossSnapshot || {};
  summaryCounts.discovered = Number.isFinite(snapshot.discovered) ? snapshot.discovered : 0;
  summaryCounts.parsed = Number.isFinite(snapshot.published) ? snapshot.published : 0;
  if (discovered.length === 0) {
    if (isAuthoritativeEmptySnapshot(discovered)) {
      console.log('ℹ️ Hugo Boss national DDO completed with no Swiss postings; publishing an authoritative empty snapshot.');
      await publishAuthoritativeEmptySnapshot({ beforeSnapshot, discovered });
      return;
    }
    summaryCounts.abortKind = 'no-jobs-parsed';
    console.log('⚠️ Hugo Boss produced no publishable jobs without a proven empty-source snapshot; keeping existing data.');
    return;
  }

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
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, discovered: snapshot.discovered ?? null, parsed: snapshot.published ?? null, written: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], coverage: snapshot.coverage || 'complete', terminationReason: snapshot.terminationReason || null, sourceRecordsSeen: snapshot.recordsSeen ?? null, sourceTotalHits: snapshot.totalHits ?? null, authoritativeSnapshotVerified: snapshot.complete === true, newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Hugo Boss crawler complete.');
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => exitCrawlerOnError(err, 'Hugo Boss'));
}
