#!/usr/bin/env node
/**
 * Dedicated Kellerhals Carrard crawler runner.
 *
 * Uses the standard crawler template with the Kellerhals Carrard parser.
 * All fetch/parse logic lives in ./lib/kellerhals-carrard-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKellerhalsCarrardJobs,
  isKellerhalsCarrardJob,
  isTrustedDomain,
  KELLERHALS_CARRARD_KEY,
  KELLERHALS_CARRARD_COMPANY_NAME,
  KELLERHALS_CARRARD_FABRICATED_DESCRIPTION_RE,
} from './lib/kellerhals-carrard-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KELLERHALS_CARRARD_KEY,
  companyLabel: KELLERHALS_CARRARD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKellerhalsCarrardJobs,
  isCompanyJob: isKellerhalsCarrardJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  // Stored jobs still carry the line + firm sentence the parser used to
  // publish instead of a short body (issue 5253); the merge would keep it,
  // so drop it (and the translations made from it) first.
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, KELLERHALS_CARRARD_FABRICATED_DESCRIPTION_RE, KELLERHALS_CARRARD_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Kellerhals Carrard crawler failed: ${err?.message || err}`);
  process.exit(1);
});
