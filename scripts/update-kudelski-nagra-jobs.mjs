#!/usr/bin/env node
/**
 * Dedicated Kudelski NAGRA crawler runner.
 *
 * Uses the standard crawler template with the Kudelski NAGRA parser.
 * All fetch/parse logic lives in ./lib/kudelski-nagra-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKudelskiNagraJobs,
  isKudelskiNagraJob,
  isTrustedDomain,
  KUDELSKI_NAGRA_KEY,
  KUDELSKI_NAGRA_COMPANY_NAME,
} from './lib/kudelski-nagra-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KUDELSKI_NAGRA_KEY,
  companyLabel: KUDELSKI_NAGRA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKudelskiNagraJobs,
  isCompanyJob: isKudelskiNagraJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Kudelski NAGRA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
