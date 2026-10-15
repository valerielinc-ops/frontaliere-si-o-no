#!/usr/bin/env node
/**
 * Dedicated Cippà Trasporti SA crawler runner.
 *
 * Uses the standard crawler template with the Cippà Trasporti SA parser.
 * All fetch/parse logic lives in ./lib/cippatrasporti-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  assertCompleteCippatrasportiSnapshot,
  fetchAllCippatrasportiJobs,
  isCippatrasportiJob,
  isTrustedDomain,
  CIPPATRASPORTI_KEY,
  CIPPATRASPORTI_COMPANY_NAME,
} from './lib/cippatrasporti-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CIPPATRASPORTI_KEY,
  companyLabel: CIPPATRASPORTI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCippatrasportiJobs,
  isCompanyJob: isCippatrasportiJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  preserveExistingSlugs: true,
  validateAuthoritativeSnapshot: assertCompleteCippatrasportiSnapshot,
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Cippà Trasporti SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
