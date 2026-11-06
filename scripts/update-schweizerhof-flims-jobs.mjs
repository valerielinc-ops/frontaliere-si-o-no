#!/usr/bin/env node
/**
 * Dedicated Schweizerhof crawler runner.
 *
 * Uses the standard crawler template with the Schweizerhof parser.
 * All fetch/parse logic lives in ./lib/schweizerhof-flims-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSchweizerhofFlimsJobs,
  isSchweizerhofFlimsJob,
  isTrustedDomain,
  SCHWEIZERHOF_FLIMS_KEY,
  SCHWEIZERHOF_FLIMS_COMPANY_NAME,
} from './lib/schweizerhof-flims-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SCHWEIZERHOF_FLIMS_KEY,
  companyLabel: SCHWEIZERHOF_FLIMS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSchweizerhofFlimsJobs,
  isCompanyJob: isSchweizerhofFlimsJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Schweizerhof crawler failed: ${err?.message || err}`);
  process.exit(1);
});
