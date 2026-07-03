#!/usr/bin/env node
/**
 * Dedicated Molecular Partners crawler runner.
 *
 * Uses the standard crawler template with the Molecular Partners parser.
 * All fetch/parse logic lives in ./lib/molecular-partners-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMolecularPartnersJobs,
  isMolecularPartnersJob,
  isTrustedDomain,
  MOLECULAR_PARTNERS_KEY,
  MOLECULAR_PARTNERS_COMPANY_NAME,
} from './lib/molecular-partners-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MOLECULAR_PARTNERS_KEY,
  companyLabel: MOLECULAR_PARTNERS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMolecularPartnersJobs,
  isCompanyJob: isMolecularPartnersJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Molecular Partners crawler failed: ${err?.message || err}`);
  process.exit(1);
});
