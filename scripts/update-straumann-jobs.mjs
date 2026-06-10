#!/usr/bin/env node
/**
 * Dedicated Straumann crawler runner.
 *
 * Uses the standard crawler template with the Straumann parser.
 * All fetch/parse logic lives in ./lib/straumann-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStraumannJobs,
  isStraumannJob,
  isTrustedDomain,
  STRAUMANN_KEY,
  STRAUMANN_COMPANY_NAME,
} from './lib/straumann-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STRAUMANN_KEY,
  companyLabel: STRAUMANN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStraumannJobs,
  isCompanyJob: isStraumannJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Straumann crawler failed: ${err?.message || err}`);
  process.exit(1);
});
