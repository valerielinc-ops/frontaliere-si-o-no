#!/usr/bin/env node
/**
 * Dedicated Jensen AG crawler runner.
 *
 * Uses the standard crawler template with the Jensen AG parser.
 * All fetch/parse logic lives in ./lib/jensen-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllJensenAgJobs,
  isJensenAgJob,
  isTrustedDomain,
  JENSEN_AG_KEY,
  JENSEN_AG_COMPANY_NAME,
} from './lib/jensen-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: JENSEN_AG_KEY,
  companyLabel: JENSEN_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllJensenAgJobs,
  isCompanyJob: isJensenAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Jensen AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
