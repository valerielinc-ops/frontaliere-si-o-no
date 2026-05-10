#!/usr/bin/env node
/**
 * Dedicated Novartis crawler runner.
 *
 * Uses the standard crawler template with the Novartis parser.
 * All fetch/parse logic lives in ./lib/novartis-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNovartisJobs,
  isNovartisJob,
  isTrustedDomain,
  NOVARTIS_KEY,
  NOVARTIS_COMPANY_NAME,
} from './lib/novartis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NOVARTIS_KEY,
  companyLabel: NOVARTIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNovartisJobs,
  isCompanyJob: isNovartisJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Novartis crawler failed: ${err?.message || err}`);
  process.exit(1);
});
