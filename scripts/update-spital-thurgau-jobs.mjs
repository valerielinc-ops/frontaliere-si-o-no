#!/usr/bin/env node
/**
 * Dedicated Spital Thurgau (STGAG) crawler runner.
 *
 * Uses the standard crawler template with the Spital Thurgau (STGAG) parser.
 * All fetch/parse logic lives in ./lib/spital-thurgau-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalThurgauJobs,
  isSpitalThurgauJob,
  isTrustedDomain,
  SPITAL_THURGAU_KEY,
  SPITAL_THURGAU_COMPANY_NAME,
} from './lib/spital-thurgau-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_THURGAU_KEY,
  companyLabel: SPITAL_THURGAU_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalThurgauJobs,
  isCompanyJob: isSpitalThurgauJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Thurgau (STGAG) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
