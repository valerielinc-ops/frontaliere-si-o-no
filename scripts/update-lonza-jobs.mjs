#!/usr/bin/env node
/**
 * Dedicated Lonza crawler runner.
 *
 * Lonza is a global pharma/biotech company headquartered in Basel,
 * with major operations in Visp (Canton Valais, VS).
 *
 * Uses the standard crawler template with the Lonza Workday parser.
 * All fetch/parse logic lives in ./lib/lonza-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLonzaJobs,
  isLonzaJob,
  isTrustedDomain,
  LONZA_KEY,
  LONZA_COMPANY_NAME,
} from './lib/lonza-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LONZA_KEY,
  companyLabel: LONZA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLonzaJobs,
  isCompanyJob: isLonzaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Lonza crawler failed: ${err?.message || err}`);
  process.exit(1);
});
