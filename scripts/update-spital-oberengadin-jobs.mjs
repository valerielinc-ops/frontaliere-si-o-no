#!/usr/bin/env node
/**
 * Dedicated Spital Oberengadin crawler runner.
 *
 * Uses the standard crawler template with the Spital Oberengadin parser.
 * All fetch/parse logic lives in ./lib/spital-oberengadin-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalOberengadinJobs,
  isSpitalOberengadinJob,
  isTrustedDomain,
  SPITAL_OBERENGADIN_KEY,
  SPITAL_OBERENGADIN_COMPANY_NAME,
} from './lib/spital-oberengadin-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_OBERENGADIN_KEY,
  companyLabel: SPITAL_OBERENGADIN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalOberengadinJobs,
  isCompanyJob: isSpitalOberengadinJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Oberengadin crawler failed: ${err?.message || err}`);
  process.exit(1);
});
