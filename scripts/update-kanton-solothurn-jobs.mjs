#!/usr/bin/env node
/**
 * Dedicated Kanton Solothurn (cantonal administration) crawler runner.
 *
 * Uses the standard crawler template with the Kanton Solothurn parser.
 * All fetch/parse logic lives in ./lib/kanton-solothurn-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKantonSolothurnJobs,
  isKantonSolothurnJob,
  isTrustedDomain,
  KANTON_SOLOTHURN_KEY,
  KANTON_SOLOTHURN_COMPANY_NAME,
} from './lib/kanton-solothurn-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KANTON_SOLOTHURN_KEY,
  companyLabel: KANTON_SOLOTHURN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKantonSolothurnJobs,
  isCompanyJob: isKantonSolothurnJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kanton Solothurn crawler failed: ${err?.message || err}`);
  process.exit(1);
});
