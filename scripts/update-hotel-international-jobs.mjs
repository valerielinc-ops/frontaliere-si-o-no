#!/usr/bin/env node
/**
 * Dedicated Hotel International au Lac crawler runner.
 *
 * Uses the standard crawler template with the Hotel International au Lac parser.
 * All fetch/parse logic lives in ./lib/hotel-international-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHotelInternationalJobs,
  isHotelInternationalJob,
  isTrustedDomain,
  HOTEL_INTERNATIONAL_KEY,
  HOTEL_INTERNATIONAL_COMPANY_NAME,
} from './lib/hotel-international-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOTEL_INTERNATIONAL_KEY,
  companyLabel: HOTEL_INTERNATIONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHotelInternationalJobs,
  isCompanyJob: isHotelInternationalJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Hotel International au Lac crawler failed: ${err?.message || err}`);
  process.exit(1);
});
