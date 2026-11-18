#!/usr/bin/env node
/**
 * Dedicated HP Job GmbH crawler runner.
 *
 * Uses the standard crawler template with the HP Job GmbH parser.
 * All fetch/parse logic lives in ./lib/hpjob-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHpjobChJobs,
  isHpjobChJob,
  isTrustedDomain,
  HPJOB_CH_KEY,
  HPJOB_CH_COMPANY_NAME,
} from './lib/hpjob-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HPJOB_CH_KEY,
  companyLabel: HPJOB_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHpjobChJobs,
  isCompanyJob: isHpjobChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ HP Job GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
