#!/usr/bin/env node
/**
 * Dedicated DIC SA crawler runner.
 *
 * Uses the standard crawler template with the DIC SA parser.
 * All fetch/parse logic lives in ./lib/dic-sa-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllDicSaJobs,
  isDicSaJob,
  isTrustedDomain,
  DIC_SA_KEY,
  DIC_SA_COMPANY_NAME,
} from './lib/dic-sa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DIC_SA_KEY,
  companyLabel: DIC_SA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDicSaJobs,
  isCompanyJob: isDicSaJob,
  isTrustedDomain,
  // The REST feed may be empty or temporarily unavailable. Publish a zero
  // only when the employer's visible careers page proves it has no offers;
  // an unproven zero remains fail-closed and keeps the old slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(DIC_SA_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ DIC SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
