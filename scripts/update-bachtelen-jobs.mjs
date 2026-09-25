#!/usr/bin/env node
/**
 * Dedicated Stiftung Bachtelen crawler runner.
 *
 * Uses the standard crawler template with the Bachtelen parser.
 * All fetch/parse logic lives in ./lib/bachtelen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBachtelenJobs,
  isBachtelenJob,
  isTrustedDomain,
  BACHTELEN_KEY,
  BACHTELEN_COMPANY_NAME,
} from './lib/bachtelen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BACHTELEN_KEY,
  companyLabel: BACHTELEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBachtelenJobs,
  isCompanyJob: isBachtelenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bachtelen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
