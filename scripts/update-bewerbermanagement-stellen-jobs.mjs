#!/usr/bin/env node
/**
 * Dedicated Bewerbermanagement Stellen crawler runner.
 *
 * Uses the standard crawler template with the Bewerbermanagement Stellen parser.
 * All fetch/parse logic lives in ./lib/bewerbermanagement-stellen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBewerbermanagementStellenJobs,
  isBewerbermanagementStellenJob,
  isTrustedDomain,
  BEWERBERMANAGEMENT_STELLEN_KEY,
  BEWERBERMANAGEMENT_STELLEN_COMPANY_NAME,
} from './lib/bewerbermanagement-stellen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BEWERBERMANAGEMENT_STELLEN_KEY,
  companyLabel: BEWERBERMANAGEMENT_STELLEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBewerbermanagementStellenJobs,
  isCompanyJob: isBewerbermanagementStellenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bewerbermanagement Stellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
