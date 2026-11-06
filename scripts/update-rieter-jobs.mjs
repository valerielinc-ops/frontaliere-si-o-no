#!/usr/bin/env node
/**
 * Dedicated Rieter crawler runner.
 *
 * Uses the standard crawler template with the Rieter parser.
 * All fetch/parse logic lives in ./lib/rieter-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRieterJobs,
  isRieterJob,
  isTrustedDomain,
  RIETER_KEY,
  RIETER_COMPANY_NAME,
} from './lib/rieter-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RIETER_KEY,
  companyLabel: RIETER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRieterJobs,
  isCompanyJob: isRieterJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Rieter crawler failed: ${err?.message || err}`);
  process.exit(1);
});
