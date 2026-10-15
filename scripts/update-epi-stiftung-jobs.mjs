#!/usr/bin/env node
/**
 * Dedicated Schweizerische Epilepsie-Stiftung (EPI) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEpiStiftungJobs,
  isEpiStiftungJob,
  isTrustedDomain,
  EPI_STIFTUNG_KEY,
  EPI_STIFTUNG_COMPANY_NAME,
} from './lib/epi-stiftung-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EPI_STIFTUNG_KEY,
  companyLabel: EPI_STIFTUNG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEpiStiftungJobs,
  isCompanyJob: isEpiStiftungJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ EPI Stiftung crawler failed: ${err?.message || err}`);
  process.exit(1);
});
