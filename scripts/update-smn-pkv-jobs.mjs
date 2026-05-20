#!/usr/bin/env node
/**
 * Dedicated Privatklinik Villa im Park (SMN PKV) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSmnPkvJobs,
  isSmnPkvJob,
  isTrustedDomain,
  SMN_PKV_KEY,
  SMN_PKV_COMPANY_NAME,
} from './lib/smn-pkv-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SMN_PKV_KEY,
  companyLabel: SMN_PKV_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSmnPkvJobs,
  isCompanyJob: isSmnPkvJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SMN PKV crawler failed: ${err?.message || err}`);
  process.exit(1);
});
