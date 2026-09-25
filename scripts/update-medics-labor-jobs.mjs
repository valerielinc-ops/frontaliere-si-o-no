#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMedicsLaborJobs,
  isMedicsLaborJob,
  isTrustedDomain,
  MEDICS_LABOR_KEY,
  MEDICS_LABOR_COMPANY_NAME,
} from './lib/medics-labor-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: MEDICS_LABOR_KEY,
  companyLabel: MEDICS_LABOR_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllMedicsLaborJobs,
  isCompanyJob: isMedicsLaborJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Medics Labor crawler failed: ${err?.message || err}`); process.exit(1); });
