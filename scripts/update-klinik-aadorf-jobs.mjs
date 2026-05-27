#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikAadorfJobs,
  isKlinikAadorfJob,
  isTrustedDomain,
  KLINIK_AADORF_KEY,
  KLINIK_AADORF_COMPANY_NAME,
} from './lib/klinik-aadorf-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: KLINIK_AADORF_KEY,
  companyLabel: KLINIK_AADORF_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllKlinikAadorfJobs,
  isCompanyJob: isKlinikAadorfJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Aadorf crawler failed: ${err?.message || err}`);
  process.exit(1);
});
