#!/usr/bin/env node
/**
 * Dedicated Ardentis (Swiss dental-clinic network) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllArdentisJobs,
  isArdentisJob,
  isTrustedDomain,
  ARDENTIS_KEY,
  ARDENTIS_COMPANY_NAME,
} from './lib/ardentis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ARDENTIS_KEY,
  companyLabel: ARDENTIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllArdentisJobs,
  isCompanyJob: isArdentisJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Ardentis crawler failed: ${err?.message || err}`);
  process.exit(1);
});
