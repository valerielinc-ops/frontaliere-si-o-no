/**
 * Standard Crawler Template — runStandardCrawlerPipeline()
 *
 * Provides a standardized 7-step pipeline for dedicated job crawlers.
 * Based on the stable "Pattern A" (Rapelli-style) architecture:
 *   1. Snapshot existing jobs
 *   2. Fetch jobs via company-specific callback
 *   3. Merge with mergePreserveLocaleData (slug-stable)
 *   4. Diff reporting
 *   5. AI Localization via runDedicatedBaseCrawler
 *   6. Validation via validateDedicatedLocaleCoverage
 *   7. Slice + Assemble
 *
 * Usage:
 *   import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
 *   import { fetchAllMyJobs, isMyJob } from './lib/my-company-parser.mjs';
 *
 *   runStandardCrawlerPipeline({
 *     companyKey: 'my-company',
 *     companyLabel: 'My Company',
 *     fetchJobs: fetchAllMyJobs,
 *     isCompanyJob: isMyJob,
 *   }).catch(err => { console.error(err.message); process.exit(1); });
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from '../jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from '../assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergePreserveLocaleData,
  detectLang,
  deriveLocalizedSlug,
} from './dedicated-crawler-common.mjs';

/**
 * @typedef {Object} CrawlerConfig
 * @property {string}   companyKey       — Unique key (e.g. 'lonza', 'rapelli')
 * @property {string}   companyLabel     — Human-readable name for logs
 * @property {string}   root             — Project root (defaults to process.cwd())
 * @property {Function} fetchJobs        — async () => ParsedJob[]. Source-locale only.
 * @property {Function} isCompanyJob     — (job) => boolean. Matches this company's jobs.
 * @property {string}   [defaultSourceLang='it'] — Fallback source language
 * @property {Function} [isTrustedDomain] — (url) => boolean. For URL validation.
 * @property {Function} [matchKey]       — Custom URL matching for merge dedup
 * @property {Object}   [baseCrawlerOpts] — Extra options for runDedicatedBaseCrawler
 */

/**
 * Run the standard 7-step crawler pipeline.
 *
 * @param {CrawlerConfig} config
 */
export async function runStandardCrawlerPipeline(config) {
  const {
    companyKey,
    companyLabel,
    root = path.resolve(process.cwd()),
    fetchJobs,
    isCompanyJob,
    defaultSourceLang = 'it',
    isTrustedDomain,
    matchKey,
    baseCrawlerOpts = {},
  } = config;

  const DATA_JOBS = path.resolve(root, 'data', 'jobs.json');
  const PUBLIC_DATA_JOBS = path.resolve(root, 'public', 'data', 'jobs.json');

  // ─── Step 0: Init ───────────────────────────────────────────
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(companyKey, companyLabel);
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${companyLabel} — Standard Crawler Pipeline`);
  console.log('═══════════════════════════════════════════════\n');

  // ─── Step 1: Snapshot ───────────────────────────────────────
  const existingJobs = readExistingCrawlerJobs(companyKey, DATA_JOBS);
  const companyExisting = existingJobs.filter(isCompanyJob);
  const beforeSnapshot = snapshotJobSlugs(companyExisting);

  // ─── Step 2: Fetch ──────────────────────────────────────────
  const parsedJobs = await fetchJobs();

  if (!parsedJobs || parsedJobs.length === 0) {
    console.log(`\n⚠️ No ${companyLabel} jobs discovered. Keeping existing jobs.`);
    return;
  }

  console.log(`\n🧩 ${companyLabel}: ${parsedJobs.length} jobs parsed. Merging...\n`);

  // ─── Step 3: Merge with slug stability ──────────────────────
  const allJobs = Array.isArray(existingJobs) ? existingJobs : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const mergeOpts = matchKey ? { matchKey } : {};
  const merged = mergePreserveLocaleData(companyExisting, parsedJobs, mergeOpts);
  const clean = merged.sort((a, b) =>
    String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );

  // Write merged dataset
  const final = [...others, ...clean];
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(final, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(final, null, 2)}\n`, 'utf-8');
  }

  // ─── Step 4: Diff reporting ─────────────────────────────────
  const afterMergeSnapshot = snapshotJobSlugs(clean);
  const diff = computeCrawlDiff(beforeSnapshot, afterMergeSnapshot);
  printCrawlChangeSummary(diff, companyLabel);
  writeCrawlChangeSummaryToGH(diff, companyLabel);
  printPublishedJobUrls(clean, companyLabel);
  writeJobsSummary(clean, companyLabel);

  // ─── Step 5: AI Localization ────────────────────────────────
  console.log(`\n🌐 Running AI localization for ${companyLabel} jobs...`);
  await runDedicatedBaseCrawler({
    root,
    companyKeys: companyKey,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
    ...baseCrawlerOpts,
  });

  // ─── Step 6: Validation ─────────────────────────────────────
  const validateOpts = {
    strictEnvVar: `JOBS_${companyKey.toUpperCase().replace(/-/g, '_')}_STRICT`,
    label: companyLabel,
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCompanyJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: `No ${companyLabel} jobs found after crawl.`,
    detectSourceLang: (text) => detectLang(text, defaultSourceLang),
    deriveSlug: deriveLocalizedSlug,
  };
  if (isTrustedDomain) {
    validateOpts.isTrustedDomain = isTrustedDomain;
    validateOpts.untrustedDomainReason = `url_not_${companyKey}_domain`;
  }
  validateDedicatedLocaleCoverage(validateOpts);

  // ─── Step 7: Slice + Assemble ───────────────────────────────
  const durationMs = getCrawlerElapsedMs();
  const sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const sliceJobs = Array.isArray(sliceRaw) ? sliceRaw.filter(isCompanyJob) : [];

  writeJobsCrawlerSlice(companyKey, sliceJobs);
  writeSummaryCrawlerSlice({
    key: companyKey,
    label: companyLabel,
    generatedAt: new Date().toISOString(),
    total: sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs,
    avgDurationMs: durationMs,
    durationHistory: [durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();

  // ─── Done ───────────────────────────────────────────────────
  console.log(`\n✅ ${companyLabel} crawler complete. ${sliceJobs.length} jobs.`);
}
