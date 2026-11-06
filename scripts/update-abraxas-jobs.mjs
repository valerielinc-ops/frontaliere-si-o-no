#!/usr/bin/env node
/**
 * Dedicated Abraxas Informatik AG crawler runner.
 *
 * Uses the standard crawler template with the Abraxas parser.
 * All fetch/parse logic lives in ./lib/abraxas-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAbraxasJobs,
  isAbraxasJob,
  isTrustedDomain,
  ABRAXAS_KEY,
  ABRAXAS_COMPANY_NAME,
} from './lib/abraxas-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ABRAXAS_KEY,
  companyLabel: ABRAXAS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAbraxasJobs,
  isCompanyJob: isAbraxasJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Abraxas crawler failed: ${err?.message || err}`);
  process.exit(1);
});
