#!/usr/bin/env node
/**
 * Dedicated Kulm Hotel St. Moritz crawler runner.
 *
 * Uses the standard crawler template with the Kulm Hotel St. Moritz parser.
 * All fetch/parse logic lives in ./lib/kulm-hotel-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKulmHotelJobs,
  isKulmHotelJob,
  isTrustedDomain,
  KULM_HOTEL_KEY,
  KULM_HOTEL_COMPANY_NAME,
} from './lib/kulm-hotel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KULM_HOTEL_KEY,
  companyLabel: KULM_HOTEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKulmHotelJobs,
  isCompanyJob: isKulmHotelJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Kulm Hotel St. Moritz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
