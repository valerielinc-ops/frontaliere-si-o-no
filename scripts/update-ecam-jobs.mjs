#!/usr/bin/env node
/**
 * Dedicated Ente Case Anziani Mendrisiotto (ECAM) crawler runner.
 *
 * Uses the standard crawler template with the Ente Case Anziani Mendrisiotto (ECAM) parser.
 * All fetch/parse logic lives in ./lib/ecam-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEcamJobs,
  isEcamJob,
  isTrustedDomain,
  ECAM_KEY,
  ECAM_COMPANY_NAME,
  ECAM_FABRICATED_DESCRIPTION_RE,
} from './lib/ecam-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ECAM_KEY,
  companyLabel: ECAM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEcamJobs,
  isCompanyJob: isEcamJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, ECAM_FABRICATED_DESCRIPTION_RE, ECAM_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Ente Case Anziani Mendrisiotto (ECAM) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
