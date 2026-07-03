#!/usr/bin/env node
/**
 * Dedicated Proton crawler runner.
 *
 * Uses the standard crawler template with the Proton parser.
 * All fetch/parse logic lives in ./lib/proton-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllProtonJobs,
  isProtonJob,
  isTrustedDomain,
  PROTON_KEY,
  PROTON_COMPANY_NAME,
} from './lib/proton-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PROTON_KEY,
  companyLabel: PROTON_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllProtonJobs,
  isCompanyJob: isProtonJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Proton crawler failed: ${err?.message || err}`);
  process.exit(1);
});
