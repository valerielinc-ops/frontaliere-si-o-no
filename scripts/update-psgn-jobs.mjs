#!/usr/bin/env node
/**
 * Dedicated Psychiatrie St.Gallen (PSGN) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPsgnJobs,
  isPsgnJob,
  isTrustedDomain,
  PSGN_KEY,
  PSGN_COMPANY_NAME,
} from './lib/psgn-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PSGN_KEY,
  companyLabel: PSGN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPsgnJobs,
  isCompanyJob: isPsgnJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ${PSGN_COMPANY_NAME} crawler failed: ${err?.message || err}`);
  process.exit(1);
});
