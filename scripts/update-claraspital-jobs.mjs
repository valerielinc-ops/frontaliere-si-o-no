#!/usr/bin/env node
/**
 * Dedicated St. Claraspital Basel crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllClaraspitalJobs,
  isClaraspitalJob,
  isTrustedDomain,
  CLARASPITAL_KEY,
  CLARASPITAL_COMPANY_NAME,
} from './lib/claraspital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLARASPITAL_KEY,
  companyLabel: CLARASPITAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllClaraspitalJobs,
  isCompanyJob: isClaraspitalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Claraspital crawler failed: ${err?.message || err}`);
  process.exit(1);
});
