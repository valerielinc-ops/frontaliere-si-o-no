#!/usr/bin/env node
/**
 * Dedicated Vaxcyte crawler runner.
 *
 * Uses the standard crawler template with the Vaxcyte parser.
 * All fetch/parse logic lives in ./lib/vaxcyte-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVaxcyteJobs,
  isVaxcyteJob,
  isTrustedDomain,
  VAXCYTE_KEY,
  VAXCYTE_COMPANY_NAME,
} from './lib/vaxcyte-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VAXCYTE_KEY,
  companyLabel: VAXCYTE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVaxcyteJobs,
  isCompanyJob: isVaxcyteJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Vaxcyte crawler failed: ${err?.message || err}`);
  process.exit(1);
});
