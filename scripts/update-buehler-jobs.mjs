#!/usr/bin/env node
/**
 * Dedicated Bühler Group crawler runner.
 *
 * Uses the standard crawler template with the Bühler Group parser.
 * All fetch/parse logic lives in ./lib/buehler-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBuehlerJobs,
  isBuehlerJob,
  isTrustedDomain,
  BUEHLER_KEY,
  BUEHLER_COMPANY_NAME,
} from './lib/buehler-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BUEHLER_KEY,
  companyLabel: BUEHLER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBuehlerJobs,
  isCompanyJob: isBuehlerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bühler Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
