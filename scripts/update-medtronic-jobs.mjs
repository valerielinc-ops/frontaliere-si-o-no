#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMedtronicJobs,
  isMedtronicJob,
  isTrustedDomain,
  MEDTRONIC_KEY,
  MEDTRONIC_COMPANY_NAME,
} from './lib/medtronic-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: MEDTRONIC_KEY,
  companyLabel: MEDTRONIC_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllMedtronicJobs,
  isCompanyJob: isMedtronicJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => { console.error(`❌ Medtronic crawler failed: ${err?.message || err}`); process.exit(1); });
