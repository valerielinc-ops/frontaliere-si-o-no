#!/usr/bin/env node
/**
 * Dedicated INTEGRA Biosciences crawler runner.
 *
 * Uses the standard crawler template with the INTEGRA Biosciences parser.
 * All fetch/parse logic lives in ./lib/integra-biosciences-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllIntegraBiosciencesJobs,
  isIntegraBiosciencesJob,
  isTrustedDomain,
  INTEGRA_BIOSCIENCES_KEY,
  INTEGRA_BIOSCIENCES_COMPANY_NAME,
} from './lib/integra-biosciences-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: INTEGRA_BIOSCIENCES_KEY,
  companyLabel: INTEGRA_BIOSCIENCES_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIntegraBiosciencesJobs,
  isCompanyJob: isIntegraBiosciencesJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ INTEGRA Biosciences crawler failed: ${err?.message || err}`);
  process.exit(1);
});
