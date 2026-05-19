#!/usr/bin/env node
/**
 * Dedicated UKBB (Universitäts-Kinderspital beider Basel) crawler runner.
 *
 * Uses the standard crawler template with the UKBB parser. All fetch/parse
 * logic lives in ./lib/ukbb-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUkbbJobs,
  isUkbbJob,
  isTrustedDomain,
  UKBB_KEY,
  UKBB_COMPANY_NAME,
} from './lib/ukbb-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UKBB_KEY,
  companyLabel: UKBB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUkbbJobs,
  isCompanyJob: isUkbbJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ UKBB crawler failed: ${err?.message || err}`);
  process.exit(1);
});
