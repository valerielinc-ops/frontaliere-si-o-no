#!/usr/bin/env node
/**
 * Dedicated Medbase crawler runner.
 *
 * Uses the standard crawler template with the Medbase parser.
 * All fetch/parse logic lives in ./lib/medbase-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMedbaseJobs,
  isMedbaseJob,
  isTrustedDomain,
  MEDBASE_KEY,
  MEDBASE_COMPANY_NAME,
} from './lib/medbase-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MEDBASE_KEY,
  companyLabel: MEDBASE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMedbaseJobs,
  isCompanyJob: isMedbaseJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Medbase crawler failed: ${err?.message || err}`);
  process.exit(1);
});
