#!/usr/bin/env node
/**
 * Dedicated New Yorker (Schweiz) crawler runner.
 *
 * Uses the standard crawler template with the New Yorker parser.
 * All fetch/parse logic lives in ./lib/new-yorker-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNewYorkerJobs,
  isNewYorkerJob,
  isTrustedDomain,
  NEW_YORKER_KEY,
  NEW_YORKER_COMPANY_NAME,
} from './lib/new-yorker-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NEW_YORKER_KEY,
  companyLabel: NEW_YORKER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNewYorkerJobs,
  isCompanyJob: isNewYorkerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ New Yorker crawler failed: ${err?.message || err}`);
  process.exit(1);
});
