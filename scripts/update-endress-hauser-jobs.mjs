#!/usr/bin/env node
/**
 * Dedicated Endress+Hauser crawler runner.
 *
 * Uses the standard crawler template with the Endress+Hauser parser.
 * All fetch/parse logic lives in ./lib/endress-hauser-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEndressHauserJobs,
  isEndressHauserJob,
  isTrustedDomain,
  ENDRESS_HAUSER_KEY,
  ENDRESS_HAUSER_COMPANY_NAME,
} from './lib/endress-hauser-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ENDRESS_HAUSER_KEY,
  companyLabel: ENDRESS_HAUSER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEndressHauserJobs,
  isCompanyJob: isEndressHauserJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Endress+Hauser crawler failed: ${err?.message || err}`);
  process.exit(1);
});
