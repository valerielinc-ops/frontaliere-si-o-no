#!/usr/bin/env node
/**
 * Dedicated État de Vaud (Administration cantonale vaudoise) crawler runner.
 *
 * Uses the standard crawler template with the État de Vaud parser.
 * All fetch/parse logic lives in ./lib/etat-de-vaud-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEtatDeVaudJobs,
  isEtatDeVaudJob,
  isTrustedDomain,
  ETAT_DE_VAUD_KEY,
  ETAT_DE_VAUD_COMPANY_NAME,
} from './lib/etat-de-vaud-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ETAT_DE_VAUD_KEY,
  companyLabel: ETAT_DE_VAUD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEtatDeVaudJobs,
  isCompanyJob: isEtatDeVaudJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ État de Vaud crawler failed: ${err?.message || err}`);
  process.exit(1);
});
