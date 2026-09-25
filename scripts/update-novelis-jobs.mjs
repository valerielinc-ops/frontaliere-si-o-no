#!/usr/bin/env node
/**
 * Dedicated Novelis crawler runner.
 *
 * Uses the standard crawler template with the Novelis parser.
 * All fetch/parse logic lives in ./lib/novelis-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNovelisJobs,
  isNovelisJob,
  isTrustedDomain,
  NOVELIS_KEY,
  NOVELIS_COMPANY_NAME,
} from './lib/novelis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NOVELIS_KEY,
  companyLabel: NOVELIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNovelisJobs,
  isCompanyJob: isNovelisJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Novelis crawler failed: ${err?.message || err}`);
  process.exit(1);
});
