#!/usr/bin/env node
/**
 * Dedicated Universitäre Psychiatrische Dienste Bern (UPD) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUpdJobs,
  isUpdJob,
  isTrustedDomain,
  UPD_KEY,
  UPD_COMPANY_NAME,
} from './lib/upd-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UPD_KEY,
  companyLabel: UPD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUpdJobs,
  isCompanyJob: isUpdJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ UPD crawler failed: ${err?.message || err}`);
  process.exit(1);
});
