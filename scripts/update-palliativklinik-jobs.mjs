#!/usr/bin/env node
/**
 * Dedicated Palliativklinik im Park crawler runner.
 *
 * Uses the standard crawler template with the Palliativklinik im Park parser.
 * All fetch/parse logic lives in ./lib/palliativklinik-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPalliativklinikJobs,
  isPalliativklinikJob,
  isTrustedDomain,
  PALLIATIVKLINIK_KEY,
  PALLIATIVKLINIK_COMPANY_NAME,
} from './lib/palliativklinik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PALLIATIVKLINIK_KEY,
  companyLabel: PALLIATIVKLINIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPalliativklinikJobs,
  isCompanyJob: isPalliativklinikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Palliativklinik im Park crawler failed: ${err?.message || err}`);
  process.exit(1);
});
