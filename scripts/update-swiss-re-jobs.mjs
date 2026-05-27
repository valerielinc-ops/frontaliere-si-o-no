#!/usr/bin/env node
/**
 * Dedicated Swiss Re crawler runner.
 *
 * Uses the standard crawler template with the Swiss Re parser.
 * All fetch/parse logic lives in ./lib/swiss-re-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSwissReJobs,
  isSwissReJob,
  isTrustedDomain,
  SWISS_RE_KEY,
  SWISS_RE_COMPANY_NAME,
} from './lib/swiss-re-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SWISS_RE_KEY,
  companyLabel: SWISS_RE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSwissReJobs,
  isCompanyJob: isSwissReJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Swiss Re crawler failed: ${err?.message || err}`);
  process.exit(1);
});
