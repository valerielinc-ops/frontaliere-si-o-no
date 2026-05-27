#!/usr/bin/env node
/**
 * Dedicated Banque Cantonale du Valais crawler runner.
 *
 * Uses the standard crawler template with the Banque Cantonale du Valais parser.
 * All fetch/parse logic lives in ./lib/bcvs-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBcvsJobs,
  isBcvsJob,
  isTrustedDomain,
  BCVS_KEY,
  BCVS_COMPANY_NAME,
} from './lib/bcvs-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BCVS_KEY,
  companyLabel: BCVS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBcvsJobs,
  isCompanyJob: isBcvsJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Banque Cantonale du Valais crawler failed: ${err?.message || err}`);
  process.exit(1);
});
