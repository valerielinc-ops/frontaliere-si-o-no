#!/usr/bin/env node
/**
 * Dedicated undefined crawler runner.
 *
 * Uses the standard crawler template with the undefined parser.
 * All fetch/parse logic lives in ./lib/sbb-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSbbJobs,
  isSbbJob,
  isTrustedDomain,
  SBB_KEY,
  SBB_COMPANY_NAME,
} from './lib/sbb-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SBB_KEY,
  companyLabel: SBB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSbbJobs,
  isCompanyJob: isSbbJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ undefined crawler failed: ${err?.message || err}`);
  process.exit(1);
});
