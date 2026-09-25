#!/usr/bin/env node
/**
 * Dedicated Confiserie Sprüngli crawler runner.
 *
 * Uses the standard crawler template with the Sprüngli parser.
 * All fetch/parse logic lives in ./lib/spruengli-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpruengliJobs,
  isSpruengliJob,
  isTrustedDomain,
  SPRUENGLI_KEY,
  SPRUENGLI_COMPANY_NAME,
} from './lib/spruengli-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPRUENGLI_KEY,
  companyLabel: SPRUENGLI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpruengliJobs,
  isCompanyJob: isSpruengliJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Confiserie Sprüngli crawler failed: ${err?.message || err}`);
  process.exit(1);
});
