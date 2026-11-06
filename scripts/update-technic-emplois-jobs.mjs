#!/usr/bin/env node
/** Run the dedicated Technic Emplois SA crawler. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTechnicEmploisJobs,
  isTechnicEmploisJob,
  isTrustedDomain,
  TECHNIC_EMPLOIS_KEY,
  TECHNIC_EMPLOIS_COMPANY_NAME,
} from './lib/technic-emplois-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TECHNIC_EMPLOIS_KEY,
  companyLabel: TECHNIC_EMPLOIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTechnicEmploisJobs,
  isCompanyJob: isTechnicEmploisJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ ${TECHNIC_EMPLOIS_COMPANY_NAME} crawler failed: ${err?.message || err}`);
  process.exit(1);
});
