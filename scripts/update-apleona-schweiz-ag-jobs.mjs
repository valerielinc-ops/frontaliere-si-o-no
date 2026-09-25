#!/usr/bin/env node
/**
 * Dedicated Apleona Schweiz AG crawler runner.
 *
 * Uses the standard crawler template with the Apleona Schweiz AG parser.
 * All fetch/parse logic lives in ./lib/apleona-schweiz-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllApleonaSchweizAgJobs,
  isApleonaSchweizAgJob,
  isTrustedDomain,
  APLEONA_SCHWEIZ_AG_KEY,
  APLEONA_SCHWEIZ_AG_COMPANY_NAME,
} from './lib/apleona-schweiz-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: APLEONA_SCHWEIZ_AG_KEY,
  companyLabel: APLEONA_SCHWEIZ_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllApleonaSchweizAgJobs,
  isCompanyJob: isApleonaSchweizAgJob,
  // Publish a zero only when the source itself proved it is empty (issue
  // #7458/#6660 class). An unproven zero keeps the previous slice, so a
  // broken crawler stays visibly unhealthy instead of being masked by an
  // `EMPTY_OK_CRAWLERS` entry.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(APLEONA_SCHWEIZ_AG_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'de',
  preserveExistingSlugs: true,
}).catch((err) => {
  console.error(`❌ Apleona Schweiz AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
