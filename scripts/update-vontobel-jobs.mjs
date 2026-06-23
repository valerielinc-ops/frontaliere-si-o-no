#!/usr/bin/env node
/**
 * Dedicated Vontobel crawler runner.
 *
 * Uses the standard crawler template with the Vontobel parser.
 * All fetch/parse logic lives in ./lib/vontobel-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVontobelJobs,
  isVontobelJob,
  isTrustedDomain,
  VONTOBEL_KEY,
  VONTOBEL_COMPANY_NAME,
} from './lib/vontobel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VONTOBEL_KEY,
  companyLabel: VONTOBEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVontobelJobs,
  isCompanyJob: isVontobelJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Vontobel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
