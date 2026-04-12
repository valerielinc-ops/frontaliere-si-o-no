#!/usr/bin/env node
/**
 * Dedicated Gruppo Ospedaliero Moncucco crawler runner.
 *
 * Uses the standard crawler template with the Gruppo Ospedaliero Moncucco parser.
 * All fetch/parse logic lives in ./lib/moncucco-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMoncuccoJobs,
  isMoncuccoJob,
  isTrustedDomain,
  MONCUCCO_KEY,
  MONCUCCO_COMPANY_NAME,
} from './lib/moncucco-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MONCUCCO_KEY,
  companyLabel: MONCUCCO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMoncuccoJobs,
  isCompanyJob: isMoncuccoJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Gruppo Ospedaliero Moncucco crawler failed: ${err?.message || err}`);
  process.exit(1);
});
