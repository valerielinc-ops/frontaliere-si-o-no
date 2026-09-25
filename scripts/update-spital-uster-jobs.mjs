#!/usr/bin/env node
/**
 * Dedicated Spital Uster crawler runner.
 *
 * Uses the standard crawler template with the Spital Uster parser.
 * All fetch/parse logic lives in ./lib/spital-uster-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalUsterJobs,
  isSpitalUsterJob,
  isTrustedDomain,
  SPITAL_USTER_KEY,
  SPITAL_USTER_COMPANY_NAME,
} from './lib/spital-uster-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_USTER_KEY,
  companyLabel: SPITAL_USTER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalUsterJobs,
  isCompanyJob: isSpitalUsterJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Uster crawler failed: ${err?.message || err}`);
  process.exit(1);
});
