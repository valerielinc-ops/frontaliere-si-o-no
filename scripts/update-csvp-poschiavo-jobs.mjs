#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllCsvpPoschiavoJobs,
  isCsvpPoschiavoJob,
  isTrustedDomain,
  CSVP_POSCHIAVO_KEY,
  CSVP_POSCHIAVO_COMPANY_NAME,
  CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE,
} from './lib/csvp-poschiavo-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CSVP_POSCHIAVO_KEY,
  companyLabel: CSVP_POSCHIAVO_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCsvpPoschiavoJobs,
  isCompanyJob: isCsvpPoschiavoJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  // Publish zero only when the official Joomla category explicitly renders
  // its empty-state message; an unrecognised page keeps the previous slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(CSVP_POSCHIAVO_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, CSVP_POSCHIAVO_FABRICATED_DESCRIPTION_RE, CSVP_POSCHIAVO_COMPANY_NAME),
}).catch((err) => { console.error(`❌ CSVP crawler failed: ${err?.message || err}`); process.exit(1); });
