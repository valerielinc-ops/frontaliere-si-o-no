#!/usr/bin/env node
/**
 * Dedicated BMS Building Materials crawler runner.
 *
 * Uses the standard crawler template with the BMS Building Materials parser.
 * All fetch/parse logic lives in ./lib/bms-building-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBmsBuildingJobs,
  isBmsBuildingJob,
  isTrustedDomain,
  BMS_BUILDING_KEY,
  BMS_BUILDING_COMPANY_NAME,
} from './lib/bms-building-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BMS_BUILDING_KEY,
  companyLabel: BMS_BUILDING_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBmsBuildingJobs,
  isCompanyJob: isBmsBuildingJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ BMS Building Materials crawler failed: ${err?.message || err}`);
  process.exit(1);
});
