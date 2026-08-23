#!/usr/bin/env node
/**
 * Dedicated Bewerbungsmanagement Spital Davos crawler runner.
 *
 * Uses the standard crawler template with the Bewerbungsmanagement Spital Davos parser.
 * All fetch/parse logic lives in ./lib/bewerbungsmanagement-spital-davos-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBewerbungsmanagementSpitalDavosJobs,
  isBewerbungsmanagementSpitalDavosJob,
  isTrustedDomain,
  BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_KEY,
  BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_COMPANY_NAME,
} from './lib/bewerbungsmanagement-spital-davos-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_KEY,
  companyLabel: BEWERBUNGSMANAGEMENT_SPITAL_DAVOS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBewerbungsmanagementSpitalDavosJobs,
  isCompanyJob: isBewerbungsmanagementSpitalDavosJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bewerbungsmanagement Spital Davos crawler failed: ${err?.message || err}`);
  process.exit(1);
});
