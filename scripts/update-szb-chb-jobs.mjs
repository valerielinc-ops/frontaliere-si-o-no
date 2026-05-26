#!/usr/bin/env node
/**
 * Dedicated Spitalzentrum Biel / Centre hospitalier Bienne crawler runner.
 *
 * Uses the standard crawler template with the Spitalzentrum Biel / Centre hospitalier Bienne parser.
 * All fetch/parse logic lives in ./lib/szb-chb-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSzbChbJobs,
  isSzbChbJob,
  isTrustedDomain,
  SZB_CHB_KEY,
  SZB_CHB_COMPANY_NAME,
} from './lib/szb-chb-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SZB_CHB_KEY,
  companyLabel: SZB_CHB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSzbChbJobs,
  isCompanyJob: isSzbChbJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spitalzentrum Biel / Centre hospitalier Bienne crawler failed: ${err?.message || err}`);
  process.exit(1);
});
