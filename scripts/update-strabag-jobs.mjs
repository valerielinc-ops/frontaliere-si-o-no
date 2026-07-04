#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStrabagJobs,
  isStrabagJob,
  isTrustedDomain,
  STRABAG_KEY,
  STRABAG_COMPANY_NAME,
} from './lib/strabag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STRABAG_KEY,
  companyLabel: STRABAG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStrabagJobs,
  isCompanyJob: isStrabagJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ STRABAG AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
