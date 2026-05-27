#!/usr/bin/env node
/**
 * Dedicated Thurklinik crawler runner.
 *
 * Uses the standard crawler template with the Thurklinik parser.
 * All fetch/parse logic lives in ./lib/thurklinik-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllThurklinikJobs,
  isThurklinikJob,
  isTrustedDomain,
  THURKLINIK_KEY,
  THURKLINIK_COMPANY_NAME,
} from './lib/thurklinik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: THURKLINIK_KEY,
  companyLabel: THURKLINIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllThurklinikJobs,
  isCompanyJob: isThurklinikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Thurklinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
