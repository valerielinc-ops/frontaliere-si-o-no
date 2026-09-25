#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllVisionapartmentsJobs,
  isVisionapartmentsJob,
  isTrustedDomain,
  VISIONAPARTMENTS_KEY,
  VISIONAPARTMENTS_COMPANY_NAME,
} from './lib/visionapartments-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VISIONAPARTMENTS_KEY,
  companyLabel: VISIONAPARTMENTS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVisionapartmentsJobs,
  isCompanyJob: isVisionapartmentsJob,
  // Publish a zero only when the jobs.ch profile itself renders a zero
  // vacancy counter (issue #7458 class). `empty-only` keeps the ordinary
  // miss-grace path for a non-empty batch; an unproven zero keeps the
  // previous slice, so a broken crawler stays visibly unhealthy instead of
  // being masked by an `EMPTY_OK_CRAWLERS` entry.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(VISIONAPARTMENTS_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ VISIONAPARTMENTS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
