#!/usr/bin/env node
/**
 * Dedicated Patek Philippe crawler runner.
 *
 * Uses the standard crawler template with the Patek Philippe parser.
 * All fetch/parse logic lives in ./lib/patek-philippe-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPatekPhilippeJobs,
  isPatekPhilippeJob,
  isTrustedDomain,
  PATEK_PHILIPPE_KEY,
  PATEK_PHILIPPE_COMPANY_NAME,
} from './lib/patek-philippe-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PATEK_PHILIPPE_KEY,
  companyLabel: PATEK_PHILIPPE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPatekPhilippeJobs,
  isCompanyJob: isPatekPhilippeJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Patek Philippe crawler failed: ${err?.message || err}`);
  process.exit(1);
});
