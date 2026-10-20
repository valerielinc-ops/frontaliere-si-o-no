#!/usr/bin/env node
/**
 * Dedicated ZAUGG AG crawler runner.
 *
 * Uses the standard crawler template with the ZAUGG AG parser.
 * All fetch/parse logic lives in ./lib/zaugg-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZauggJobs,
  isZauggJob,
  isTrustedDomain,
  ZAUGG_KEY,
  ZAUGG_COMPANY_NAME,
} from './lib/zaugg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ZAUGG_KEY,
  companyLabel: ZAUGG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllZauggJobs,
  isCompanyJob: isZauggJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ZAUGG AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
