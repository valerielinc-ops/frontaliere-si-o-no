#!/usr/bin/env node
/**
 * Dedicated Stiftung Ilgenhalde crawler runner.
 *
 * Uses the standard crawler template with the Stiftung Ilgenhalde parser.
 * All fetch/parse logic lives in ./lib/stiftung-ilgenhalde-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStiftungIlgenhaldeJobs,
  isStiftungIlgenhaldeJob,
  isTrustedDomain,
  STIFTUNG_ILGENHALDE_KEY,
  STIFTUNG_ILGENHALDE_COMPANY_NAME,
} from './lib/stiftung-ilgenhalde-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STIFTUNG_ILGENHALDE_KEY,
  companyLabel: STIFTUNG_ILGENHALDE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStiftungIlgenhaldeJobs,
  isCompanyJob: isStiftungIlgenhaldeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stiftung Ilgenhalde crawler failed: ${err?.message || err}`);
  process.exit(1);
});
