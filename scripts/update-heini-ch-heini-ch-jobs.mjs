#!/usr/bin/env node
/**
 * Dedicated Heini Conditorei AG crawler runner.
 *
 * Uses the standard crawler template with the Heini Conditorei AG parser.
 * All fetch/parse logic lives in ./lib/heini-ch-heini-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHeiniChHeiniChJobs,
  isHeiniChHeiniChJob,
  isTrustedDomain,
  HEINI_CH_HEINI_CH_KEY,
  HEINI_CH_HEINI_CH_COMPANY_NAME,
} from './lib/heini-ch-heini-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HEINI_CH_HEINI_CH_KEY,
  companyLabel: HEINI_CH_HEINI_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHeiniChHeiniChJobs,
  isCompanyJob: isHeiniChHeiniChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Heini Conditorei AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
