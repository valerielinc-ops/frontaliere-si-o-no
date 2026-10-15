#!/usr/bin/env node
/**
 * Dedicated Spital Muri crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalMuriJobs,
  isSpitalMuriJob,
  isTrustedDomain,
  SPITAL_MURI_KEY,
  SPITAL_MURI_COMPANY_NAME,
} from './lib/spital-muri-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_MURI_KEY,
  companyLabel: SPITAL_MURI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalMuriJobs,
  isCompanyJob: isSpitalMuriJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Muri crawler failed: ${err?.message || err}`);
  process.exit(1);
});
