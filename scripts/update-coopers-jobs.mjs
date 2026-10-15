#!/usr/bin/env node
/**
 * Dedicated Coopers Group AG crawler runner.
 *
 * Uses the standard crawler template with the Coopers Group AG parser.
 * All fetch/parse logic lives in ./lib/coopers-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCoopersJobs,
  isCoopersJob,
  isTrustedDomain,
  COOPERS_KEY,
  COOPERS_COMPANY_NAME,
} from './lib/coopers-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: COOPERS_KEY,
  companyLabel: COOPERS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCoopersJobs,
  isCompanyJob: isCoopersJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Coopers Group AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
