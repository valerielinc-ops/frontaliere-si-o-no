#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  WOKIN_COMPANY_NAME,
  WOKIN_KEY,
  fetchAllWokinJobs,
  isTrustedDomain,
  isWokinJob,
} from './lib/wokin-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: WOKIN_KEY,
  companyLabel: WOKIN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllWokinJobs,
  isCompanyJob: isWokinJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((error) => {
  console.error(`WOKIN crawler failed: ${error?.message || error}`);
  process.exit(1);
});
