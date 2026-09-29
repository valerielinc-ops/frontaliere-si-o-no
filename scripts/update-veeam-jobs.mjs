#!/usr/bin/env node
/**
 * Dedicated Veeam Software crawler runner.
 *
 * Uses the standard crawler template with the Veeam parser.
 * All fetch/parse logic lives in ./lib/veeam-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllVeeamJobs,
  isVeeamJob,
  isTrustedDomain,
  VEEAM_KEY,
  VEEAM_COMPANY_NAME,
} from './lib/veeam-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VEEAM_KEY,
  companyLabel: VEEAM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVeeamJobs,
  isCompanyJob: isVeeamJob,
  // Publish a zero only when the Greenhouse board answered with open jobs and
  // none of them is Swiss (see `provenEmptySwissBatch`). `empty-only` keeps
  // the ordinary miss-grace path for a non-empty batch; an unproven zero keeps
  // the previous slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(VEEAM_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Veeam crawler failed: ${err?.message || err}`);
  process.exit(1);
});
