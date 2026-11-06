#!/usr/bin/env node
/**
 * Dedicated Suchtfachstelle Zürich crawler runner.
 *
 * Uses the standard crawler template with the Suchtfachstelle Zürich parser.
 * All fetch/parse logic lives in ./lib/suchtfachstelle-zuerich-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSuchtfachstelleZuerichJobs,
  isSuchtfachstelleZuerichJob,
  isTrustedDomain,
  SUCHTFACHSTELLE_ZUERICH_KEY,
  SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME,
} from './lib/suchtfachstelle-zuerich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SUCHTFACHSTELLE_ZUERICH_KEY,
  companyLabel: SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSuchtfachstelleZuerichJobs,
  isCompanyJob: isSuchtfachstelleZuerichJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Suchtfachstelle Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
