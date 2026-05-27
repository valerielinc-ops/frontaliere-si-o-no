#!/usr/bin/env node
/**
 * Dedicated Spital Limmattal crawler runner.
 *
 * Uses the standard crawler template with the Spital Limmattal parser.
 * All fetch/parse logic lives in ./lib/spital-limmattal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalLimmattalJobs,
  isSpitalLimmattalJob,
  isTrustedDomain,
  SPITAL_LIMMATTAL_KEY,
  SPITAL_LIMMATTAL_COMPANY_NAME,
} from './lib/spital-limmattal-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_LIMMATTAL_KEY,
  companyLabel: SPITAL_LIMMATTAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalLimmattalJobs,
  isCompanyJob: isSpitalLimmattalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Limmattal crawler failed: ${err?.message || err}`);
  process.exit(1);
});
