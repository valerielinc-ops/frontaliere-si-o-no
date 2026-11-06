#!/usr/bin/env node
/**
 * Dedicated Spital Schwyz crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalSchwyzJobs,
  isSpitalSchwyzJob,
  isTrustedDomain,
  SPITAL_SCHWYZ_KEY,
  SPITAL_SCHWYZ_COMPANY_NAME,
} from './lib/spital-schwyz-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_SCHWYZ_KEY,
  companyLabel: SPITAL_SCHWYZ_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalSchwyzJobs,
  isCompanyJob: isSpitalSchwyzJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Schwyz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
