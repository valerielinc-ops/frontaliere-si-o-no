#!/usr/bin/env node
/**
 * Dedicated Swissquote (Swiss online fintech/banking group) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSwissquoteJobs,
  isSwissquoteJob,
  isTrustedDomain,
  SWISSQUOTE_KEY,
  SWISSQUOTE_COMPANY_NAME,
} from './lib/swissquote-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SWISSQUOTE_KEY,
  companyLabel: SWISSQUOTE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSwissquoteJobs,
  isCompanyJob: isSwissquoteJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Swissquote crawler failed: ${err?.message || err}`);
  process.exit(1);
});
