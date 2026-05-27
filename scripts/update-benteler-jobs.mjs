#!/usr/bin/env node
/**
 * Dedicated Benteler crawler runner.
 *
 * Uses the standard crawler template with the Benteler parser.
 * All fetch/parse logic lives in ./lib/benteler-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBentelerJobs,
  isBentelerJob,
  isTrustedDomain,
  BENTELER_KEY,
  BENTELER_COMPANY_NAME,
} from './lib/benteler-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BENTELER_KEY,
  companyLabel: BENTELER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBentelerJobs,
  isCompanyJob: isBentelerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Benteler crawler failed: ${err?.message || err}`);
  process.exit(1);
});
