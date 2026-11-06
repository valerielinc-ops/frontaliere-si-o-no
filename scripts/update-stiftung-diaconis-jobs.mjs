#!/usr/bin/env node
/**
 * Dedicated Stiftung Diaconis crawler runner.
 *
 * Uses the standard crawler template with the Stiftung Diaconis parser.
 * All fetch/parse logic lives in ./lib/stiftung-diaconis-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStiftungDiaconisJobs,
  isStiftungDiaconisJob,
  isTrustedDomain,
  STIFTUNG_DIACONIS_KEY,
  STIFTUNG_DIACONIS_COMPANY_NAME,
} from './lib/stiftung-diaconis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STIFTUNG_DIACONIS_KEY,
  companyLabel: STIFTUNG_DIACONIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStiftungDiaconisJobs,
  isCompanyJob: isStiftungDiaconisJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stiftung Diaconis crawler failed: ${err?.message || err}`);
  process.exit(1);
});
