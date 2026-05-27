#!/usr/bin/env node
/**
 * Dedicated CSD ENGINEERS crawler runner.
 *
 * Uses the standard crawler template with the CSD ENGINEERS parser.
 * All fetch/parse logic lives in ./lib/csd-engineers-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCsdEngineersJobs,
  isCsdEngineersJob,
  isTrustedDomain,
  CSD_ENGINEERS_KEY,
  CSD_ENGINEERS_COMPANY_NAME,
} from './lib/csd-engineers-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CSD_ENGINEERS_KEY,
  companyLabel: CSD_ENGINEERS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCsdEngineersJobs,
  isCompanyJob: isCsdEngineersJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ CSD ENGINEERS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
