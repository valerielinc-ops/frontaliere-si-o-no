#!/usr/bin/env node
/**
 * Dedicated Belimo crawler runner.
 *
 * Uses the standard crawler template with the Belimo parser.
 * All fetch/parse logic lives in ./lib/belimo-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBelimoJobs,
  isBelimoJob,
  isTrustedDomain,
  BELIMO_KEY,
  BELIMO_COMPANY_NAME,
} from './lib/belimo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BELIMO_KEY,
  companyLabel: BELIMO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBelimoJobs,
  isCompanyJob: isBelimoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Belimo crawler failed: ${err?.message || err}`);
  process.exit(1);
});
