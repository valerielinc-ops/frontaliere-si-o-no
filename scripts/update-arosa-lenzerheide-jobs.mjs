#!/usr/bin/env node
/**
 * Dedicated Arosa Lenzerheide crawler runner.
 *
 * Uses the standard crawler template with the Arosa Lenzerheide parser.
 * All fetch/parse logic lives in ./lib/arosa-lenzerheide-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllArosaLenzerheideJobs,
  isArosaLenzerheideJob,
  isTrustedDomain,
  AROSA_LENZERHEIDE_KEY,
  AROSA_LENZERHEIDE_COMPANY_NAME,
} from './lib/arosa-lenzerheide-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AROSA_LENZERHEIDE_KEY,
  companyLabel: AROSA_LENZERHEIDE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllArosaLenzerheideJobs,
  isCompanyJob: isArosaLenzerheideJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Arosa Lenzerheide crawler failed: ${err?.message || err}`);
  process.exit(1);
});
