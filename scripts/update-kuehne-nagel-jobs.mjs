#!/usr/bin/env node
/**
 * Dedicated Kuehne+Nagel crawler runner.
 *
 * Uses the standard crawler template with the Kuehne+Nagel parser.
 * All fetch/parse logic lives in ./lib/kuehne-nagel-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKuehneNagelJobs,
  isKuehneNagelJob,
  isTrustedDomain,
  KUEHNE_NAGEL_KEY,
  KUEHNE_NAGEL_COMPANY_NAME,
} from './lib/kuehne-nagel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KUEHNE_NAGEL_KEY,
  companyLabel: KUEHNE_NAGEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKuehneNagelJobs,
  isCompanyJob: isKuehneNagelJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kuehne+Nagel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
