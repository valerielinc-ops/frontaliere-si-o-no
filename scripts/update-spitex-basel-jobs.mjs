#!/usr/bin/env node
/**
 * Dedicated SPITEX BASEL crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitexBaselJobs,
  isSpitexBaselJob,
  isTrustedDomain,
  SPITEX_BASEL_KEY,
  SPITEX_BASEL_COMPANY_NAME,
} from './lib/spitex-basel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITEX_BASEL_KEY,
  companyLabel: SPITEX_BASEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitexBaselJobs,
  isCompanyJob: isSpitexBaselJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SPITEX BASEL crawler failed: ${err?.message || err}`);
  process.exit(1);
});
