#!/usr/bin/env node
/**
 * Dedicated mpa-praxisstellen crawler runner.
 *
 * Uses the standard crawler template with the mpa-praxisstellen parser.
 * All fetch/parse logic lives in ./lib/mpa-praxisstellen-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMpaPraxisstellenChJobs,
  isMpaPraxisstellenChJob,
  isTrustedDomain,
  MPA_PRAXISSTELLEN_CH_KEY,
  MPA_PRAXISSTELLEN_CH_COMPANY_NAME,
} from './lib/mpa-praxisstellen-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MPA_PRAXISSTELLEN_CH_KEY,
  companyLabel: MPA_PRAXISSTELLEN_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMpaPraxisstellenChJobs,
  isCompanyJob: isMpaPraxisstellenChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ mpa-praxisstellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
