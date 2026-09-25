#!/usr/bin/env node
/**
 * Dedicated Nestlé crawler runner.
 *
 * Uses the standard crawler template with the Nestlé parser.
 * All fetch/parse logic lives in ./lib/nestle-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNestleJobs,
  isNestleJob,
  isTrustedDomain,
  NESTLE_KEY,
  NESTLE_COMPANY_NAME,
} from './lib/nestle-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NESTLE_KEY,
  companyLabel: NESTLE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNestleJobs,
  isCompanyJob: isNestleJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Nestlé crawler failed: ${err?.message || err}`);
  process.exit(1);
});
