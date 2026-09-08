#!/usr/bin/env node
/**
 * Dedicated Stellenpartner AG crawler runner.
 *
 * Uses the standard crawler template with the Stellenpartner AG parser.
 * All fetch/parse logic lives in ./lib/stellenpartner-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStellenpartnerJobs,
  isStellenpartnerJob,
  isTrustedDomain,
  STELLENPARTNER_KEY,
  STELLENPARTNER_COMPANY_NAME,
} from './lib/stellenpartner-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STELLENPARTNER_KEY,
  companyLabel: STELLENPARTNER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStellenpartnerJobs,
  isCompanyJob: isStellenpartnerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stellenpartner AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
