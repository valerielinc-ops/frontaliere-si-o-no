#!/usr/bin/env node
/**
 * Dedicated Kantonsspital St. Gallen (KSSG / HOCH) crawler runner.
 *
 * Uses the standard crawler template with the Kantonsspital St. Gallen (KSSG / HOCH) parser.
 * All fetch/parse logic lives in ./lib/kssg-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKssgJobs,
  isKssgJob,
  isTrustedDomain,
  KSSG_KEY,
  KSSG_COMPANY_NAME,
} from './lib/kssg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSSG_KEY,
  companyLabel: KSSG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKssgJobs,
  isCompanyJob: isKssgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kantonsspital St. Gallen (KSSG / HOCH) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
