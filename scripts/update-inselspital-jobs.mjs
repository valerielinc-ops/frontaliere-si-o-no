#!/usr/bin/env node
/**
 * Dedicated Inselspital Bern crawler runner.
 *
 * Uses the standard crawler template with the Inselspital parser.
 * All fetch/parse logic lives in ./lib/inselspital-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllInselspitalJobs,
  isInselspitalJob,
  isTrustedDomain,
  INSELSPITAL_KEY,
  INSELSPITAL_COMPANY_NAME,
} from './lib/inselspital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: INSELSPITAL_KEY,
  companyLabel: INSELSPITAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllInselspitalJobs,
  isCompanyJob: isInselspitalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Inselspital Bern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
