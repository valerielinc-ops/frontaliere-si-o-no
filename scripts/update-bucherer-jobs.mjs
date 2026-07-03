#!/usr/bin/env node
/**
 * Dedicated Bucherer crawler runner.
 *
 * Uses the standard crawler template with the Bucherer parser.
 * All fetch/parse logic lives in ./lib/bucherer-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBuchererJobs,
  isBuchererJob,
  isTrustedDomain,
  BUCHERER_KEY,
  BUCHERER_COMPANY_NAME,
} from './lib/bucherer-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BUCHERER_KEY,
  companyLabel: BUCHERER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBuchererJobs,
  isCompanyJob: isBuchererJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bucherer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
