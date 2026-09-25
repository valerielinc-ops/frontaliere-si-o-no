#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPlanzerJobs,
  isPlanzerJob,
  isTrustedDomain,
  PLANZER_KEY,
  PLANZER_COMPANY_NAME,
} from './lib/planzer-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PLANZER_KEY,
  companyLabel: PLANZER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPlanzerJobs,
  isCompanyJob: isPlanzerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Planzer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
