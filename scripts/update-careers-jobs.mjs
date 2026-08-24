#!/usr/bin/env node
/**
 * Dedicated lepatron crawler runner.
 *
 * Uses the standard crawler template with the lepatron parser.
 * All fetch/parse logic lives in ./lib/careers-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCareersJobs,
  isCareersJob,
  isTrustedDomain,
  CAREERS_KEY,
  CAREERS_COMPANY_NAME,
} from './lib/careers-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CAREERS_KEY,
  companyLabel: CAREERS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCareersJobs,
  isCompanyJob: isCareersJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ lepatron crawler failed: ${err?.message || err}`);
  process.exit(1);
});
