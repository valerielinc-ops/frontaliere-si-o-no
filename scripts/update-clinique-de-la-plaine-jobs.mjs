#!/usr/bin/env node
/**
 * Dedicated Clinique de la Plaine crawler runner.
 *
 * Uses the standard crawler template with the Clinique de la Plaine parser.
 * All fetch/parse logic lives in ./lib/clinique-de-la-plaine-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCliniqueDeLaPlaineJobs,
  isCliniqueDeLaPlaineJob,
  isTrustedDomain,
  CLINIQUE_DE_LA_PLAINE_KEY,
  CLINIQUE_DE_LA_PLAINE_COMPANY_NAME,
} from './lib/clinique-de-la-plaine-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINIQUE_DE_LA_PLAINE_KEY,
  companyLabel: CLINIQUE_DE_LA_PLAINE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCliniqueDeLaPlaineJobs,
  isCompanyJob: isCliniqueDeLaPlaineJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Clinique de la Plaine crawler failed: ${err?.message || err}`);
  process.exit(1);
});
