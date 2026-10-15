#!/usr/bin/env node
/**
 * Dedicated Amstein + Walthert AG crawler runner.
 *
 * Uses the standard crawler template with the Amstein + Walthert AG parser.
 * All fetch/parse logic lives in ./lib/amstein-walthert-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAmsteinWalthertJobs,
  isAmsteinWalthertJob,
  isTrustedDomain,
  AMSTEIN_WALTHERT_KEY,
  AMSTEIN_WALTHERT_COMPANY_NAME,
} from './lib/amstein-walthert-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AMSTEIN_WALTHERT_KEY,
  companyLabel: AMSTEIN_WALTHERT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAmsteinWalthertJobs,
  isCompanyJob: isAmsteinWalthertJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Amstein + Walthert AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
