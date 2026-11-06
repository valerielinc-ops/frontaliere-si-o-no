#!/usr/bin/env node
/**
 * Dedicated eqe AG crawler runner.
 *
 * Uses the standard crawler template with the eqe AG parser.
 * All fetch/parse logic lives in ./lib/eqe-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEqeChJobs,
  isEqeChJob,
  isTrustedDomain,
  EQE_CH_KEY,
  EQE_CH_COMPANY_NAME,
} from './lib/eqe-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EQE_CH_KEY,
  companyLabel: EQE_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEqeChJobs,
  isCompanyJob: isEqeChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ eqe AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
