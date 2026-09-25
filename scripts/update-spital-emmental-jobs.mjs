#!/usr/bin/env node
/**
 * Dedicated Spital Emmental crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalEmmentalJobs,
  isSpitalEmmentalJob,
  isTrustedDomain,
  SPITAL_EMMENTAL_KEY,
  SPITAL_EMMENTAL_COMPANY_NAME,
} from './lib/spital-emmental-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_EMMENTAL_KEY,
  companyLabel: SPITAL_EMMENTAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalEmmentalJobs,
  isCompanyJob: isSpitalEmmentalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Emmental crawler failed: ${err?.message || err}`);
  process.exit(1);
});
