#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRhExpertChJobs,
  isRhExpertChJob,
  isTrustedDomain,
  RH_EXPERT_CH_KEY,
  RH_EXPERT_CH_COMPANY_NAME,
} from './lib/rh-expert-ch-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: RH_EXPERT_CH_KEY,
  companyLabel: RH_EXPERT_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRhExpertChJobs,
  isCompanyJob: isRhExpertChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ RH-Expert crawler failed: ${err?.message || err}`);
  process.exit(1);
});
