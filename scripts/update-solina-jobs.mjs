#!/usr/bin/env node
/**
 * Dedicated Stiftung Solina crawler runner.
 *
 * Uses the standard crawler template with the Solina parser.
 * All fetch/parse logic lives in ./lib/solina-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSolinaJobs,
  isSolinaJob,
  isTrustedDomain,
  SOLINA_KEY,
  SOLINA_COMPANY_NAME,
} from './lib/solina-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SOLINA_KEY,
  companyLabel: SOLINA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSolinaJobs,
  isCompanyJob: isSolinaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Solina crawler failed: ${err?.message || err}`);
  process.exit(1);
});
