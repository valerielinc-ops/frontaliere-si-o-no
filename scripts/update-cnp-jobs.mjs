#!/usr/bin/env node
/**
 * Dedicated Centre Neuchâtelois de Psychiatrie (CNP) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCnpJobs,
  isCnpJob,
  isTrustedDomain,
  CNP_KEY,
  CNP_COMPANY_NAME,
} from './lib/cnp-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CNP_KEY,
  companyLabel: CNP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCnpJobs,
  isCompanyJob: isCnpJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ CNP crawler failed: ${err?.message || err}`);
  process.exit(1);
});
