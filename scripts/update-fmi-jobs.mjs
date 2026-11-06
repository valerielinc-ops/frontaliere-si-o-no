#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFmiJobs,
  isFmiJob,
  isTrustedDomain,
  FMI_KEY,
  FMI_COMPANY_NAME,
} from './lib/fmi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: FMI_KEY,
  companyLabel: FMI_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllFmiJobs,
  isCompanyJob: isFmiJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Spitäler fmi crawler failed: ${err?.message || err}`); process.exit(1); });
