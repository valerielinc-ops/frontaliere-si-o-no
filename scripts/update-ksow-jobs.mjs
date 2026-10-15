#!/usr/bin/env node
/**
 * Dedicated Kantonsspital Obwalden crawler runner.
 *
 * Uses the standard crawler template with the Kantonsspital Obwalden parser.
 * All fetch/parse logic lives in ./lib/ksow-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKsowJobs,
  isKsowJob,
  isTrustedDomain,
  KSOW_KEY,
  KSOW_COMPANY_NAME,
} from './lib/ksow-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSOW_KEY,
  companyLabel: KSOW_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKsowJobs,
  isCompanyJob: isKsowJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kantonsspital Obwalden crawler failed: ${err?.message || err}`);
  process.exit(1);
});
