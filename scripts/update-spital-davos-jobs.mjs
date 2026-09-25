#!/usr/bin/env node
/**
 * Dedicated Spital Davos crawler runner.
 *
 * Uses the standard crawler template with the Spital Davos parser.
 * All fetch/parse logic lives in ./lib/spital-davos-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalDavosJobs,
  isSpitalDavosJob,
  isTrustedDomain,
  SPITAL_DAVOS_KEY,
  SPITAL_DAVOS_COMPANY_NAME,
} from './lib/spital-davos-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_DAVOS_KEY,
  companyLabel: SPITAL_DAVOS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalDavosJobs,
  isCompanyJob: isSpitalDavosJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Davos crawler failed: ${err?.message || err}`);
  process.exit(1);
});
