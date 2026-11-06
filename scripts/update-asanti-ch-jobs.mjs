#!/usr/bin/env node
/**
 * Dedicated Asanti AG crawler runner.
 *
 * Uses the standard crawler template with the Asanti AG parser.
 * All fetch/parse logic lives in ./lib/asanti-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAsantiChJobs,
  isAsantiChJob,
  isTrustedDomain,
  ASANTI_CH_KEY,
  ASANTI_CH_COMPANY_NAME,
} from './lib/asanti-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ASANTI_CH_KEY,
  companyLabel: ASANTI_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAsantiChJobs,
  isCompanyJob: isAsantiChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Asanti AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
