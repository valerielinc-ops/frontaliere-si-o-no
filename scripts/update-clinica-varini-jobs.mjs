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
  CLINICA_VARINI_FABRICATED_DESCRIPTION_RE,
} from './lib/clinica-varini-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

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
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, CLINICA_VARINI_FABRICATED_DESCRIPTION_RE, CLINICA_VARINI_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Clinica Varini crawler failed: ${err?.message || err}`);
  process.exit(1);
});
