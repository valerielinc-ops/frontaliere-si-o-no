#!/usr/bin/env node
/**
 * Dedicated Internezzo AG crawler runner.
 *
 * Uses the standard crawler template with the Internezzo AG parser.
 * All fetch/parse logic lives in ./lib/internezzo-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllInternezzoAgJobs,
  isInternezzoAgJob,
  isTrustedDomain,
  INTERNEZZO_AG_KEY,
  INTERNEZZO_AG_COMPANY_NAME,
} from './lib/internezzo-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: INTERNEZZO_AG_KEY,
  companyLabel: INTERNEZZO_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllInternezzoAgJobs,
  isCompanyJob: isInternezzoAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Internezzo AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
