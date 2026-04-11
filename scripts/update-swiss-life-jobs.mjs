#!/usr/bin/env node
/**
 * Dedicated Swiss Life crawler runner.
 *
 * Uses the standard crawler template with the Swiss Life parser.
 * All fetch/parse logic lives in ./lib/swiss-life-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSwissLifeJobs,
  isSwissLifeJob,
  isTrustedDomain,
  SWISS_LIFE_KEY,
  SWISS_LIFE_COMPANY_NAME,
} from './lib/swiss-life-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SWISS_LIFE_KEY,
  companyLabel: SWISS_LIFE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSwissLifeJobs,
  isCompanyJob: isSwissLifeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Swiss Life crawler failed: ${err?.message || err}`);
  process.exit(1);
});
