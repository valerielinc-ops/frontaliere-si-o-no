#!/usr/bin/env node
/**
 * Dedicated Georg Fischer crawler runner.
 *
 * Uses the standard crawler template with the Georg Fischer parser.
 * All fetch/parse logic lives in ./lib/georg-fischer-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGeorgFischerJobs,
  isGeorgFischerJob,
  isTrustedDomain,
  GEORG_FISCHER_KEY,
  GEORG_FISCHER_COMPANY_NAME,
} from './lib/georg-fischer-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GEORG_FISCHER_KEY,
  companyLabel: GEORG_FISCHER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGeorgFischerJobs,
  isCompanyJob: isGeorgFischerJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Georg Fischer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
