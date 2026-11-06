#!/usr/bin/env node
/**
 * Dedicated Groupe E crawler runner.
 *
 * Uses the standard crawler template with the Groupe E parser.
 * All fetch/parse logic lives in ./lib/groupe-e-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGroupeEJobs,
  isGroupeEJob,
  isTrustedDomain,
  GROUPE_E_KEY,
  GROUPE_E_COMPANY_NAME,
} from './lib/groupe-e-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GROUPE_E_KEY,
  companyLabel: GROUPE_E_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGroupeEJobs,
  isCompanyJob: isGroupeEJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Groupe E crawler failed: ${err?.message || err}`);
  process.exit(1);
});
