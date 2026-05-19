#!/usr/bin/env node
/**
 * Dedicated Spitex Schweiz crawler runner.
 *
 * Uses the standard crawler template with the Spitex Schweiz parser.
 * All fetch/parse logic lives in ./lib/spitex-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitexChJobs,
  isSpitexChJob,
  isTrustedDomain,
  SPITEX_CH_KEY,
  SPITEX_CH_COMPANY_NAME,
} from './lib/spitex-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITEX_CH_KEY,
  companyLabel: SPITEX_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitexChJobs,
  isCompanyJob: isSpitexChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spitex Schweiz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
