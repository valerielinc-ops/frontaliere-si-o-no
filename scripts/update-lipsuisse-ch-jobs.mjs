#!/usr/bin/env node
/**
 * Dedicated LIP Suisse crawler runner.
 *
 * Uses the standard crawler template with the LIP Suisse parser.
 * All fetch/parse logic lives in ./lib/lipsuisse-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLipsuisseChJobs,
  isLipsuisseChJob,
  isTrustedDomain,
  LIPSUISSE_CH_KEY,
  LIPSUISSE_CH_COMPANY_NAME,
} from './lib/lipsuisse-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LIPSUISSE_CH_KEY,
  companyLabel: LIPSUISSE_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLipsuisseChJobs,
  isCompanyJob: isLipsuisseChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ LIP Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
