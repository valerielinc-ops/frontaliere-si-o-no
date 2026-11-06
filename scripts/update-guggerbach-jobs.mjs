#!/usr/bin/env node
/**
 * Dedicated Bistro Guggerzyt crawler runner.
 *
 * Uses the standard crawler template with the Bistro Guggerzyt parser.
 * All fetch/parse logic lives in ./lib/guggerbach-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGuggerbachJobs,
  isGuggerbachJob,
  isTrustedDomain,
  GUGGERBACH_KEY,
  GUGGERBACH_COMPANY_NAME,
} from './lib/guggerbach-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GUGGERBACH_KEY,
  companyLabel: GUGGERBACH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGuggerbachJobs,
  isCompanyJob: isGuggerbachJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bistro Guggerzyt crawler failed: ${err?.message || err}`);
  process.exit(1);
});
