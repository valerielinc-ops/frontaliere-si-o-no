#!/usr/bin/env node
/**
 * Dedicated Switch Bewerbermanagement Stellen crawler runner.
 *
 * Uses the standard crawler template with the Switch Bewerbermanagement Stellen parser.
 * All fetch/parse logic lives in ./lib/recruitingapp-2563-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRecruitingapp2563Jobs,
  isRecruitingapp2563Job,
  isTrustedDomain,
  RECRUITINGAPP_2563_KEY,
  RECRUITINGAPP_2563_COMPANY_NAME,
} from './lib/recruitingapp-2563-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RECRUITINGAPP_2563_KEY,
  companyLabel: RECRUITINGAPP_2563_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRecruitingapp2563Jobs,
  isCompanyJob: isRecruitingapp2563Job,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Switch Bewerbermanagement Stellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
