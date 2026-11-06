#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHJuJobs,
  isHJuJob,
  isTrustedDomain,
  H_JU_KEY,
  H_JU_COMPANY_NAME,
} from './lib/h-ju-hopital-du-jura-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: H_JU_KEY,
  companyLabel: H_JU_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllHJuJobs,
  isCompanyJob: isHJuJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ H-JU crawler failed: ${err?.message || err}`); process.exit(1); });
