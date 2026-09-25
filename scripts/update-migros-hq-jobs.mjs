#!/usr/bin/env node
/**
 * Dedicated national crawler runner for the Migros-Genossenschafts-Bund legal entity (HQ Zürich).
 *
 * Uses the standard crawler template with the national Migros-Genossenschafts-Bund parser.
 * All fetch/parse logic lives in ./lib/migros-hq-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMigrosHqJobs,
  isMigrosHqJob,
  isTrustedDomain,
  MIGROS_HQ_KEY,
  MIGROS_HQ_COMPANY_NAME,
} from './lib/migros-hq-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MIGROS_HQ_KEY,
  companyLabel: MIGROS_HQ_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMigrosHqJobs,
  isCompanyJob: isMigrosHqJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Migros HQ Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
