#!/usr/bin/env node
/**
 * Dedicated Beekeeper crawler runner.
 *
 * Uses the standard crawler template with the Beekeeper parser.
 * All fetch/parse logic lives in ./lib/beekeeper-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBeekeeperJobs,
  isBeekeeperJob,
  isTrustedDomain,
  BEEKEEPER_KEY,
  BEEKEEPER_COMPANY_NAME,
} from './lib/beekeeper-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BEEKEEPER_KEY,
  companyLabel: BEEKEEPER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBeekeeperJobs,
  isCompanyJob: isBeekeeperJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Beekeeper crawler failed: ${err?.message || err}`);
  process.exit(1);
});
