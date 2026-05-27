#!/usr/bin/env node
/**
 * Dedicated Alprose crawler runner.
 *
 * Uses the standard crawler template with the Alprose parser.
 * All fetch/parse logic lives in ./lib/alprose-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAlproseJobs,
  isAlproseJob,
  isTrustedDomain,
  ALPROSE_KEY,
  ALPROSE_COMPANY_NAME,
} from './lib/alprose-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ALPROSE_KEY,
  companyLabel: ALPROSE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAlproseJobs,
  isCompanyJob: isAlproseJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Alprose crawler failed: ${err?.message || err}`);
  process.exit(1);
});
