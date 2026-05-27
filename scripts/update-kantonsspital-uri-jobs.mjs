#!/usr/bin/env node
/**
 * Dedicated Kantonsspital Uri crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKantonsspitalUriJobs,
  isKantonsspitalUriJob,
  isTrustedDomain,
  KANTONSSPITAL_URI_KEY,
  KANTONSSPITAL_URI_COMPANY_NAME,
} from './lib/kantonsspital-uri-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KANTONSSPITAL_URI_KEY,
  companyLabel: KANTONSSPITAL_URI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKantonsspitalUriJobs,
  isCompanyJob: isKantonsspitalUriJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kantonsspital Uri crawler failed: ${err?.message || err}`);
  process.exit(1);
});
