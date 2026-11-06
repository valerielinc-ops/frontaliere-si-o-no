#!/usr/bin/env node
/**
 * Dedicated Seniorenzentrum Engelhof crawler runner.
 *
 * All source-specific extraction lives in the parser; the standard pipeline
 * owns validation, localization, merge identity and the crawler slice.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSeniorenzentrumEngelhofJobs,
  isSeniorenzentrumEngelhofJob,
  isTrustedDomain,
  SENIORENZENTRUM_ENGELHOF_KEY,
  SENIORENZENTRUM_ENGELHOF_COMPANY_NAME,
} from './lib/seniorenzentrum-engelhof-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
  companyLabel: SENIORENZENTRUM_ENGELHOF_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSeniorenzentrumEngelhofJobs,
  isCompanyJob: isSeniorenzentrumEngelhofJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(
    '❌ ' + SENIORENZENTRUM_ENGELHOF_COMPANY_NAME + ' crawler failed: ' + (err?.message || err),
  );
  process.exit(1);
});
