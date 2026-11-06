#!/usr/bin/env node
/**
 * Dedicated Trafigura crawler runner.
 *
 * Uses the standard crawler template with the Trafigura parser.
 * All fetch/parse logic lives in ./lib/trafigura-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTrafiguraJobs,
  isTrafiguraJob,
  isTrustedDomain,
  TRAFIGURA_KEY,
  TRAFIGURA_COMPANY_NAME,
} from './lib/trafigura-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TRAFIGURA_KEY,
  companyLabel: TRAFIGURA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTrafiguraJobs,
  isCompanyJob: isTrafiguraJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Trafigura crawler failed: ${err?.message || err}`);
  process.exit(1);
});
