#!/usr/bin/env node
/**
 * Dedicated Swiss Education Company GmbH crawler runner.
 *
 * Uses the standard crawler template with the Swiss Education Company GmbH parser.
 * All fetch/parse logic lives in ./lib/swiss-education-company-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSwissEducationCompanyChJobs,
  isSwissEducationCompanyChJob,
  isTrustedDomain,
  SWISS_EDUCATION_COMPANY_CH_KEY,
  SWISS_EDUCATION_COMPANY_CH_COMPANY_NAME,
} from './lib/swiss-education-company-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SWISS_EDUCATION_COMPANY_CH_KEY,
  companyLabel: SWISS_EDUCATION_COMPANY_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSwissEducationCompanyChJobs,
  isCompanyJob: isSwissEducationCompanyChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Swiss Education Company GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
