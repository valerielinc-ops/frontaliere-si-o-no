#!/usr/bin/env node
/**
 * Dedicated Sobi (Swedish Orphan Biovitrum) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSobiJobs,
  isSobiJob,
  isTrustedDomain,
  SOBI_KEY,
  SOBI_COMPANY_NAME,
} from './lib/sobi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SOBI_KEY,
  companyLabel: SOBI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSobiJobs,
  isCompanyJob: isSobiJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Sobi crawler failed: ${err?.message || err}`);
  process.exit(1);
});
