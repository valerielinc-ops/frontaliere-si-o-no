#!/usr/bin/env node
/**
 * Dedicated Thermo Fisher Scientific (Schweiz) AG crawler runner.
 *
 * Uses the standard crawler template with the Thermo Fisher Scientific (Schweiz) AG parser.
 * All fetch/parse logic lives in ./lib/thermo-fisher-scientific-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllThermoFisherScientificJobs,
  isThermoFisherScientificJob,
  isTrustedDomain,
  THERMO_FISHER_SCIENTIFIC_KEY,
  THERMO_FISHER_SCIENTIFIC_COMPANY_NAME,
} from './lib/thermo-fisher-scientific-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: THERMO_FISHER_SCIENTIFIC_KEY,
  companyLabel: THERMO_FISHER_SCIENTIFIC_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllThermoFisherScientificJobs,
  isCompanyJob: isThermoFisherScientificJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Thermo Fisher Scientific (Schweiz) AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
