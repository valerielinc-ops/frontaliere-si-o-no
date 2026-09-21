#!/usr/bin/env node
/**
 * Dedicated Bellevue Parkhotel & Spa crawler runner.
 *
 * Uses the standard crawler template with the Bellevue Parkhotel & Spa parser.
 * All fetch/parse logic lives in ./lib/my-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMyJobs,
  isMyJob,
  isTrustedDomain,
  MY_KEY,
  MY_COMPANY_NAME,
} from './lib/my-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MY_KEY,
  companyLabel: MY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMyJobs,
  isCompanyJob: isMyJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bellevue Parkhotel & Spa crawler failed: ${err?.message || err}`);
  process.exit(1);
});
