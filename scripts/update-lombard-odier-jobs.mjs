#!/usr/bin/env node
/**
 * Dedicated Lombard Odier crawler runner.
 *
 * Uses the standard crawler template with the Lombard Odier parser.
 * All fetch/parse logic lives in ./lib/lombard-odier-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLombardOdierJobs,
  isLombardOdierJob,
  isTrustedDomain,
  LOMBARD_ODIER_KEY,
  LOMBARD_ODIER_COMPANY_NAME,
} from './lib/lombard-odier-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LOMBARD_ODIER_KEY,
  companyLabel: LOMBARD_ODIER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLombardOdierJobs,
  isCompanyJob: isLombardOdierJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Lombard Odier crawler failed: ${err?.message || err}`);
  process.exit(1);
});
