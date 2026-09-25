#!/usr/bin/env node
/**
 * Dedicated Stiftung Wagerenhof crawler runner.
 *
 * Uses the standard crawler template with the Wagerenhof parser.
 * All fetch/parse logic lives in ./lib/wagerenhof-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllWagerenhofJobs,
  isWagerenhofJob,
  isTrustedDomain,
  WAGERENHOF_KEY,
  WAGERENHOF_COMPANY_NAME,
} from './lib/wagerenhof-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: WAGERENHOF_KEY,
  companyLabel: WAGERENHOF_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllWagerenhofJobs,
  isCompanyJob: isWagerenhofJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Wagerenhof crawler failed: ${err?.message || err}`);
  process.exit(1);
});
