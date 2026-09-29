#!/usr/bin/env node
/**
 * Dedicated Zermatt Bergbahnen crawler runner.
 *
 * Uses the standard crawler template with the Zermatt Bergbahnen parser.
 * All fetch/parse logic lives in ./lib/zermatt-bergbahnen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZermattBergbahnenJobs,
  isZermattBergbahnenJob,
  isTrustedDomain,
  ZERMATT_BERGBAHNEN_KEY,
  ZERMATT_BERGBAHNEN_COMPANY_NAME,
  ZERMATT_BERGBAHNEN_FABRICATED_DESCRIPTION_RE,
} from './lib/zermatt-bergbahnen-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ZERMATT_BERGBAHNEN_KEY,
  companyLabel: ZERMATT_BERGBAHNEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllZermattBergbahnenJobs,
  isCompanyJob: isZermattBergbahnenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, ZERMATT_BERGBAHNEN_FABRICATED_DESCRIPTION_RE, ZERMATT_BERGBAHNEN_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Zermatt Bergbahnen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
