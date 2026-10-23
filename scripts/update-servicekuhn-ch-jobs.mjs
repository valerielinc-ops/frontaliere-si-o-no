#!/usr/bin/env node
/**
 * Dedicated servicekuhn crawler runner.
 *
 * Uses the standard crawler template with the servicekuhn parser.
 * All fetch/parse logic lives in ./lib/servicekuhn-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllServicekuhnChJobs,
  isServicekuhnChJob,
  isTrustedDomain,
  SERVICEKUHN_CH_KEY,
  SERVICEKUHN_CH_COMPANY_NAME,
} from './lib/servicekuhn-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SERVICEKUHN_CH_KEY,
  companyLabel: SERVICEKUHN_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllServicekuhnChJobs,
  isCompanyJob: isServicekuhnChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ servicekuhn crawler failed: ${err?.message || err}`);
  process.exit(1);
});
