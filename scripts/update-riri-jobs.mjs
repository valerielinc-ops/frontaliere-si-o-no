#!/usr/bin/env node
/**
 * Dedicated Riri Group crawler runner.
 *
 * Uses the standard crawler template with the Riri Group parser.
 * All fetch/parse logic lives in ./lib/riri-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRiriJobs,
  isRiriJob,
  isTrustedDomain,
  RIRI_KEY,
  RIRI_COMPANY_NAME,
} from './lib/riri-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RIRI_KEY,
  companyLabel: RIRI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRiriJobs,
  isCompanyJob: isRiriJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Riri Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
