#!/usr/bin/env node
/**
 * Dedicated City Pop crawler runner.
 *
 * Uses the standard crawler template with the City Pop parser.
 * All fetch/parse logic lives in ./lib/city-pop-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCityPopJobs,
  isCityPopJob,
  isTrustedDomain,
  CITY_POP_KEY,
  CITY_POP_COMPANY_NAME,
} from './lib/city-pop-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CITY_POP_KEY,
  companyLabel: CITY_POP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCityPopJobs,
  isCompanyJob: isCityPopJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ City Pop crawler failed: ${err?.message || err}`);
  process.exit(1);
});
