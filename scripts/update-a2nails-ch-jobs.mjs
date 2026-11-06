#!/usr/bin/env node
/**
 * Dedicated A2 Nails Nyon crawler runner.
 *
 * Uses the standard crawler template with the A2 Nails Nyon parser.
 * All fetch/parse logic lives in ./lib/a2nails-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllA2nailsChJobs,
  isA2nailsChJob,
  isTrustedDomain,
  A2NAILS_CH_KEY,
  A2NAILS_CH_COMPANY_NAME,
} from './lib/a2nails-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: A2NAILS_CH_KEY,
  companyLabel: A2NAILS_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllA2nailsChJobs,
  isCompanyJob: isA2nailsChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ A2 Nails Nyon crawler failed: ${err?.message || err}`);
  process.exit(1);
});
