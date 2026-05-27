#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMerianIselinJobs,
  isMerianIselinJob,
  isTrustedDomain,
  MERIAN_ISELIN_KEY,
  MERIAN_ISELIN_COMPANY_NAME,
} from './lib/merian-iselin-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: MERIAN_ISELIN_KEY,
  companyLabel: MERIAN_ISELIN_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllMerianIselinJobs,
  isCompanyJob: isMerianIselinJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Merian Iselin crawler failed: ${err?.message || err}`); process.exit(1); });
