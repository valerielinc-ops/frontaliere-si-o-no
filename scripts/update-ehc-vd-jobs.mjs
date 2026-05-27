#!/usr/bin/env node
/**
 * Dedicated EHC (Ensemble hospitalier de la Côte) crawler runner.
 *
 * Uses the standard crawler template with the EHC parser.
 * All fetch/parse logic lives in ./lib/ehc-vd-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEhcVdJobs,
  isEhcVdJob,
  isTrustedDomain,
  EHC_VD_KEY,
  EHC_VD_COMPANY_NAME,
} from './lib/ehc-vd-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EHC_VD_KEY,
  companyLabel: EHC_VD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEhcVdJobs,
  isCompanyJob: isEhcVdJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ EHC crawler failed: ${err?.message || err}`);
  process.exit(1);
});
