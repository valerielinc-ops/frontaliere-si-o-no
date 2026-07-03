#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSaintGobainWeberIsoverJobs,
  isSaintGobainWeberIsoverJob,
  isTrustedDomain,
  SAINT_GOBAIN_WEBER_ISOVER_KEY,
  SAINT_GOBAIN_WEBER_ISOVER_COMPANY_NAME,
} from './lib/saint-gobain-weber-isover-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SAINT_GOBAIN_WEBER_ISOVER_KEY,
  companyLabel: SAINT_GOBAIN_WEBER_ISOVER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSaintGobainWeberIsoverJobs,
  isCompanyJob: isSaintGobainWeberIsoverJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Saint-Gobain Weber/Isover Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
