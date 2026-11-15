#!/usr/bin/env node
/**
 * Dedicated CNVO SA crawler runner.
 *
 * Uses the standard crawler template with the CNVO SA parser.
 * All fetch/parse logic lives in ./lib/cnvo-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCnvoChJobs,
  isCnvoChJob,
  isTrustedDomain,
  CNVO_CH_KEY,
  CNVO_CH_COMPANY_NAME,
} from './lib/cnvo-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CNVO_CH_KEY,
  companyLabel: CNVO_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCnvoChJobs,
  isCompanyJob: isCnvoChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ CNVO SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
