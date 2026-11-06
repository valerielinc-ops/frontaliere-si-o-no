#!/usr/bin/env node
/**
 * Dedicated pianorm crawler runner.
 *
 * Uses the standard crawler template with the pianorm parser.
 * All fetch/parse logic lives in ./lib/pianorm-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPianormJobs,
  isPianormJob,
  isTrustedDomain,
  PIANORM_KEY,
  PIANORM_COMPANY_NAME,
} from './lib/pianorm-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PIANORM_KEY,
  companyLabel: PIANORM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPianormJobs,
  isCompanyJob: isPianormJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ pianorm crawler failed: ${err?.message || err}`);
  process.exit(1);
});
