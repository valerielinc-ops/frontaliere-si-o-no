#!/usr/bin/env node
/**
 * Dedicated Duferco crawler runner.
 *
 * Uses the standard crawler template with the Duferco parser.
 * All fetch/parse logic lives in ./lib/duferco-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDufercoJobs,
  isDufercoJob,
  isTrustedDomain,
  DUFERCO_KEY,
  DUFERCO_COMPANY_NAME,
} from './lib/duferco-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DUFERCO_KEY,
  companyLabel: DUFERCO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDufercoJobs,
  isCompanyJob: isDufercoJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Duferco crawler failed: ${err?.message || err}`);
  process.exit(1);
});
