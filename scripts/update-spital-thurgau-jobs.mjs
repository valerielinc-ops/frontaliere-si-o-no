#!/usr/bin/env node
/**
 * Dedicated Spital Thurgau (STGAG) crawler runner.
 *
 * Uses the standard crawler template with the Spital Thurgau (STGAG) parser.
 * All fetch/parse logic lives in ./lib/spital-thurgau-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalThurgauJobs,
  isSpitalThurgauJob,
  isTrustedDomain,
  SPITAL_THURGAU_KEY,
  SPITAL_THURGAU_COMPANY_NAME,
  SPITAL_THURGAU_FABRICATED_DESCRIPTION_RE,
} from './lib/spital-thurgau-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_THURGAU_KEY,
  companyLabel: SPITAL_THURGAU_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalThurgauJobs,
  isCompanyJob: isSpitalThurgauJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  // Stored jobs still carry the "<title> — Spital Thurgau (STGAG)." line over
  // the listing metadata that the parser used to publish instead of the ad
  // (issue 5253); the merge would keep it when a detail is not read, so drop
  // it (and the translations made from it) first.
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, SPITAL_THURGAU_FABRICATED_DESCRIPTION_RE, SPITAL_THURGAU_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Spital Thurgau (STGAG) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
