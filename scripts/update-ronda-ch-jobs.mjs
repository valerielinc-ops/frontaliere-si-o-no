#!/usr/bin/env node
/**
 * Dedicated Ronda AG crawler runner.
 *
 * Uses the standard crawler template with the Ronda AG parser.
 * All fetch/parse logic lives in ./lib/ronda-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRondaChJobs,
  isRondaChJob,
  isTrustedDomain,
  RONDA_CH_KEY,
  RONDA_CH_COMPANY_NAME,
} from './lib/ronda-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RONDA_CH_KEY,
  companyLabel: RONDA_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRondaChJobs,
  isCompanyJob: isRondaChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Ronda AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
