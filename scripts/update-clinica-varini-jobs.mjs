#!/usr/bin/env node
/**
 * Dedicated Clinica Varini (Orselina, TI) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllClinicaVariniJobs,
  isClinicaVariniJob,
  isTrustedDomain,
  CLINICA_VARINI_KEY,
  CLINICA_VARINI_COMPANY_NAME,
} from './lib/clinica-varini-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINICA_VARINI_KEY,
  companyLabel: CLINICA_VARINI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllClinicaVariniJobs,
  isCompanyJob: isClinicaVariniJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Clinica Varini crawler failed: ${err?.message || err}`);
  process.exit(1);
});
