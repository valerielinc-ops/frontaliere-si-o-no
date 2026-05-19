#!/usr/bin/env node
/**
 * Dedicated Spital Lachen crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalLachenJobs,
  isSpitalLachenJob,
  isTrustedDomain,
  SPITAL_LACHEN_KEY,
  SPITAL_LACHEN_COMPANY_NAME,
} from './lib/spital-lachen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_LACHEN_KEY,
  companyLabel: SPITAL_LACHEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalLachenJobs,
  isCompanyJob: isSpitalLachenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Lachen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
