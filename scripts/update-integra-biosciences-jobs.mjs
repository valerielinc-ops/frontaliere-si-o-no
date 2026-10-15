#!/usr/bin/env node
/**
 * Dedicated INTEGRA Biosciences crawler runner.
 *
 * Uses the standard crawler template with the INTEGRA Biosciences parser.
 * All fetch/parse logic lives in ./lib/integra-biosciences-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllIntegraBiosciencesJobs,
  isIntegraBiosciencesJob,
  isTrustedDomain,
  INTEGRA_BIOSCIENCES_KEY,
  INTEGRA_BIOSCIENCES_COMPANY_NAME,
} from './lib/integra-biosciences-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: INTEGRA_BIOSCIENCES_KEY,
  companyLabel: INTEGRA_BIOSCIENCES_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIntegraBiosciencesJobs,
  isCompanyJob: isIntegraBiosciencesJob,
  // Publish a zero only when the complete jobsAllData array of the listing
  // has no Swiss offer (see fetchAllIntegraBiosciencesJobs). A failed or
  // unrecognised fetch stays a bare `[]` that keeps the previous slice and
  // stays visible to crawler-health (no EMPTY_OK_CRAWLERS entry any more:
  // it hid this parser reading an always-empty table for months).
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(INTEGRA_BIOSCIENCES_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ INTEGRA Biosciences crawler failed: ${err?.message || err}`);
  process.exit(1);
});
