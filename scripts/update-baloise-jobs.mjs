#!/usr/bin/env node
/**
 * Dedicated Baloise crawler runner.
 *
 * Uses the standard crawler template with the Baloise parser. All
 * fetch/parse logic lives in ./lib/baloise-job-parser.mjs (Prospective.ch
 * medium 1005736, shared with the Helvetia crawler — see that parser's
 * docblock for the split rationale).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBaloiseJobs,
  isBaloiseJob,
  isTrustedDomain,
  BALOISE_KEY,
  BALOISE_COMPANY_NAME,
} from './lib/baloise-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BALOISE_KEY,
  companyLabel: BALOISE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBaloiseJobs,
  isCompanyJob: isBaloiseJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Baloise crawler failed: ${err?.message || err}`);
  process.exit(1);
});
