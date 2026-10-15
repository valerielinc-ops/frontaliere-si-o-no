#!/usr/bin/env node
/**
 * Dedicated J. Safra Sarasin crawler runner.
 *
 * Uses the standard crawler template with the J. Safra Sarasin parser.
 * All fetch/parse logic lives in ./lib/jsafrasarasin-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllJsafrasarasinJobs,
  isJsafrasarasinJob,
  isTrustedDomain,
  JSAFRASARASIN_KEY,
  JSAFRASARASIN_COMPANY_NAME,
} from './lib/jsafrasarasin-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: JSAFRASARASIN_KEY,
  companyLabel: JSAFRASARASIN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllJsafrasarasinJobs,
  isCompanyJob: isJsafrasarasinJob,
  // Publish a zero only when the Umantis board rendered its own empty-state
  // marker (issue #6660 class). An unproven zero keeps the previous slice, so
  // a broken crawler stays visibly unhealthy instead of being masked by an
  // `EMPTY_OK_CRAWLERS` entry.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(JSAFRASARASIN_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ J. Safra Sarasin crawler failed: ${err?.message || err}`);
  process.exit(1);
});
