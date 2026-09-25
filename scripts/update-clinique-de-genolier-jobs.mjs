#!/usr/bin/env node
/**
 * Dedicated Clinique de Genolier crawler runner.
 *
 * Uses the standard crawler template with the Clinique de Genolier parser.
 * All fetch/parse logic lives in ./lib/clinique-de-genolier-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCliniqueDeGenolierJobs,
  isCliniqueDeGenolierJob,
  isTrustedDomain,
  CLINIQUE_DE_GENOLIER_KEY,
  CLINIQUE_DE_GENOLIER_COMPANY_NAME,
} from './lib/clinique-de-genolier-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINIQUE_DE_GENOLIER_KEY,
  companyLabel: CLINIQUE_DE_GENOLIER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCliniqueDeGenolierJobs,
  isCompanyJob: isCliniqueDeGenolierJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Clinique de Genolier crawler failed: ${err?.message || err}`);
  process.exit(1);
});
