#!/usr/bin/env node
/**
 * Dedicated Gemeinde St. Moritz crawler runner.
 *
 * Uses the standard crawler template with the Gemeinde St. Moritz parser.
 * All fetch/parse logic lives in ./lib/gemeinde-st-moritz-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGemeindeStMoritzJobs,
  isGemeindeStMoritzJob,
  isTrustedDomain,
  GEMEINDE_ST_MORITZ_KEY,
  GEMEINDE_ST_MORITZ_COMPANY_NAME,
} from './lib/gemeinde-st-moritz-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GEMEINDE_ST_MORITZ_KEY,
  companyLabel: GEMEINDE_ST_MORITZ_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGemeindeStMoritzJobs,
  isCompanyJob: isGemeindeStMoritzJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Gemeinde St. Moritz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
