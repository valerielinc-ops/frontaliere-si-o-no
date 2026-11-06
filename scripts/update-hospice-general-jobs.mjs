#!/usr/bin/env node
/**
 * Dedicated Hospice général crawler runner.
 *
 * Uses the standard crawler template with the Hospice général parser.
 * All fetch/parse logic lives in ./lib/hospice-general-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHospiceGeneralJobs,
  isHospiceGeneralJob,
  isTrustedDomain,
  HOSPICE_GENERAL_KEY,
  HOSPICE_GENERAL_COMPANY_NAME,
} from './lib/hospice-general-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOSPICE_GENERAL_KEY,
  companyLabel: HOSPICE_GENERAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHospiceGeneralJobs,
  isCompanyJob: isHospiceGeneralJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Hospice général crawler failed: ${err?.message || err}`);
  process.exit(1);
});
