#!/usr/bin/env node
/**
 * Dedicated BIG & ARE Stellen crawler runner.
 *
 * Uses the standard crawler template with the BIG & ARE Stellen parser.
 * All fetch/parse logic lives in ./lib/recruitingapp-1123-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRecruitingapp1123Jobs,
  isRecruitingapp1123Job,
  isTrustedDomain,
  RECRUITINGAPP_1123_KEY,
  RECRUITINGAPP_1123_COMPANY_NAME,
  assertCompleteRecruitingapp1123Snapshot,
} from './lib/recruitingapp-1123-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RECRUITINGAPP_1123_KEY,
  companyLabel: RECRUITINGAPP_1123_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRecruitingapp1123Jobs,
  isCompanyJob: isRecruitingapp1123Job,
  isTrustedDomain,
  defaultSourceLang: 'de',
  preserveExistingSlugs: true,
  validateAuthoritativeSnapshot: assertCompleteRecruitingapp1123Snapshot,
  allowAuthoritativeEmptySnapshot: true,
}).catch((err) => {
  console.error(`❌ BIG & ARE Stellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
