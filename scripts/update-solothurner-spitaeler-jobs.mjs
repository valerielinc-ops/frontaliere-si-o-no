#!/usr/bin/env node
/**
 * Dedicated Solothurner Spitäler (soH) crawler runner.
 *
 * Uses the standard crawler template with the Solothurner Spitäler (soH) parser.
 * All fetch/parse logic lives in ./lib/solothurner-spitaeler-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSolothurnerSpitaelerJobs,
  isSolothurnerSpitaelerJob,
  isTrustedDomain,
  SOLOTHURNER_SPITAELER_KEY,
  SOLOTHURNER_SPITAELER_COMPANY_NAME,
} from './lib/solothurner-spitaeler-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SOLOTHURNER_SPITAELER_KEY,
  companyLabel: SOLOTHURNER_SPITAELER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSolothurnerSpitaelerJobs,
  isCompanyJob: isSolothurnerSpitaelerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Solothurner Spitäler (soH) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
