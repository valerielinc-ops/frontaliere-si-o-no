#!/usr/bin/env node
/**
 * Dedicated Opacc Software AG crawler runner.
 *
 * Uses the standard crawler template with the Opacc Software AG parser.
 * All fetch/parse logic lives in ./lib/opacc-software-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOpaccSoftwareAgJobs,
  isOpaccSoftwareAgJob,
  isTrustedDomain,
  OPACC_SOFTWARE_AG_KEY,
  OPACC_SOFTWARE_AG_COMPANY_NAME,
} from './lib/opacc-software-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OPACC_SOFTWARE_AG_KEY,
  companyLabel: OPACC_SOFTWARE_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOpaccSoftwareAgJobs,
  isCompanyJob: isOpaccSoftwareAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Opacc Software AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
