#!/usr/bin/env node
/**
 * Dedicated Cham Swiss Properties crawler runner.
 *
 * Uses the standard crawler template with the Cham Swiss Properties parser.
 * All fetch/parse logic lives in ./lib/cham-swiss-properties-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllChamSwissPropertiesJobs,
  isChamSwissPropertiesJob,
  isTrustedDomain,
  CHAM_SWISS_PROPERTIES_KEY,
  CHAM_SWISS_PROPERTIES_COMPANY_NAME,
} from './lib/cham-swiss-properties-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CHAM_SWISS_PROPERTIES_KEY,
  companyLabel: CHAM_SWISS_PROPERTIES_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllChamSwissPropertiesJobs,
  isCompanyJob: isChamSwissPropertiesJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Cham Swiss Properties crawler failed: ${err?.message || err}`);
  process.exit(1);
});
