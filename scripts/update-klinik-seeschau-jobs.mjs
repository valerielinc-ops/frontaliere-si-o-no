#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSeeschauJobs,
  isKlinikSeeschauJob,
  isTrustedDomain,
  KLINIK_SEESCHAU_KEY,
  KLINIK_SEESCHAU_COMPANY_NAME,
} from './lib/klinik-seeschau-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: KLINIK_SEESCHAU_KEY,
  companyLabel: KLINIK_SEESCHAU_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllKlinikSeeschauJobs,
  isCompanyJob: isKlinikSeeschauJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Seeschau crawler failed: ${err?.message || err}`);
  process.exit(1);
});
