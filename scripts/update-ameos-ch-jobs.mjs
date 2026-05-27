#!/usr/bin/env node
/**
 * Dedicated AMEOS Schweiz crawler runner.
 *
 * Uses the standard crawler template with the AMEOS Schweiz parser.
 * All fetch/parse logic lives in ./lib/ameos-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAmeosChJobs,
  isAmeosChJob,
  isTrustedDomain,
  AMEOS_CH_KEY,
  AMEOS_CH_COMPANY_NAME,
} from './lib/ameos-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AMEOS_CH_KEY,
  companyLabel: AMEOS_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAmeosChJobs,
  isCompanyJob: isAmeosChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ AMEOS Schweiz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
