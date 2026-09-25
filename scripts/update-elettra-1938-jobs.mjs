#!/usr/bin/env node
/**
 * Dedicated Elettra 1938 crawler runner.
 *
 * Uses the standard crawler template with the Elettra 1938 parser.
 * All fetch/parse logic lives in ./lib/elettra-1938-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllElettra1938Jobs,
  isElettra1938Job,
  isTrustedDomain,
  ELETTRA_1938_KEY,
  ELETTRA_1938_COMPANY_NAME,
} from './lib/elettra-1938-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ELETTRA_1938_KEY,
  companyLabel: ELETTRA_1938_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllElettra1938Jobs,
  isCompanyJob: isElettra1938Job,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Elettra 1938 crawler failed: ${err?.message || err}`);
  process.exit(1);
});
