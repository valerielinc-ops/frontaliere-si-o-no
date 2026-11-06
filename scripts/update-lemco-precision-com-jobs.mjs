#!/usr/bin/env node
/**
 * Dedicated Lemco Précision SA crawler runner.
 *
 * Uses the standard crawler template with the Lemco Précision SA parser.
 * All fetch/parse logic lives in ./lib/lemco-precision-com-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLemcoPrecisionComJobs,
  isLemcoPrecisionComJob,
  isTrustedDomain,
  LEMCO_PRECISION_COM_KEY,
  LEMCO_PRECISION_COM_COMPANY_NAME,
} from './lib/lemco-precision-com-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LEMCO_PRECISION_COM_KEY,
  companyLabel: LEMCO_PRECISION_COM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLemcoPrecisionComJobs,
  isCompanyJob: isLemcoPrecisionComJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Lemco Précision SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
