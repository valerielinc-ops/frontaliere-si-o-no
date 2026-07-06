#!/usr/bin/env node
/**
 * Dedicated DIC SA crawler runner.
 *
 * Uses the standard crawler template with the DIC SA parser.
 * All fetch/parse logic lives in ./lib/dic-sa-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDicSaJobs,
  isDicSaJob,
  isTrustedDomain,
  DIC_SA_KEY,
  DIC_SA_COMPANY_NAME,
} from './lib/dic-sa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DIC_SA_KEY,
  companyLabel: DIC_SA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDicSaJobs,
  isCompanyJob: isDicSaJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ DIC SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
