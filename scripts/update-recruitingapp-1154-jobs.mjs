#!/usr/bin/env node
/**
 * Dedicated SGKB Bewerbermanagement Stellen crawler runner.
 *
 * Uses the standard crawler template with the SGKB Bewerbermanagement Stellen parser.
 * All fetch/parse logic lives in ./lib/recruitingapp-1154-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllRecruitingapp1154Jobs,
  isRecruitingapp1154Job,
  isTrustedDomain,
  RECRUITINGAPP_1154_KEY,
  RECRUITINGAPP_1154_COMPANY_NAME,
} from './lib/recruitingapp-1154-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RECRUITINGAPP_1154_KEY,
  companyLabel: RECRUITINGAPP_1154_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRecruitingapp1154Jobs,
  isCompanyJob: isRecruitingapp1154Job,
  // Publish a zero only when the Umantis board rendered its own empty-state
  // marker (issue #6660 class). An unproven zero keeps the previous slice, so
  // a broken crawler stays visibly unhealthy instead of being masked by an
  // `EMPTY_OK_CRAWLERS` entry.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(RECRUITINGAPP_1154_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SGKB Bewerbermanagement Stellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
