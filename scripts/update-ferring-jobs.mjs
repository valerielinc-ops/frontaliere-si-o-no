#!/usr/bin/env node
/**
 * Dedicated Ferring Pharmaceuticals crawler runner.
 *
 * Uses the standard crawler template with the Ferring Pharmaceuticals parser.
 * All fetch/parse logic lives in ./lib/ferring-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllFerringJobs,
  isFerringJob,
  isTrustedDomain,
  FERRING_KEY,
  FERRING_COMPANY_NAME,
} from './lib/ferring-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FERRING_KEY,
  companyLabel: FERRING_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFerringJobs,
  isCompanyJob: isFerringJob,
  // Publish a zero only when the live Workday board proves Switzerland is
  // absent from its country facet. A bare `[]` (renamed site, anti-bot,
  // facet drift, unproven drop) is refused and keeps the previous slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(FERRING_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Ferring Pharmaceuticals crawler failed: ${err?.message || err}`);
  process.exit(1);
});
