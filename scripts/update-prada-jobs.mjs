#!/usr/bin/env node
/**
 * Dedicated Prada Group crawler runner.
 *
 * Source:
 *   https://jobs.pradagroup.com/
 *
 * Prada Group operates luxury fashion brands with offices and boutiques across Switzerland.
 * The careers portal is likely SAP SuccessFactors-based.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { createHash } from 'node:crypto';
import { resolveLocalityAddress } from './lib/swiss-structured-address.mjs';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
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
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions } from './lib/source-locale-slots.mjs';
import {
  fetchPradaJobUrls,
  fetchPradaDetailPage,
  resolvePradaSwissLocation,
  slugify, inferEmploymentType,
} from './lib/prada-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';
import { sourceLocaleDescription } from './lib/source-locale-description.mjs';
import { dropFabricatedDescription } from './lib/drop-fabricated-description.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'prada';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Prada Group';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes('prada') || url.includes('pradagroup.com');
}

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
  }
}

// The four paragraphs the runner used to write for a page without the posting
// body ("Prada Group cerca…", "…is looking for…", "…sucht…", "…recherche…").
// Only ever recognised, to be removed from stored records (issue 5253).
const PRADA_FABRICATED_RE = /^Prada Group (?:cerca|is looking for|sucht|recherche) /;

/**
 * Remove, from a stored job, the text this runner used to write itself
 * (PRADA_FABRICATED_RE): the slots that carry it, the flat
 * `description`, and the translations made from it, flagging the job for
 * retranslation (`dropFabricatedDescription`). The merge keeps stored locale
 * slots, so without this they would outlive the fix; the runner calls it on
 * its stored jobs right before the merge.
 *
 * @returns {boolean} true when the job changed.
 */
export function dropPradaFabricatedText(job) {
  return dropFabricatedDescription(job, PRADA_FABRICATED_RE);
}

function mergeCompanyJobs(parsedJobs, companyExisting) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];
  const fossils = companyExisting.filter((job) => dropPradaFabricatedText(job)).length;
  if (fossils > 0) console.log(`  🧹 Removed the former invented descriptions from ${fossils} stored Prada Group job(s); they will be retranslated`);
  const merged = mergePreserveLocaleData(companyExisting, deduped);
  // Non-source slots the merge kept that are not in their own language go
  // back to the translation pipeline.
  for (const job of merged) dropStaleLocaleDescriptions(job);
  const clean = merged.sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  writeJobsFiles([...others, ...clean]);
  return clean;
}

/**
 * Description fields of a Prada posting: the detail text only, in the slot
 * of its own language (issue 5253). Without the posting body (the
 * SuccessFactors page is JS-rendered, or only the site-wide og:description
 * came back) there is no description, and main() skips the job as it always
 * did for a short one — instead of publishing the four paragraphs about
 * Prada Group that this runner used to write in it/en/de/fr.
 *
 * @param {string} detailDesc
 */
export function buildPradaDescriptionFields(detailDesc = '') {
  const text = String(detailDesc || '').trim();
  const isPostingBody = text.length >= 200
    && !text.toLowerCase().includes('prada group careers')
    && meetsSourceBodyFloor(text);
  if (!isPostingBody) return { description: '', descriptionByLocale: {}, sourceLang: 'en' };
  return sourceLocaleDescription(text, { defaultLang: 'en' });
}

// The zero-job exits keep the stored slice: remove from it the text the
// crawler once wrote, as the merge does (stored-jobs-soft-exit.mjs).
function cleanStoredJobsOnSoftExit() {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => { for (const job of jobs) dropPradaFabricatedText(job); },
    storedJobs: readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob),
    companyKey: COMPANY_KEY,
    companyLabel: COMPANY_NAME,
    write: (jobs, options) => writeJobsCrawlerSlice(COMPANY_KEY, jobs, options),
  });
}

async function main() {
  setCrawlerStartTime();
  // `sourceCounts.parsed` (issue #7707): the post-parser, pre-pipeline count.
  // Without it a run emptied downstream of the parser (detail-fetch abort,
  // merge, localization) reads as `discovered > 0, written === 0`, the same
  // shape as a legitimate "found jobs, none in Switzerland" run, and
  // check-crawler-health calls a broken crawler healthy.
  const sourceCounts = { discovered: null, parsed: null };
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Prada Group', sourceCounts);
  console.log(`👜 Running dedicated ${COMPANY_NAME} crawler...`);

  const priorJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob);
  const _beforeSnapshot = snapshotJobSlugs(priorJobs);

  const rawJobs = await fetchPradaJobUrls();
  sourceCounts.discovered = rawJobs.length;
  if (rawJobs.length === 0) {
    console.log('\u26a0\ufe0f No jobs found on Prada Group careers page. Keeping existing jobs.');
    await cleanStoredJobsOnSoftExit();
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Prada Group job links. Fetching details...`);
  const parsedJobs = [];
  for (const raw of rawJobs) {
    const listingLocation = resolvePradaSwissLocation(raw);
    if (!listingLocation) {
      console.log(`  ⏭️  ${raw.title}: source location "${raw.location || '(missing)'}" is outside Switzerland — skipping`);
      continue;
    }

    const detail = await fetchPradaDetailPage(raw.url);
    // SuccessFactors detail pages are 100% JS-rendered — the description is
    // often missing: see buildPradaDescriptionFields.
    const { description, descriptionByLocale: descByLocale, sourceLang } = buildPradaDescriptionFields(detail?.description);

    // A non-empty detail location is more authoritative than the listing and
    // must independently pass the same target gate. A blank detail falls back
    // to the already-proven listing/route location.
    const detailLocation = String(detail?.location || '').trim();
    const loc = detailLocation
      ? resolvePradaSwissLocation({ location: detailLocation, url: raw.url })
      : listingLocation;
    if (!loc) {
      console.log(`  ⏭️  ${raw.title}: detail location "${detailLocation}" is outside Switzerland — skipping`);
      continue;
    }
    const canton = inferAnyCanton(loc);
    if (!canton) {
      console.log(`  ⏭️  ${raw.title}: no Swiss canton could be inferred from "${loc}" — skipping`);
      continue;
    }
    // Località della vacancy, non il capoluogo di ripiego (issue 5253).
    const fallbackAddress = resolveLocalityAddress({ city: loc, canton });

    if (description.length < 30) {
      console.log(`  ⚠️  ${raw.title}: description too short (${description.length} chars) — skipping`);
      continue;
    }
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-prada-group-${safeLocationToken(loc)}`);
    parsedJobs.push({
      id: `prada-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: 'pradagroup.com',
      title: raw.title,
      titleByLocale: { [sourceLang]: raw.title },
      description,
      descriptionByLocale: descByLocale,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      location: loc,
      canton,
      addressRegion: canton,
      addressLocality: fallbackAddress.addressLocality,
      streetAddress: fallbackAddress.streetAddress,
      postalCode: fallbackAddress.postalCode,
      addressCountry: 'CH',
      category: 'fashion',
      contract: 'full-time', employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url,
      source: 'Prada Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
    // Updated inside the loop, not after it: the detail fetches above can abort
    // the run mid-loop, and the exit guard's slice must still carry what the
    // parser had already produced.
    sourceCounts.parsed = parsedJobs.length;
    console.log(`  \u2705 ${raw.title} \u2014 ${loc}`);
  }
  // Also after the loop, so a run that parsed nothing reports 0 (a real
  // filtered-empty) instead of the "not instrumented" null.
  sourceCounts.parsed = parsedJobs.length;

  // The query endpoint returned a coherent non-empty snapshot, so records
  // outside this crawler's Swiss ownership are known false positives, not
  // transient misses. Exclude them from merge grace and archive their routes.
  const targetExisting = priorJobs.filter((job) => resolvePradaSwissLocation(job));
  const retiredForeign = priorJobs.filter((job) => !resolvePradaSwissLocation(job));
  const archivedForeign = archiveRemovedJobsToSlice(retiredForeign, COMPANY_KEY);
  const published = mergeCompanyJobs(parsedJobs, targetExisting);
  printPublishedJobUrls(published, 'Prada Group');
  writeJobsSummary(published, 'Prada Group');

  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Prada Group');
  writeCrawlChangeSummaryToGH(diff, 'Prada Group');

  if (published.length === 0) {
    writeJobsCrawlerSlice(COMPANY_KEY, [], { skipShrinkGuard: true, preserveExistingSlugs: true });
    const _durationMs = getCrawlerElapsedMs();
    writeSummaryCrawlerSlice({
      key: COMPANY_KEY,
      label: 'Prada Group',
      generatedAt: new Date().toISOString(),
      total: 0,
      discovered: rawJobs.length,
      parsed: sourceCounts.parsed,
      written: 0,
      sourceProvenEmpty: true,
      newCount: 0,
      updatedCount: 0,
      removedCount: diff.removedJobs.length,
      unchangedCount: 0,
      durationMs: _durationMs,
      avgDurationMs: _durationMs,
      durationHistory: [_durationMs],
      newJobs: [],
      updatedJobs: [],
      removedJobs: diff.removedJobs.slice(0, 30),
      unchangedJobs: [],
    });
    await assembleJobsDataset();
    console.log(`ℹ️ Prada source proved 0 Swiss jobs; archived ${archivedForeign} foreign route(s).`);
    return;
  }

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });

  validateDedicatedLocaleCoverage({
    strictEnvVar: `JOBS_${COMPANY_KEY.toUpperCase()}_STRICT`,
    label: 'Prada Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCompanyJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: `No ${COMPANY_NAME} jobs found after crawl.`,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
  });

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Prada Group', generatedAt: new Date().toISOString(), total: _sliceJobs.length, parsed: sourceCounts.parsed, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => exitCrawlerOnError(err, 'Prada Group'));
}
