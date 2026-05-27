#!/usr/bin/env node
/**
 * Dedicated Givaudan crawler runner.
 *
 * Uses the standard crawler template with the Givaudan parser.
 * All fetch/parse logic lives in ./lib/givaudan-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGivaudanJobs,
  isGivaudanJob,
  isTrustedDomain,
  GIVAUDAN_KEY,
  GIVAUDAN_COMPANY_NAME,
} from './lib/givaudan-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GIVAUDAN_KEY,
  companyLabel: GIVAUDAN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGivaudanJobs,
  isCompanyJob: isGivaudanJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Givaudan crawler failed: ${err?.message || err}`);
  process.exit(1);
});
