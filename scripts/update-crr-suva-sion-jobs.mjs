#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCrrJobs,
  isCrrJob,
  isTrustedDomain,
  CRR_KEY,
  CRR_COMPANY_NAME,
} from './lib/crr-suva-sion-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CRR_KEY,
  companyLabel: CRR_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCrrJobs,
  isCompanyJob: isCrrJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ CRR Suva crawler failed: ${err?.message || err}`); process.exit(1); });
