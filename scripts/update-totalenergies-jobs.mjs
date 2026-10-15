#!/usr/bin/env node
/**
 * Dedicated TotalEnergies crawler runner.
 *
 * Uses the standard crawler template with the TotalEnergies parser.
 * All fetch/parse logic lives in ./lib/totalenergies-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTotalEnergiesJobs,
  isTotalEnergiesJob,
  isTrustedDomain,
  TOTALENERGIES_KEY,
  TOTALENERGIES_COMPANY_NAME,
} from './lib/totalenergies-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TOTALENERGIES_KEY,
  companyLabel: TOTALENERGIES_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTotalEnergiesJobs,
  isCompanyJob: isTotalEnergiesJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ TotalEnergies crawler failed: ${err?.message || err}`);
  process.exit(1);
});
