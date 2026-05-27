#!/usr/bin/env node
/**
 * Dedicated Vaudoise Assurances crawler runner.
 *
 * Uses the standard crawler template with the Vaudoise Assurances parser.
 * All fetch/parse logic lives in ./lib/vaudoise-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVaudoiseJobs,
  isVaudoiseJob,
  isTrustedDomain,
  VAUDOISE_KEY,
  VAUDOISE_COMPANY_NAME,
} from './lib/vaudoise-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VAUDOISE_KEY,
  companyLabel: VAUDOISE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVaudoiseJobs,
  isCompanyJob: isVaudoiseJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Vaudoise Assurances crawler failed: ${err?.message || err}`);
  process.exit(1);
});
