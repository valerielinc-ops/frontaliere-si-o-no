#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVitreaGesundheitJobs,
  isVitreaGesundheitJob,
  isTrustedDomain,
  VITREA_GESUNDHEIT_KEY,
  VITREA_GESUNDHEIT_COMPANY_NAME,
} from './lib/vitrea-gesundheit-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: VITREA_GESUNDHEIT_KEY,
  companyLabel: VITREA_GESUNDHEIT_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllVitreaGesundheitJobs,
  isCompanyJob: isVitreaGesundheitJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Vitrea Gesundheit crawler failed: ${err?.message || err}`); process.exit(1); });
