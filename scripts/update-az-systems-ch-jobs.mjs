#!/usr/bin/env node
/**
 * Dedicated AZ systems AG crawler runner.
 *
 * Uses the standard crawler template with the AZ systems AG parser.
 * All fetch/parse logic lives in ./lib/az-systems-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAzSystemsChJobs,
  isAzSystemsChJob,
  isTrustedDomain,
  AZ_SYSTEMS_CH_KEY,
  AZ_SYSTEMS_CH_COMPANY_NAME,
} from './lib/az-systems-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AZ_SYSTEMS_CH_KEY,
  companyLabel: AZ_SYSTEMS_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAzSystemsChJobs,
  isCompanyJob: isAzSystemsChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ AZ systems AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
