#!/usr/bin/env node
/**
 * Dedicated Universität Bern crawler runner.
 *
 * Uses the standard crawler template with the Universität Bern parser.
 * All fetch/parse logic lives in ./lib/unibe-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUnibeJobs,
  isUnibeJob,
  isTrustedDomain,
  UNIBE_KEY,
  UNIBE_COMPANY_NAME,
} from './lib/unibe-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UNIBE_KEY,
  companyLabel: UNIBE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUnibeJobs,
  isCompanyJob: isUnibeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Universität Bern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
