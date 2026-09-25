#!/usr/bin/env node
/**
 * Dedicated Pictet Group crawler runner.
 *
 * Uses the standard crawler template with the Pictet Group parser.
 * All fetch/parse logic lives in ./lib/pictet-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPictetJobs,
  isPictetJob,
  isTrustedDomain,
  PICTET_KEY,
  PICTET_COMPANY_NAME,
} from './lib/pictet-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PICTET_KEY,
  companyLabel: PICTET_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPictetJobs,
  isCompanyJob: isPictetJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Pictet Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
