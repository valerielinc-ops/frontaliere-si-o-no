#!/usr/bin/env node
/**
 * Dedicated Clinica Hildebrand (Brissago, TI) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllClinicaHildebrandJobs,
  isClinicaHildebrandJob,
  isTrustedDomain,
  CLINICA_HILDEBRAND_KEY,
  CLINICA_HILDEBRAND_COMPANY_NAME,
  CLINICA_HILDEBRAND_FABRICATED_DESCRIPTION_RE,
} from './lib/clinica-hildebrand-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINICA_HILDEBRAND_KEY,
  companyLabel: CLINICA_HILDEBRAND_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllClinicaHildebrandJobs,
  isCompanyJob: isClinicaHildebrandJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, CLINICA_HILDEBRAND_FABRICATED_DESCRIPTION_RE, CLINICA_HILDEBRAND_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Clinica Hildebrand crawler failed: ${err?.message || err}`);
  process.exit(1);
});
