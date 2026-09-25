#!/usr/bin/env node
/**
 * Dedicated Clinique de La Source crawler runner.
 *
 * All fetch/parse logic lives in ./lib/clinique-la-source-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCliniqueLaSourceJobs,
  isCliniqueLaSourceJob,
  isTrustedDomain,
  CLINIQUE_LA_SOURCE_KEY,
  CLINIQUE_LA_SOURCE_COMPANY_NAME,
} from './lib/clinique-la-source-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINIQUE_LA_SOURCE_KEY,
  companyLabel: CLINIQUE_LA_SOURCE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCliniqueLaSourceJobs,
  isCompanyJob: isCliniqueLaSourceJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Clinique de La Source crawler failed: ${err?.message || err}`);
  process.exit(1);
});
