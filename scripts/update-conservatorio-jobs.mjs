#!/usr/bin/env node
/**
 * Dedicated Conservatorio della Svizzera italiana crawler runner.
 *
 * Uses the standard crawler template with the Conservatorio della Svizzera italiana parser.
 * All fetch/parse logic lives in ./lib/conservatorio-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllConservatorioJobs,
  isConservatorioJob,
  isTrustedDomain,
  CONSERVATORIO_KEY,
  CONSERVATORIO_COMPANY_NAME,
} from './lib/conservatorio-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CONSERVATORIO_KEY,
  companyLabel: CONSERVATORIO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllConservatorioJobs,
  isCompanyJob: isConservatorioJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Conservatorio della Svizzera italiana crawler failed: ${err?.message || err}`);
  process.exit(1);
});
