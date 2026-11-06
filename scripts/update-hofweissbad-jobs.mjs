#!/usr/bin/env node
/**
 * Dedicated Resort Hof Weissbad crawler runner.
 *
 * Uses the standard crawler template with the Hof Weissbad parser.
 * All fetch/parse logic lives in ./lib/hofweissbad-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllHofweissbadJobs,
  isHofweissbadJob,
  isTrustedDomain,
  HOFWEISSBAD_KEY,
  HOFWEISSBAD_COMPANY_NAME,
} from './lib/hofweissbad-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOFWEISSBAD_KEY,
  companyLabel: HOFWEISSBAD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHofweissbadJobs,
  isCompanyJob: isHofweissbadJob,
  // Publish a zero only when the source itself proved it is empty (issue
  // #7458/#6660 class). An unproven zero keeps the previous slice, so a
  // broken crawler stays visibly unhealthy instead of being masked by an
  // `EMPTY_OK_CRAWLERS` entry.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(HOFWEISSBAD_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Hof Weissbad crawler failed: ${err?.message || err}`);
  process.exit(1);
});
