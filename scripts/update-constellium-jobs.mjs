#!/usr/bin/env node
/**
 * Dedicated Constellium Valais crawler runner.
 *
 * Uses the standard crawler template with the Constellium Valais parser.
 * All fetch/parse logic lives in ./lib/constellium-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllConstelliumJobs,
  isConstelliumJob,
  isTrustedDomain,
  CONSTELLIUM_KEY,
  CONSTELLIUM_COMPANY_NAME,
} from './lib/constellium-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CONSTELLIUM_KEY,
  companyLabel: CONSTELLIUM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllConstelliumJobs,
  isCompanyJob: isConstelliumJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Constellium Valais crawler failed: ${err?.message || err}`);
  process.exit(1);
});
