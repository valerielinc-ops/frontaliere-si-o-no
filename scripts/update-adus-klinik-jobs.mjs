#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAdusKlinikJobs,
  isAdusKlinikJob,
  isTrustedDomain,
  ADUS_KLINIK_KEY,
  ADUS_KLINIK_COMPANY_NAME,
} from './lib/adus-klinik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: ADUS_KLINIK_KEY,
  companyLabel: ADUS_KLINIK_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllAdusKlinikJobs,
  isCompanyJob: isAdusKlinikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ADUS Klinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
