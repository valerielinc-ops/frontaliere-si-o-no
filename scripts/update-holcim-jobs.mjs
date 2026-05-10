#!/usr/bin/env node
/**
 * Dedicated Holcim Group crawler runner.
 *
 * Uses the standard crawler template with the Holcim Group parser.
 * All fetch/parse logic lives in ./lib/holcim-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHolcimJobs,
  isHolcimJob,
  isTrustedDomain,
  HOLCIM_KEY,
  HOLCIM_COMPANY_NAME,
} from './lib/holcim-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOLCIM_KEY,
  companyLabel: HOLCIM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHolcimJobs,
  isCompanyJob: isHolcimJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Holcim Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
