#!/usr/bin/env node
/**
 * Dedicated Alexander von Humboldt-Stiftung Stellen crawler runner.
 *
 * Uses the standard crawler template with the Alexander von Humboldt-Stiftung Stellen parser.
 * All fetch/parse logic lives in ./lib/recruitingapp-2649-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRecruitingapp2649Jobs,
  assertCompleteRecruitingapp2649Snapshot,
  isRecruitingapp2649Job,
  isTrustedDomain,
  RECRUITINGAPP_2649_KEY,
  RECRUITINGAPP_2649_COMPANY_NAME,
} from './lib/recruitingapp-2649-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RECRUITINGAPP_2649_KEY,
  companyLabel: RECRUITINGAPP_2649_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRecruitingapp2649Jobs,
  isCompanyJob: isRecruitingapp2649Job,
  isTrustedDomain,
  defaultSourceLang: 'de',
  preserveExistingSlugs: true,
  validateAuthoritativeSnapshot: assertCompleteRecruitingapp2649Snapshot,
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Alexander von Humboldt-Stiftung Stellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
