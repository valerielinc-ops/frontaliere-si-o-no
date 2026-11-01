#!/usr/bin/env node
/**
 * Dedicated CSL Immobilien AG crawler runner.
 *
 * Uses the standard crawler template with the CSL Immobilien AG parser.
 * All fetch/parse logic lives in ./lib/csl-immobilien-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCslImmobilienAgJobs,
  isCslImmobilienAgJob,
  isTrustedDomain,
  CSL_IMMOBILIEN_AG_KEY,
  CSL_IMMOBILIEN_AG_COMPANY_NAME,
} from './lib/csl-immobilien-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CSL_IMMOBILIEN_AG_KEY,
  companyLabel: CSL_IMMOBILIEN_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCslImmobilienAgJobs,
  isCompanyJob: isCslImmobilienAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ CSL Immobilien AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
