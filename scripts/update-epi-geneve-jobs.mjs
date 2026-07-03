#!/usr/bin/env node
/**
 * Dedicated EPI Genève crawler runner.
 *
 * Uses the standard crawler template with the EPI Genève parser.
 * All fetch/parse logic lives in ./lib/epi-geneve-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEpiGeneveJobs,
  isEpiGeneveJob,
  isTrustedDomain,
  EPI_GENEVE_KEY,
  EPI_GENEVE_COMPANY_NAME,
} from './lib/epi-geneve-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EPI_GENEVE_KEY,
  companyLabel: EPI_GENEVE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEpiGeneveJobs,
  isCompanyJob: isEpiGeneveJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ EPI Genève crawler failed: ${err?.message || err}`);
  process.exit(1);
});
