#!/usr/bin/env node
/**
 * Dedicated Imerys crawler runner.
 *
 * Uses the standard crawler template with the Imerys parser.
 * All fetch/parse logic lives in ./lib/imerys-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllImerysJobs,
  isImerysJob,
  isTrustedDomain,
  IMERYS_KEY,
  IMERYS_COMPANY_NAME,
} from './lib/imerys-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IMERYS_KEY,
  companyLabel: IMERYS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllImerysJobs,
  isCompanyJob: isImerysJob,
  // Publish a zero only when the live Workday board proves Switzerland is
  // absent from its country facet. A bare `[]` (renamed site, anti-bot,
  // facet drift, unproven drop) is refused and keeps the previous slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(IMERYS_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Imerys crawler failed: ${err?.message || err}`);
  process.exit(1);
});
