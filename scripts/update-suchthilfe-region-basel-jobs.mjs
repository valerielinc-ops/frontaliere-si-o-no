#!/usr/bin/env node
/**
 * Dedicated Suchthilfe Region Basel crawler runner.
 *
 * Uses the standard crawler template with the Suchthilfe Region Basel parser.
 * All fetch/parse logic lives in ./lib/suchthilfe-region-basel-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSuchthilfeRegionBaselJobs,
  isSuchthilfeRegionBaselJob,
  isTrustedDomain,
  SUCHTHILFE_REGION_BASEL_KEY,
  SUCHTHILFE_REGION_BASEL_COMPANY_NAME,
} from './lib/suchthilfe-region-basel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SUCHTHILFE_REGION_BASEL_KEY,
  companyLabel: SUCHTHILFE_REGION_BASEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSuchthilfeRegionBaselJobs,
  isCompanyJob: isSuchthilfeRegionBaselJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Suchthilfe Region Basel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
