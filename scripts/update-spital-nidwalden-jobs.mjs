#!/usr/bin/env node
/**
 * Dedicated Spital Nidwalden crawler runner.
 *
 * Uses the standard crawler template with the Spital Nidwalden parser.
 * All fetch/parse logic lives in ./lib/spital-nidwalden-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalNidwaldenJobs,
  isSpitalNidwaldenJob,
  isTrustedDomain,
  SPITAL_NIDWALDEN_KEY,
  SPITAL_NIDWALDEN_COMPANY_NAME,
} from './lib/spital-nidwalden-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_NIDWALDEN_KEY,
  companyLabel: SPITAL_NIDWALDEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalNidwaldenJobs,
  isCompanyJob: isSpitalNidwaldenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Nidwalden crawler failed: ${err?.message || err}`);
  process.exit(1);
});
