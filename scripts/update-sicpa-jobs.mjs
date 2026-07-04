#!/usr/bin/env node
/**
 * Dedicated SICPA SA crawler runner.
 *
 * Uses the standard crawler template with the SICPA SA parser.
 * All fetch/parse logic lives in ./lib/sicpa-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSicpaJobs,
  isSicpaJob,
  isTrustedDomain,
  SICPA_KEY,
  SICPA_COMPANY_NAME,
} from './lib/sicpa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SICPA_KEY,
  companyLabel: SICPA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSicpaJobs,
  isCompanyJob: isSicpaJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ SICPA SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
