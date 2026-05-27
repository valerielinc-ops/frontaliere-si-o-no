#!/usr/bin/env node
/**
 * Dedicated Medartis crawler runner.
 *
 * Uses the standard crawler template with the Medartis parser.
 * All fetch/parse logic lives in ./lib/medartis-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMedartisJobs,
  isMedartisJob,
  isTrustedDomain,
  MEDARTIS_KEY,
  MEDARTIS_COMPANY_NAME,
} from './lib/medartis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MEDARTIS_KEY,
  companyLabel: MEDARTIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMedartisJobs,
  isCompanyJob: isMedartisJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Medartis crawler failed: ${err?.message || err}`);
  process.exit(1);
});
