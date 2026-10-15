#!/usr/bin/env node
/**
 * Dedicated KONE crawler runner.
 *
 * Uses the standard crawler template with the KONE parser.
 * All fetch/parse logic lives in ./lib/kone-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllKoneJobs,
  isKoneJob,
  isTrustedDomain,
  KONE_KEY,
  KONE_COMPANY_NAME,
} from './lib/kone-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KONE_KEY,
  companyLabel: KONE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKoneJobs,
  isCompanyJob: isKoneJob,
  // Publish a zero only when the live Workday board proves Switzerland is
  // absent from its country facet. A bare `[]` (renamed site, anti-bot,
  // facet drift, unproven drop) is refused and keeps the previous slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(KONE_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ KONE crawler failed: ${err?.message || err}`);
  process.exit(1);
});
