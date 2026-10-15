#!/usr/bin/env node
/**
 * Dedicated Clinique de Montchoisi crawler runner.
 *
 * Uses the standard crawler template with the Clinique de Montchoisi parser.
 * All fetch/parse logic lives in ./lib/clinique-de-montchoisi-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCliniqueDeMontchoisiJobs,
  isCliniqueDeMontchoisiJob,
  isTrustedDomain,
  CLINIQUE_DE_MONTCHOISI_KEY,
  CLINIQUE_DE_MONTCHOISI_COMPANY_NAME,
} from './lib/clinique-de-montchoisi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINIQUE_DE_MONTCHOISI_KEY,
  companyLabel: CLINIQUE_DE_MONTCHOISI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCliniqueDeMontchoisiJobs,
  isCompanyJob: isCliniqueDeMontchoisiJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Clinique de Montchoisi crawler failed: ${err?.message || err}`);
  process.exit(1);
});
