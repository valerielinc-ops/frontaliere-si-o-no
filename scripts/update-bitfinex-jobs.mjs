#!/usr/bin/env node
/**
 * Dedicated Bitfinex crawler runner.
 *
 * Uses the standard crawler template with the Bitfinex parser.
 * All fetch/parse logic lives in ./lib/bitfinex-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline, SNAPSHOT_VALIDATED_PARTIAL } from './lib/crawler-template.mjs';
import { createRecruiteeCountryRefreshHooks } from './lib/recruitee-country-guard.mjs';
import {
  fetchAllBitfinexJobs,
  isBitfinexJob,
  isTrustedDomain,
  BITFINEX_KEY,
  BITFINEX_COMPANY_NAME,
} from './lib/bitfinex-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const countryRefreshHooks = createRecruiteeCountryRefreshHooks(
  fetchAllBitfinexJobs,
  BITFINEX_KEY,
  SNAPSHOT_VALIDATED_PARTIAL,
);

runStandardCrawlerPipeline({
  companyKey: BITFINEX_KEY,
  companyLabel: BITFINEX_COMPANY_NAME,
  root: ROOT,
  fetchJobs: countryRefreshHooks.fetchJobs,
  prepareExistingJobs: countryRefreshHooks.prepareExistingJobs,
  validateAuthoritativeSnapshot: countryRefreshHooks.validateAuthoritativeSnapshot,
  isCompanyJob: isBitfinexJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Bitfinex crawler failed: ${err?.message || err}`);
  process.exit(1);
});
