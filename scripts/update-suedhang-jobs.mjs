#!/usr/bin/env node
/**
 * Dedicated Klinik Südhang crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSuedhangJobs,
  isSuedhangJob,
  isTrustedDomain,
  SUEDHANG_KEY,
  SUEDHANG_COMPANY_NAME,
} from './lib/suedhang-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SUEDHANG_KEY,
  companyLabel: SUEDHANG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSuedhangJobs,
  isCompanyJob: isSuedhangJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Südhang crawler failed: ${err?.message || err}`);
  process.exit(1);
});
