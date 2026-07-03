#!/usr/bin/env node
/**
 * Dedicated Scandit AG crawler runner.
 *
 * Uses the standard crawler template with the Scandit AG parser.
 * All fetch/parse logic lives in ./lib/scandit-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllScanditJobs,
  isScanditJob,
  isTrustedDomain,
  SCANDIT_KEY,
  SCANDIT_COMPANY_NAME,
} from './lib/scandit-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SCANDIT_KEY,
  companyLabel: SCANDIT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllScanditJobs,
  isCompanyJob: isScanditJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Scandit AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
