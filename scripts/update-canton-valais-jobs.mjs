#!/usr/bin/env node
/**
 * Dedicated Canton du Valais crawler runner.
 *
 * Uses the standard crawler template with the Canton du Valais parser.
 * All fetch/parse logic lives in ./lib/canton-valais-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCantonValaisJobs,
  isCantonValaisJob,
  isTrustedDomain,
  CANTON_VALAIS_KEY,
  CANTON_VALAIS_COMPANY_NAME,
} from './lib/canton-valais-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CANTON_VALAIS_KEY,
  companyLabel: CANTON_VALAIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCantonValaisJobs,
  isCompanyJob: isCantonValaisJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Canton du Valais crawler failed: ${err?.message || err}`);
  process.exit(1);
});
