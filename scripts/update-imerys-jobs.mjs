#!/usr/bin/env node
/**
 * Dedicated Imerys crawler runner.
 *
 * Uses the standard crawler template with the Imerys parser.
 * All fetch/parse logic lives in ./lib/imerys-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllImerysJobs,
  isImerysJob,
  isTrustedDomain,
  IMERYS_KEY,
  IMERYS_COMPANY_NAME,
} from './lib/imerys-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IMERYS_KEY,
  companyLabel: IMERYS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllImerysJobs,
  isCompanyJob: isImerysJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Imerys crawler failed: ${err?.message || err}`);
  process.exit(1);
});
