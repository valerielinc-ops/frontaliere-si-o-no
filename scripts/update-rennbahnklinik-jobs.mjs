#!/usr/bin/env node
/**
 * Dedicated Rennbahnklinik (Muttenz, BL) crawler runner.
 *
 * Uses the standard crawler template with the Rennbahnklinik parser. All
 * fetch/parse logic lives in ./lib/rennbahnklinik-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRennbahnklinikJobs,
  isRennbahnklinikJob,
  isTrustedDomain,
  RENNBAHNKLINIK_KEY,
  RENNBAHNKLINIK_COMPANY_NAME,
} from './lib/rennbahnklinik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RENNBAHNKLINIK_KEY,
  companyLabel: RENNBAHNKLINIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRennbahnklinikJobs,
  isCompanyJob: isRennbahnklinikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Rennbahnklinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
