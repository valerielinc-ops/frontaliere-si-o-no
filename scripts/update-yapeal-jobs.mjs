#!/usr/bin/env node
/**
 * Dedicated Yapeal crawler runner.
 *
 * Uses the standard crawler template with the Yapeal parser.
 * All fetch/parse logic lives in ./lib/yapeal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllYapealJobs,
  isYapealJob,
  isTrustedDomain,
  YAPEAL_KEY,
  YAPEAL_COMPANY_NAME,
} from './lib/yapeal-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: YAPEAL_KEY,
  companyLabel: YAPEAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllYapealJobs,
  isCompanyJob: isYapealJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Yapeal crawler failed: ${err?.message || err}`);
  process.exit(1);
});
