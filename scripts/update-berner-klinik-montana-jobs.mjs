#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBernerKlinikMontanaJobs,
  isBernerKlinikMontanaJob,
  isTrustedDomain,
  BERNER_KLINIK_MONTANA_KEY,
  BERNER_KLINIK_MONTANA_COMPANY_NAME,
} from './lib/berner-klinik-montana-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: BERNER_KLINIK_MONTANA_KEY,
  companyLabel: BERNER_KLINIK_MONTANA_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllBernerKlinikMontanaJobs,
  isCompanyJob: isBernerKlinikMontanaJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ Berner Klinik Montana crawler failed: ${err?.message || err}`); process.exit(1); });
