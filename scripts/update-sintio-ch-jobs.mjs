#!/usr/bin/env node
/**
 * Dedicated Sintio crawler runner.
 *
 * Uses the standard crawler template with the Sintio parser.
 * All fetch/parse logic lives in ./lib/sintio-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSintioChJobs,
  isSintioChJob,
  isTrustedDomain,
  SINTIO_CH_KEY,
  SINTIO_CH_COMPANY_NAME,
} from './lib/sintio-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SINTIO_CH_KEY,
  companyLabel: SINTIO_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSintioChJobs,
  isCompanyJob: isSintioChJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Sintio crawler failed: ${err?.message || err}`);
  process.exit(1);
});
