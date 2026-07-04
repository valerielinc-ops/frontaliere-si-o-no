#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSuvaJobs,
  isSuvaJob,
  isTrustedDomain,
  SUVA_KEY,
  SUVA_COMPANY_NAME,
} from './lib/suva-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SUVA_KEY,
  companyLabel: SUVA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSuvaJobs,
  isCompanyJob: isSuvaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Suva crawler failed: ${err?.message || err}`);
  process.exit(1);
});
