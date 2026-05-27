#!/usr/bin/env node
/**
 * Dedicated STGAG (Spital Thurgau) Umantis-listing crawler runner.
 *
 * Sibling of `update-spital-thurgau-jobs.mjs`. The legacy runner uses the
 * embedded-JSON parser at www.stgag.ch/jobs/ (yields ~156 jobs). This runner
 * uses the Umantis listing factory against rekrutierung.stgag.ch/Jobs/All
 * (~10 jobs/page — same factory limitation as all 8 sibling Umantis wrappers).
 *
 * Both runners coexist; future consolidation can compare coverage and pick
 * one. See scripts/lib/stgag-job-parser.mjs for the parser config.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStgagJobs,
  isStgagJob,
  isTrustedDomain,
  STGAG_KEY,
  STGAG_COMPANY_NAME,
} from './lib/stgag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STGAG_KEY,
  companyLabel: STGAG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStgagJobs,
  isCompanyJob: isStgagJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ STGAG (Umantis listing) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
