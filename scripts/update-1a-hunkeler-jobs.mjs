#!/usr/bin/env node
/**
 * Dedicated 1a-hunkeler crawler runner.
 *
 * Uses the standard crawler template with the 1a-hunkeler parser.
 * All fetch/parse logic lives in ./lib/1a-hunkeler-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllC1aHunkelerJobs,
  isC1aHunkelerJob,
  isTrustedDomain,
  1A_HUNKELER_KEY,
  1A_HUNKELER_COMPANY_NAME,
} from './lib/1a-hunkeler-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: 1A_HUNKELER_KEY,
  companyLabel: 1A_HUNKELER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllC1aHunkelerJobs,
  isCompanyJob: isC1aHunkelerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ 1a-hunkeler crawler failed: ${err?.message || err}`);
  process.exit(1);
});
