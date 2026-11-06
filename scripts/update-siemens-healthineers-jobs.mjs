#!/usr/bin/env node
/**
 * Dedicated Siemens Healthineers crawler runner.
 *
 * Uses the standard crawler template with the Siemens Healthineers parser.
 * All fetch/parse logic lives in ./lib/siemens-healthineers-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllSiemensHealthineersJobs,
  isSiemensHealthineersJob,
  isTrustedDomain,
  SIEMENS_HEALTHINEERS_KEY,
  SIEMENS_HEALTHINEERS_COMPANY_NAME,
} from './lib/siemens-healthineers-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SIEMENS_HEALTHINEERS_KEY,
  companyLabel: SIEMENS_HEALTHINEERS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSiemensHealthineersJobs,
  isCompanyJob: isSiemensHealthineersJob,
  // Publish a zero only when the parser proved the Swiss board holds nothing
  // but foreign-primary cross-postings (issue #9651). A bare `[]` (anti-bot,
  // failed fetch, unproven drop) is refused by the validator and keeps the
  // previous slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(SIEMENS_HEALTHINEERS_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Siemens Healthineers crawler failed: ${err?.message || err}`);
  process.exit(1);
});
