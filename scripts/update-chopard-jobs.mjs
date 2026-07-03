#!/usr/bin/env node
/**
 * Dedicated Chopard crawler runner.
 *
 * Uses the standard crawler template with the Chopard parser.
 * All fetch/parse logic lives in ./lib/chopard-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllChopardJobs,
  isChopardJob,
  isTrustedDomain,
  CHOPARD_KEY,
  CHOPARD_COMPANY_NAME,
} from './lib/chopard-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CHOPARD_KEY,
  companyLabel: CHOPARD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllChopardJobs,
  isCompanyJob: isChopardJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Chopard crawler failed: ${err?.message || err}`);
  process.exit(1);
});
