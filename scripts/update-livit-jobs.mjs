#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLivitJobs,
  isLivitJob,
  isTrustedDomain,
  LIVIT_KEY,
  LIVIT_COMPANY_NAME,
} from './lib/livit-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: LIVIT_KEY,
  companyLabel: LIVIT_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllLivitJobs,
  isCompanyJob: isLivitJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Livit crawler failed: ${err?.message || err}`); process.exit(1); });
