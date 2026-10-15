#!/usr/bin/env node
/**
 * Dedicated CordenPharma crawler runner.
 *
 * Uses the standard crawler template with the CordenPharma parser.
 * All fetch/parse logic lives in ./lib/cordenpharma-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCordenpharmaJobs,
  isCordenpharmaJob,
  isTrustedDomain,
  CORDENPHARMA_KEY,
  CORDENPHARMA_COMPANY_NAME,
} from './lib/cordenpharma-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CORDENPHARMA_KEY,
  companyLabel: CORDENPHARMA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCordenpharmaJobs,
  isCompanyJob: isCordenpharmaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ CordenPharma crawler failed: ${err?.message || err}`);
  process.exit(1);
});
