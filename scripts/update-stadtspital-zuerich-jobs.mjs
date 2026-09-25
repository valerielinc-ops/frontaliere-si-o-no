#!/usr/bin/env node
/**
 * Dedicated Stadtspital Zürich crawler runner.
 *
 * Uses the standard crawler template with the Stadtspital Zürich parser.
 * All fetch/parse logic lives in ./lib/stadtspital-zuerich-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStadtspitalZuerichJobs,
  isStadtspitalZuerichJob,
  isTrustedDomain,
  STADTSPITAL_ZUERICH_KEY,
  STADTSPITAL_ZUERICH_COMPANY_NAME,
} from './lib/stadtspital-zuerich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STADTSPITAL_ZUERICH_KEY,
  companyLabel: STADTSPITAL_ZUERICH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStadtspitalZuerichJobs,
  isCompanyJob: isStadtspitalZuerichJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stadtspital Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
