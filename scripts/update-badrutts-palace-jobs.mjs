#!/usr/bin/env node
/**
 * Dedicated Badrutt's Palace Hotel crawler runner.
 *
 * Uses the standard crawler template with the Badrutt's Palace Hotel parser.
 * All fetch/parse logic lives in ./lib/badrutts-palace-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBadruttsPalaceJobs,
  isBadruttsPalaceJob,
  isTrustedDomain,
  BADRUTTS_PALACE_KEY,
  BADRUTTS_PALACE_COMPANY_NAME,
} from './lib/badrutts-palace-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BADRUTTS_PALACE_KEY,
  companyLabel: BADRUTTS_PALACE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBadruttsPalaceJobs,
  isCompanyJob: isBadruttsPalaceJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Badrutt's Palace Hotel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
