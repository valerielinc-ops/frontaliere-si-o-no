#!/usr/bin/env node
/**
 * Dedicated Etat de Fribourg (Canton of Fribourg) crawler runner.
 *
 * Uses the standard crawler template with the Etat de Fribourg parser.
 * All fetch/parse logic lives in ./lib/etat-de-fribourg-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEtatDeFribourgJobs,
  isEtatDeFribourgJob,
  isTrustedDomain,
  ETAT_DE_FRIBOURG_KEY,
  ETAT_DE_FRIBOURG_COMPANY_NAME,
} from './lib/etat-de-fribourg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ETAT_DE_FRIBOURG_KEY,
  companyLabel: ETAT_DE_FRIBOURG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEtatDeFribourgJobs,
  isCompanyJob: isEtatDeFribourgJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Etat de Fribourg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
