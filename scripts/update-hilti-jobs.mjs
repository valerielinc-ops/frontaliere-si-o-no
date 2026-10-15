#!/usr/bin/env node
/**
 * Dedicated Hilti crawler runner.
 *
 * Uses the standard crawler template with the Hilti parser.
 * All fetch/parse logic lives in ./lib/hilti-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHiltiJobs,
  isHiltiJob,
  isTrustedDomain,
  HILTI_KEY,
  HILTI_COMPANY_NAME,
  HILTI_FABRICATED_DESCRIPTION_RE,
} from './lib/hilti-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HILTI_KEY,
  companyLabel: HILTI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHiltiJobs,
  isCompanyJob: isHiltiJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
  // Stored jobs still carry the "<title> — Hilti" line the parser used to
  // publish instead of a missing body (issue 5253); the merge would keep it,
  // so drop it (and the translations made from it) first.
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, HILTI_FABRICATED_DESCRIPTION_RE, HILTI_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Hilti crawler failed: ${err?.message || err}`);
  process.exit(1);
});
