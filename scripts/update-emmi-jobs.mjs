#!/usr/bin/env node
/**
 * Dedicated Emmi crawler runner.
 *
 * Uses the standard crawler template with the Emmi parser.
 * All fetch/parse logic lives in ./lib/emmi-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEmmiJobs,
  isEmmiJob,
  isTrustedDomain,
  EMMI_KEY,
  EMMI_COMPANY_NAME,
} from './lib/emmi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EMMI_KEY,
  companyLabel: EMMI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEmmiJobs,
  isCompanyJob: isEmmiJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Emmi crawler failed: ${err?.message || err}`);
  process.exit(1);
});
