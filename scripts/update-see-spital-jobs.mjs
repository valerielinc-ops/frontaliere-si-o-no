#!/usr/bin/env node
/**
 * Dedicated See-Spital crawler runner.
 *
 * Uses the standard crawler template with the See-Spital parser.
 * All fetch/parse logic lives in ./lib/see-spital-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSeeSpitalJobs,
  isSeeSpitalJob,
  isTrustedDomain,
  SEE_SPITAL_KEY,
  SEE_SPITAL_COMPANY_NAME,
} from './lib/see-spital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SEE_SPITAL_KEY,
  companyLabel: SEE_SPITAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSeeSpitalJobs,
  isCompanyJob: isSeeSpitalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ See-Spital crawler failed: ${err?.message || err}`);
  process.exit(1);
});
