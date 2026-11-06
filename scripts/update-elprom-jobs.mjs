#!/usr/bin/env node
/**
 * Dedicated elprom crawler runner.
 *
 * Uses the standard crawler template with the elprom parser.
 * All fetch/parse logic lives in ./lib/elprom-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllElpromJobs,
  isElpromJob,
  isTrustedDomain,
  ELPROM_KEY,
  ELPROM_COMPANY_NAME,
} from './lib/elprom-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ELPROM_KEY,
  companyLabel: ELPROM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllElpromJobs,
  isCompanyJob: isElpromJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ elprom crawler failed: ${err?.message || err}`);
  process.exit(1);
});
