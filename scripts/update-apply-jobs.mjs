#!/usr/bin/env node
/**
 * Dedicated LEITpuls AG crawler runner.
 *
 * Uses the standard crawler template with the LEITpuls AG parser.
 * All fetch/parse logic lives in ./lib/apply-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllApplyJobs,
  isApplyJob,
  isTrustedDomain,
  APPLY_KEY,
  APPLY_COMPANY_NAME,
} from './lib/apply-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: APPLY_KEY,
  companyLabel: APPLY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllApplyJobs,
  isCompanyJob: isApplyJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ LEITpuls AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
