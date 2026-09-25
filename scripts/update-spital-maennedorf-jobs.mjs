#!/usr/bin/env node
/**
 * Dedicated Spital Männedorf crawler runner.
 *
 * Uses the standard crawler template with the Spital Männedorf parser.
 * All fetch/parse logic lives in ./lib/spital-maennedorf-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalMaennedorfJobs,
  isSpitalMaennedorfJob,
  isTrustedDomain,
  SPITAL_MAENNEDORF_KEY,
  SPITAL_MAENNEDORF_COMPANY_NAME,
} from './lib/spital-maennedorf-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_MAENNEDORF_KEY,
  companyLabel: SPITAL_MAENNEDORF_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalMaennedorfJobs,
  isCompanyJob: isSpitalMaennedorfJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Männedorf crawler failed: ${err?.message || err}`);
  process.exit(1);
});
