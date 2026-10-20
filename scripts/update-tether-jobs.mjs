#!/usr/bin/env node
/**
 * Dedicated Tether Operations crawler runner.
 *
 * Uses the standard crawler template with the Tether Operations parser.
 * All fetch/parse logic lives in ./lib/tether-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline, SNAPSHOT_VALIDATED_PARTIAL } from './lib/crawler-template.mjs';
import { createRecruiteeCountryRefreshHooks } from './lib/recruitee-country-guard.mjs';
import {
  fetchAllTetherJobs,
  isTetherJob,
  isTrustedDomain,
  TETHER_KEY,
  TETHER_COMPANY_NAME,
} from './lib/tether-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const countryRefreshHooks = createRecruiteeCountryRefreshHooks(
  fetchAllTetherJobs,
  TETHER_KEY,
  SNAPSHOT_VALIDATED_PARTIAL,
);

runStandardCrawlerPipeline({
  companyKey: TETHER_KEY,
  companyLabel: TETHER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: countryRefreshHooks.fetchJobs,
  prepareExistingJobs: countryRefreshHooks.prepareExistingJobs,
  validateAuthoritativeSnapshot: countryRefreshHooks.validateAuthoritativeSnapshot,
  isCompanyJob: isTetherJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Tether Operations crawler failed: ${err?.message || err}`);
  process.exit(1);
});
