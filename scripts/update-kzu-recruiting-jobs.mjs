#!/usr/bin/env node
/**
 * Dedicated KZU Recruiting crawler runner.
 *
 * Uses the standard crawler template with the KZU Recruiting parser.
 * All fetch/parse logic lives in ./lib/kzu-recruiting-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKzuRecruitingJobs,
  isKzuRecruitingJob,
  isTrustedDomain,
  KZU_RECRUITING_KEY,
  KZU_RECRUITING_COMPANY_NAME,
} from './lib/kzu-recruiting-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KZU_RECRUITING_KEY,
  companyLabel: KZU_RECRUITING_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKzuRecruitingJobs,
  isCompanyJob: isKzuRecruitingJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ KZU Recruiting crawler failed: ${err?.message || err}`);
  process.exit(1);
});
