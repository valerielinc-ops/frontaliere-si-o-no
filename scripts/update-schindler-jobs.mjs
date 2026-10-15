#!/usr/bin/env node
/**
 * Dedicated Schindler crawler runner.
 *
 * Uses the standard crawler template with the Schindler parser.
 * All fetch/parse logic lives in ./lib/schindler-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSchindlerJobs,
  isSchindlerJob,
  isTrustedDomain,
  SCHINDLER_KEY,
  SCHINDLER_COMPANY_NAME,
} from './lib/schindler-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SCHINDLER_KEY,
  companyLabel: SCHINDLER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSchindlerJobs,
  isCompanyJob: isSchindlerJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Schindler crawler failed: ${err?.message || err}`);
  process.exit(1);
});
