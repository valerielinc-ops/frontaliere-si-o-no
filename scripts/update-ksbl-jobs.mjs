#!/usr/bin/env node
/**
 * Dedicated KSBL (Kantonsspital Baselland) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKsblJobs,
  isKsblJob,
  isTrustedDomain,
  KSBL_KEY,
  KSBL_COMPANY_NAME,
} from './lib/ksbl-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSBL_KEY,
  companyLabel: KSBL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKsblJobs,
  isCompanyJob: isKsblJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ KSBL crawler failed: ${err?.message || err}`);
  process.exit(1);
});
