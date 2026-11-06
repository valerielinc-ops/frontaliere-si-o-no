#!/usr/bin/env node
/**
 * Dedicated Stiftung Pigna crawler runner.
 *
 * Uses the standard crawler template with the Pigna parser.
 * All fetch/parse logic lives in ./lib/pigna-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPignaJobs,
  isPignaJob,
  isTrustedDomain,
  PIGNA_KEY,
  PIGNA_COMPANY_NAME,
} from './lib/pigna-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PIGNA_KEY,
  companyLabel: PIGNA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPignaJobs,
  isCompanyJob: isPignaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Pigna crawler failed: ${err?.message || err}`);
  process.exit(1);
});
