#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllStrabagJobs,
  isStrabagJob,
  isTrustedDomain,
  STRABAG_KEY,
  STRABAG_COMPANY_NAME,
} from './lib/strabag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STRABAG_KEY,
  companyLabel: STRABAG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStrabagJobs,
  isCompanyJob: isStrabagJob,
  // Publish a zero only when the jobs.ch profile itself renders a zero
  // vacancy counter (issue #7458 class). `empty-only` keeps the ordinary
  // miss-grace path for a non-empty batch; an unproven zero keeps the
  // previous slice, so a broken crawler stays visibly unhealthy instead of
  // being masked by an `EMPTY_OK_CRAWLERS` entry.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(STRABAG_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ STRABAG AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
