#!/usr/bin/env node
/**
 * Dedicated Barock Job AG crawler runner.
 *
 * Uses the standard crawler template with the Barock Job AG parser.
 * All fetch/parse logic lives in ./lib/barockjob-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBarockjobJobs,
  isBarockjobJob,
  isTrustedDomain,
  BAROCKJOB_KEY,
  BAROCKJOB_COMPANY_NAME,
} from './lib/barockjob-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BAROCKJOB_KEY,
  companyLabel: BAROCKJOB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBarockjobJobs,
  isCompanyJob: isBarockjobJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Barock Job AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
