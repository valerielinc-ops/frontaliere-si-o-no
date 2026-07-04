#!/usr/bin/env node
/**
 * Dedicated On Running crawler runner.
 *
 * Uses the standard crawler template with the On Running parser.
 * All fetch/parse logic lives in ./lib/on-running-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOnRunningJobs,
  isOnRunningJob,
  isTrustedDomain,
  ON_RUNNING_KEY,
  ON_RUNNING_COMPANY_NAME,
} from './lib/on-running-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ON_RUNNING_KEY,
  companyLabel: ON_RUNNING_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOnRunningJobs,
  isCompanyJob: isOnRunningJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ On Running crawler failed: ${err?.message || err}`);
  process.exit(1);
});
