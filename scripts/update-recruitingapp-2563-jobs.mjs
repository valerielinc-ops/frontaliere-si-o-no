#!/usr/bin/env node
/**
 * Dedicated Switch Bewerbermanagement Stellen crawler runner.
 *
 * Uses the standard crawler template with the Switch Bewerbermanagement Stellen parser.
 * All fetch/parse logic lives in ./lib/recruitingapp-2563-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllRecruitingapp2563Jobs,
  isRecruitingapp2563Job,
  isTrustedDomain,
  RECRUITINGAPP_2563_KEY,
  RECRUITINGAPP_2563_COMPANY_NAME,
} from './lib/recruitingapp-2563-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RECRUITINGAPP_2563_KEY,
  companyLabel: RECRUITINGAPP_2563_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRecruitingapp2563Jobs,
  isCompanyJob: isRecruitingapp2563Job,
  isTrustedDomain,
  defaultSourceLang: 'de',
  // Publish a zero only when the parser proved the source itself says it is
  // empty (issues #7458 / #6660 / #7321). `empty-only` keeps the ordinary
  // miss-grace path for a non-empty batch, and an unproven zero still keeps
  // the previous slice — the crawler goes back to `unhealthy` rather than
  // being masked by an `EMPTY_OK_CRAWLERS` entry.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(RECRUITINGAPP_2563_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Switch Bewerbermanagement Stellen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
