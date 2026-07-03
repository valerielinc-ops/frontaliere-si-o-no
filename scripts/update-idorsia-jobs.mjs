#!/usr/bin/env node
/**
 * Dedicated Idorsia Pharmaceuticals crawler runner.
 *
 * Uses the standard crawler template with the Idorsia Pharmaceuticals parser.
 * All fetch/parse logic lives in ./lib/idorsia-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllIdorsiaJobs,
  isIdorsiaJob,
  isTrustedDomain,
  IDORSIA_KEY,
  IDORSIA_COMPANY_NAME,
} from './lib/idorsia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IDORSIA_KEY,
  companyLabel: IDORSIA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIdorsiaJobs,
  isCompanyJob: isIdorsiaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Idorsia Pharmaceuticals crawler failed: ${err?.message || err}`);
  process.exit(1);
});
