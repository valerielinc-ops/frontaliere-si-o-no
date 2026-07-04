#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKuhnRikonJobs,
  isKuhnRikonJob,
  isTrustedDomain,
  KUHN_RIKON_KEY,
  KUHN_RIKON_COMPANY_NAME,
} from './lib/kuhn-rikon-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KUHN_RIKON_KEY,
  companyLabel: KUHN_RIKON_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKuhnRikonJobs,
  isCompanyJob: isKuhnRikonJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kuhn Rikon crawler failed: ${err?.message || err}`);
  process.exit(1);
});
