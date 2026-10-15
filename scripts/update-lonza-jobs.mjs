#!/usr/bin/env node
/**
 * Dedicated Lonza crawler runner.
 *
 * Lonza is a global pharma/biotech company headquartered in Basel,
 * with major operations in Visp (Canton Valais, VS).
 *
 * Uses the standard crawler template with the Lonza Workday parser.
 * All fetch/parse logic lives in ./lib/lonza-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLonzaJobs,
  isLonzaJob,
  isTrustedDomain,
  LONZA_KEY,
  LONZA_COMPANY_NAME,
  LONZA_FABRICATED_DESCRIPTION_RE,
} from './lib/lonza-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LONZA_KEY,
  companyLabel: LONZA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLonzaJobs,
  isCompanyJob: isLonzaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
  // The stored jobs still carry the company sentence the parser used to
  // append, and the translations made from it: drop them so the posting's
  // own text is retranslated (issue 5253).
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, LONZA_FABRICATED_DESCRIPTION_RE, LONZA_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Lonza crawler failed: ${err?.message || err}`);
  process.exit(1);
});
