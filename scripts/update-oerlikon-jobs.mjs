#!/usr/bin/env node
/**
 * Dedicated Oerlikon crawler runner.
 *
 * Uses the standard crawler template with the Oerlikon parser.
 * All fetch/parse logic lives in ./lib/oerlikon-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOerlikonJobs,
  isOerlikonJob,
  isTrustedDomain,
  OERLIKON_KEY,
  OERLIKON_COMPANY_NAME,
} from './lib/oerlikon-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OERLIKON_KEY,
  companyLabel: OERLIKON_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOerlikonJobs,
  isCompanyJob: isOerlikonJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Oerlikon crawler failed: ${err?.message || err}`);
  process.exit(1);
});
