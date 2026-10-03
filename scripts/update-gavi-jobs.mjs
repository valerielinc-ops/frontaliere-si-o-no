#!/usr/bin/env node
/**
 * Dedicated Gavi, the Vaccine Alliance crawler runner.
 *
 * Uses the standard crawler template with the Gavi parser.
 * All fetch/parse logic lives in ./lib/gavi-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllGaviJobs,
  isGaviJob,
  isTrustedDomain,
  GAVI_KEY,
  GAVI_COMPANY_NAME,
} from './lib/gavi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GAVI_KEY,
  companyLabel: GAVI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGaviJobs,
  isCompanyJob: isGaviJob,
  isTrustedDomain,
  // The fRecruit page has a complete, explicit zero state. A bare [] remains
  // fail-closed so a selector drift cannot retire the live Gavi slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(GAVI_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Gavi crawler failed: ${err?.message || err}`);
  process.exit(1);
});
