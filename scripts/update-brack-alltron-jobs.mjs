#!/usr/bin/env node
/**
 * Dedicated Brack.Alltron AG crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBrackAlltronJobs,
  isBrackAlltronJob,
  isTrustedDomain,
  BRACK_ALLTRON_KEY,
  BRACK_ALLTRON_COMPANY_NAME,
} from './lib/brack-alltron-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BRACK_ALLTRON_KEY,
  companyLabel: BRACK_ALLTRON_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBrackAlltronJobs,
  isCompanyJob: isBrackAlltronJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Brack.Alltron crawler failed: ${err?.message || err}`);
  process.exit(1);
});
