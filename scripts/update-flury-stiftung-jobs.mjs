#!/usr/bin/env node
/**
 * Dedicated Flury Stiftung crawler runner.
 *
 * Uses the standard crawler template with the Flury Stiftung parser.
 * All fetch/parse logic lives in ./lib/flury-stiftung-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFluryStiftungJobs,
  isFluryStiftungJob,
  isTrustedDomain,
  FLURY_STIFTUNG_KEY,
  FLURY_STIFTUNG_COMPANY_NAME,
} from './lib/flury-stiftung-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FLURY_STIFTUNG_KEY,
  companyLabel: FLURY_STIFTUNG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFluryStiftungJobs,
  isCompanyJob: isFluryStiftungJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Flury Stiftung crawler failed: ${err?.message || err}`);
  process.exit(1);
});
