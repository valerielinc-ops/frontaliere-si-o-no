#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikArlesheimJobs,
  isKlinikArlesheimJob,
  isTrustedDomain,
  KLINIK_ARLESHEIM_KEY,
  KLINIK_ARLESHEIM_COMPANY_NAME,
} from './lib/klinik-arlesheim-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: KLINIK_ARLESHEIM_KEY,
  companyLabel: KLINIK_ARLESHEIM_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllKlinikArlesheimJobs,
  isCompanyJob: isKlinikArlesheimJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Klinik Arlesheim crawler failed: ${err?.message || err}`); process.exit(1); });
