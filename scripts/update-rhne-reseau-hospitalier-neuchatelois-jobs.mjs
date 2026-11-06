#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRhneJobs,
  isRhneJob,
  isTrustedDomain,
  RHNE_KEY,
  RHNE_COMPANY_NAME,
} from './lib/rhne-reseau-hospitalier-neuchatelois-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: RHNE_KEY,
  companyLabel: RHNE_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllRhneJobs,
  isCompanyJob: isRhneJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ RHNE crawler failed: ${err?.message || err}`); process.exit(1); });
