#!/usr/bin/env node
/**
 * Dedicated ATEC Personal AG crawler runner.
 *
 * Uses the standard crawler template with the ATEC Personal AG parser.
 * All fetch/parse logic lives in ./lib/atec-personal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAtecPersonalJobs,
  isAtecPersonalJob,
  isTrustedDomain,
  ATEC_PERSONAL_KEY,
  ATEC_PERSONAL_COMPANY_NAME,
} from './lib/atec-personal-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ATEC_PERSONAL_KEY,
  companyLabel: ATEC_PERSONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAtecPersonalJobs,
  isCompanyJob: isAtecPersonalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ATEC Personal AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
