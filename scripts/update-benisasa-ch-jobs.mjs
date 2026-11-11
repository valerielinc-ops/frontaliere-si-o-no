#!/usr/bin/env node
/**
 * Dedicated Benisa SA crawler runner.
 *
 * Uses the standard crawler template with the Benisa SA parser.
 * All fetch/parse logic lives in ./lib/benisasa-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBenisasaChJobs,
  isBenisasaChJob,
  isTrustedDomain,
  BENISASA_CH_KEY,
  BENISASA_CH_COMPANY_NAME,
} from './lib/benisasa-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BENISASA_CH_KEY,
  companyLabel: BENISASA_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBenisasaChJobs,
  isCompanyJob: isBenisasaChJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Benisa SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
