#!/usr/bin/env node
/**
 * Dedicated Spital Affoltern crawler runner.
 *
 * Uses the standard crawler template with the Spital Affoltern parser
 * (Dualoo — 7 job portals).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalAffolternJobs,
  isSpitalAffolternJob,
  isTrustedDomain,
  SPITAL_AFFOLTERN_KEY,
  SPITAL_AFFOLTERN_COMPANY_NAME,
} from './lib/spital-affoltern-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_AFFOLTERN_KEY,
  companyLabel: SPITAL_AFFOLTERN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalAffolternJobs,
  isCompanyJob: isSpitalAffolternJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Affoltern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
