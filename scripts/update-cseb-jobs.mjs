#!/usr/bin/env node
/**
 * Dedicated Center da Sanadad Engiadina Bassa crawler runner.
 *
 * Uses the standard crawler template with the Center da Sanadad Engiadina Bassa parser.
 * All fetch/parse logic lives in ./lib/cseb-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCsebJobs,
  isCsebJob,
  isTrustedDomain,
  CSEB_KEY,
  CSEB_COMPANY_NAME,
} from './lib/cseb-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CSEB_KEY,
  companyLabel: CSEB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCsebJobs,
  isCompanyJob: isCsebJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Center da Sanadad Engiadina Bassa crawler failed: ${err?.message || err}`);
  process.exit(1);
});
