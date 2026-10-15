#!/usr/bin/env node
/**
 * Dedicated Ardian crawler runner.
 *
 * Uses the standard crawler template with the Ardian parser.
 * All fetch/parse logic lives in ./lib/ardian-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllArdianJobs,
  isArdianJob,
  isTrustedDomain,
  ARDIAN_KEY,
  ARDIAN_COMPANY_NAME,
} from './lib/ardian-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ARDIAN_KEY,
  companyLabel: ARDIAN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllArdianJobs,
  isCompanyJob: isArdianJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Ardian crawler failed: ${err?.message || err}`);
  process.exit(1);
});
