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
  THURKLINIK_FABRICATED_DESCRIPTION_RE,
} from './lib/thurklinik-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

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
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, THURKLINIK_FABRICATED_DESCRIPTION_RE, THURKLINIK_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Thurklinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
