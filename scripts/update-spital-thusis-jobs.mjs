#!/usr/bin/env node
/**
 * Dedicated Spital Thusis crawler runner.
 *
 * Uses the standard crawler template with the Spital Thusis parser.
 * All fetch/parse logic lives in ./lib/spital-thusis-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalThusisJobs,
  isSpitalThusisJob,
  isTrustedDomain,
  SPITAL_THUSIS_KEY,
  SPITAL_THUSIS_COMPANY_NAME,
} from './lib/spital-thusis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_THUSIS_KEY,
  companyLabel: SPITAL_THUSIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalThusisJobs,
  isCompanyJob: isSpitalThusisJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Thusis crawler failed: ${err?.message || err}`);
  process.exit(1);
});
