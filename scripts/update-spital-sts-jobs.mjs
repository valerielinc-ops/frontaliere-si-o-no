#!/usr/bin/env node
/**
 * Dedicated Spital STS crawler runner.
 *
 * Uses the standard crawler template with the Spital STS parser.
 * All fetch/parse logic lives in ./lib/spital-sts-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalStsJobs,
  isSpitalStsJob,
  isTrustedDomain,
  SPITAL_STS_KEY,
  SPITAL_STS_COMPANY_NAME,
} from './lib/spital-sts-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_STS_KEY,
  companyLabel: SPITAL_STS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalStsJobs,
  isCompanyJob: isSpitalStsJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital STS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
