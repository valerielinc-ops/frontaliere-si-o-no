#!/usr/bin/env node
/**
 * Dedicated Blatter's Arosa Hotel crawler runner.
 *
 * Uses the standard crawler template with the Blatter's Arosa Hotel parser.
 * All fetch/parse logic lives in ./lib/blatters-hotel-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBlattersHotelJobs,
  isBlattersHotelJob,
  isTrustedDomain,
  BLATTERS_HOTEL_KEY,
  BLATTERS_HOTEL_COMPANY_NAME,
} from './lib/blatters-hotel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BLATTERS_HOTEL_KEY,
  companyLabel: BLATTERS_HOTEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBlattersHotelJobs,
  isCompanyJob: isBlattersHotelJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Blatter's Arosa Hotel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
