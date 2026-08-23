#!/usr/bin/env node
/**
 * Dedicated E-Recruiting LLB-Gruppe Stellen crawler runner.
 *
 * Uses the standard crawler template with the E-Recruiting LLB-Gruppe Stellen parser.
 * All fetch/parse logic lives in ./lib/recruitingapp-2677-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRecruitingapp2677Jobs,
  isRecruitingapp2677Job,
  isTrustedDomain,
  RECRUITINGAPP_2677_KEY,
  RECRUITINGAPP_2677_COMPANY_NAME,
} from './lib/recruitingapp-2677-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RECRUITINGAPP_2677_KEY,
  companyLabel: RECRUITINGAPP_2677_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRecruitingapp2677Jobs,
  isCompanyJob: isRecruitingapp2677Job,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ E-Recruiting LLB-Gruppe Stellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
