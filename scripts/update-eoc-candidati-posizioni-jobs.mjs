#!/usr/bin/env node
/**
 * Dedicated EOC candiDati Posizioni crawler runner.
 *
 * Uses the standard crawler template with the EOC candiDati Posizioni parser.
 * All fetch/parse logic lives in ./lib/eoc-candidati-posizioni-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEocCandidatiPosizioniJobs,
  isEocCandidatiPosizioniJob,
  isTrustedDomain,
  EOC_CANDIDATI_POSIZIONI_KEY,
  EOC_CANDIDATI_POSIZIONI_COMPANY_NAME,
} from './lib/eoc-candidati-posizioni-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EOC_CANDIDATI_POSIZIONI_KEY,
  companyLabel: EOC_CANDIDATI_POSIZIONI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEocCandidatiPosizioniJobs,
  isCompanyJob: isEocCandidatiPosizioniJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ EOC candiDati Posizioni crawler failed: ${err?.message || err}`);
  process.exit(1);
});
