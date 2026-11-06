#!/usr/bin/env node
/**
 * Dedicated Spital Zofingen crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalZofingenJobs,
  isSpitalZofingenJob,
  isTrustedDomain,
  SPITAL_ZOFINGEN_KEY,
  SPITAL_ZOFINGEN_COMPANY_NAME,
} from './lib/spital-zofingen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_ZOFINGEN_KEY,
  companyLabel: SPITAL_ZOFINGEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalZofingenJobs,
  isCompanyJob: isSpitalZofingenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Zofingen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
