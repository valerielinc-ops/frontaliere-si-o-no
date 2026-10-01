#!/usr/bin/env node
/**
 * Dedicated Pantr GmbH crawler runner.
 *
 * Uses the standard crawler template with the Pantr GmbH parser.
 * All fetch/parse logic lives in ./lib/pantr-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPantrChJobs,
  isPantrChJob,
  isTrustedDomain,
  PANTR_CH_KEY,
  PANTR_CH_COMPANY_NAME,
} from './lib/pantr-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PANTR_CH_KEY,
  companyLabel: PANTR_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPantrChJobs,
  isCompanyJob: isPantrChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Pantr GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
