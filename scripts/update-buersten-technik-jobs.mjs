#!/usr/bin/env node
/**
 * Dedicated buersten-technik crawler runner.
 *
 * Uses the standard crawler template with the buersten-technik parser.
 * All fetch/parse logic lives in ./lib/buersten-technik-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBuerstenTechnikJobs,
  isBuerstenTechnikJob,
  isTrustedDomain,
  BUERSTEN_TECHNIK_KEY,
  BUERSTEN_TECHNIK_COMPANY_NAME,
} from './lib/buersten-technik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BUERSTEN_TECHNIK_KEY,
  companyLabel: BUERSTEN_TECHNIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBuerstenTechnikJobs,
  isCompanyJob: isBuerstenTechnikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ buersten-technik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
