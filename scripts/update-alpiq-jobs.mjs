#!/usr/bin/env node
/**
 * Dedicated Alpiq crawler runner.
 *
 * Source: https://www.alpiq.com/career/open-jobs
 * Alpiq is a major Swiss energy company with hydropower operations in Switzerland.
 * This crawler fetches all pages of listings and filters for Swiss jobs only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import {
  fetchAlpiqListingPages,
  slugify,
  inferEmploymentType,
  repairThinAlpiqLocaleDescriptions,
  dropAlpiqFabricatedText,
} from './lib/alpiq-job-parser.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { sourceLocaleDescription } from './lib/source-locale-description.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { getCantonPostalFallback } from './lib/canton-postal-fallback.mjs';
import { officialLocalityPostalCode } from './lib/swiss-locality-directory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'alpiq';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Alpiq';

// When the source exposes only "Switzerland", use Alpiq Holding's registered
// Lausanne office as the safe structured-data fallback. A concrete source
// locality uses the official directory and then the verified representative
// postal code for its inferred canton.
const ALPIQ_SAFE_DEFAULT_ADDRESS = {
  location: 'Lausanne',
  canton: 'VD',
  postalCode: '1003',
  streetAddress: 'Chemin de Mornex 10',
};
function resolveAlpiqPostalCode(location = '', canton = '') {
  return officialLocalityPostalCode(location, canton) || getCantonPostalFallback(canton)
    || ALPIQ_SAFE_DEFAULT_ADDRESS.postalCode;
}

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('alpiq.com');
}

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((j) => !isCompanyJob(j));
  const companyExisting = allJobs.filter((j) => isCompanyJob(j));
  const fabricatedFossils = companyExisting.filter((job) => dropAlpiqFabricatedText(job)).length;
  if (fabricatedFossils > 0) console.log(`  🧹 Removed the former crawler-written description from ${fabricatedFossils} stored Alpiq job(s); they will be retranslated`);
  const byUrl = new Map();
  for (const job of parsedJobs) { const k = String(job?.url || '').trim().replace(/\/+$/, ''); if (k) byUrl.set(k, job); }
  const deduped = [...byUrl.values()];
  const merged = mergePreserveLocaleData(companyExisting, deduped);
  const clean = merged.sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  const repairedLocaleDescriptions = repairThinAlpiqLocaleDescriptions(clean);
  if (repairedLocaleDescriptions > 0) {
    console.log(
      `🧹 Alpiq locale repair: replaced ${repairedLocaleDescriptions} thin locale copy/copies `
      + 'with the source and marked them for translate-pending.',
    );
  }
  writeJobsFiles([...others, ...clean]);
  return clean;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Alpiq');
  console.log('\u26a1 Running dedicated Alpiq crawler...');

    const _before = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const rawJobs = await fetchAlpiqListingPages(10);
  if (rawJobs.length === 0) { console.log('\u26a0\ufe0f No Swiss Alpiq jobs found. Keeping existing.'); return; }

  const incompleteDetails = rawJobs.filter((job) => job?._alpiqDetailIncomplete);
  if (incompleteDetails.length > 0) {
    console.warn(
      `\u26a0\ufe0f Alpiq detail enrichment incomplete for ${incompleteDetails.length}/${rawJobs.length} jobs; `
      + 'keeping the previous snapshot and retrying on the next scheduled run.',
    );
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Swiss Alpiq jobs.`);
  const parsedJobs = rawJobs.map(({ _alpiqDetailIncomplete: _ignored, ...raw }) => {
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    // Slug-only guard: a literal "undefined"/"null" location string is truthy
    // and would slip past `|| 'switzerland'` into an active slug (#952, class
    // #900/#901). addressLocality stays as-is (choke-point normalizer handles it).
    const jobSlug = slugify(`${raw.title}-alpiq-${safeLocationToken(raw.location, 'switzerland')}`);
    // Every job here passed the rich-detail gate above (an incomplete one
    // defers the whole snapshot), so the description is the posting's own
    // text; it is published in its own language slot only. The Italian
    // company sentence that used to stand in for a missing description, and
    // the copy of a non-Italian description in the `it` slot, are gone.
    const { description: desc, descriptionByLocale, sourceLang } = sourceLocaleDescription(raw.description);
    const sourceLocation = String(raw.location || '').trim();
    const hasConcreteLocation = Boolean(sourceLocation && !/^switzerland$/i.test(sourceLocation));
    const location = hasConcreteLocation ? sourceLocation : ALPIQ_SAFE_DEFAULT_ADDRESS.location;
    const canton = inferAnyCanton(sourceLocation) || ALPIQ_SAFE_DEFAULT_ADDRESS.canton;
    return {
      // Title, slug and requirements are keyed by the same source-language
      // slot as the description (4 of 5 Alpiq postings are English), not a
      // fixed `it` (#5253); the slug keeps its formula and existing jobs keep
      // their published slugs through the merge.
      id: `alpiq-${urlHash}`, slug: jobSlug, slugByLocale: { [sourceLang]: jobSlug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'alpiq.com',
      title: raw.title, titleByLocale: { [sourceLang]: raw.title },
      description: desc, descriptionByLocale, requirements: [], requirementsByLocale: { [sourceLang]: [] },
      location,
      canton,
      postalCode: hasConcreteLocation
        ? resolveAlpiqPostalCode(location, canton)
        : ALPIQ_SAFE_DEFAULT_ADDRESS.postalCode,
      streetAddress: hasConcreteLocation ? '' : ALPIQ_SAFE_DEFAULT_ADDRESS.streetAddress,
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      employmentType: inferEmploymentType(raw.title, raw.description || '', raw.percentage || ''),
      category: 'energy', contract: raw.contractType === 'Temporary' ? 'temporary' : 'full-time',
      currency: 'CHF', featured: false, postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url, applyUrl: raw.applyUrl, source: 'Alpiq Dedicated Parser', sourceLang, crawledAt: new Date().toISOString(),
    };
  });

  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Alpiq');
  writeJobsSummary(published, 'Alpiq');
  const after = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_before, after);
  printCrawlChangeSummary(diff, 'Alpiq');
  writeCrawlChangeSummaryToGH(diff, 'Alpiq');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_ALPIQ_STRICT', label: 'Alpiq', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No Alpiq jobs found.', detectSourceLang: (t) => detectLang(t, 'en'), deriveSlug: deriveLocalizedSlug });

  const dur = getCrawlerElapsedMs();
  const sr = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const sj = Array.isArray(sr) ? sr.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, sj);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Alpiq', generatedAt: new Date().toISOString(), total: sj.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: dur, avgDurationMs: dur, durationHistory: [dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Alpiq'));
