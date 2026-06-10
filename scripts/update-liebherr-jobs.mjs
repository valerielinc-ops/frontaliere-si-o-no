#!/usr/bin/env node
/**
 * Dedicated undefined crawler runner.
 *
 * Uses the standard crawler template with the undefined parser.
 * All fetch/parse logic lives in ./lib/liebherr-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLiebherrJobs,
  isLiebherrJob,
  isTrustedDomain,
  LIEBHERR_KEY,
  LIEBHERR_COMPANY_NAME,
} from './lib/liebherr-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LIEBHERR_KEY,
  companyLabel: LIEBHERR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLiebherrJobs,
  isCompanyJob: isLiebherrJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ undefined crawler failed: ${err?.message || err}`);
  process.exit(1);
});
