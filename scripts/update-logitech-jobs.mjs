#!/usr/bin/env node
/**
 * Dedicated Logitech crawler runner.
 *
 * Uses the standard crawler template with the Logitech parser.
 * All fetch/parse logic lives in ./lib/logitech-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLogitechJobs,
  isLogitechJob,
  isTrustedDomain,
  LOGITECH_KEY,
  LOGITECH_COMPANY_NAME,
} from './lib/logitech-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LOGITECH_KEY,
  companyLabel: LOGITECH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLogitechJobs,
  isCompanyJob: isLogitechJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Logitech crawler failed: ${err?.message || err}`);
  process.exit(1);
});
