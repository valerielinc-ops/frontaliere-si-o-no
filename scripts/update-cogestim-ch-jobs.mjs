#!/usr/bin/env node
/**
 * Dedicated COGESTIM SA crawler runner.
 *
 * Uses the standard crawler template with the COGESTIM SA parser.
 * All fetch/parse logic lives in ./lib/cogestim-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCogestimChJobs,
  isCogestimChJob,
  isTrustedDomain,
  COGESTIM_CH_KEY,
  COGESTIM_CH_COMPANY_NAME,
} from './lib/cogestim-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: COGESTIM_CH_KEY,
  companyLabel: COGESTIM_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCogestimChJobs,
  isCompanyJob: isCogestimChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ COGESTIM SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
