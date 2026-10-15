#!/usr/bin/env node
/**
 * Dedicated Clinique de Valère crawler runner.
 *
 * Uses the standard crawler template with the Clinique de Valère parser.
 * All fetch/parse logic lives in ./lib/clinique-de-valere-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCliniqueDeValereJobs,
  isCliniqueDeValereJob,
  isTrustedDomain,
  CLINIQUE_DE_VALERE_KEY,
  CLINIQUE_DE_VALERE_COMPANY_NAME,
} from './lib/clinique-de-valere-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINIQUE_DE_VALERE_KEY,
  companyLabel: CLINIQUE_DE_VALERE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCliniqueDeValereJobs,
  isCompanyJob: isCliniqueDeValereJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Clinique de Valère crawler failed: ${err?.message || err}`);
  process.exit(1);
});
