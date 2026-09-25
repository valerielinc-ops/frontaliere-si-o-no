#!/usr/bin/env node
/**
 * Dedicated Somedia AG crawler runner.
 *
 * Uses the standard crawler template with the Somedia AG parser.
 * All fetch/parse logic lives in ./lib/somedia-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSomediaJobs,
  isSomediaJob,
  isTrustedDomain,
  SOMEDIA_KEY,
  SOMEDIA_COMPANY_NAME,
} from './lib/somedia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SOMEDIA_KEY,
  companyLabel: SOMEDIA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSomediaJobs,
  isCompanyJob: isSomediaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Somedia AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
