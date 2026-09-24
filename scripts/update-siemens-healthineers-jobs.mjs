#!/usr/bin/env node
/**
 * Dedicated Siemens Healthineers crawler runner.
 *
 * Uses the standard crawler template with the Siemens Healthineers parser.
 * All fetch/parse logic lives in ./lib/siemens-healthineers-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllSiemensHealthineersJobs,
  isSiemensHealthineersJob,
  isTrustedDomain,
  SIEMENS_HEALTHINEERS_KEY,
  SIEMENS_HEALTHINEERS_COMPANY_NAME,
} from './lib/siemens-healthineers-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SIEMENS_HEALTHINEERS_KEY,
  companyLabel: SIEMENS_HEALTHINEERS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSiemensHealthineersJobs,
  isCompanyJob: isSiemensHealthineersJob,
  // Uno zero si pubblica solo quando il facet svizzero ha elencato annunci e
  // il dettaglio di ognuno dichiara una sede primaria estera (la factory
  // Workday lo marca): dal 2026-09-19 i tre annunci del facet sono roll-up UK,
  // DE, FR e il `[]` non provato teneva il crawler «broken» per sempre. Un
  // fetch fallito resta un `[]` non provato e tiene la slice precedente.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(SIEMENS_HEALTHINEERS_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Siemens Healthineers crawler failed: ${err?.message || err}`);
  process.exit(1);
});
