#!/usr/bin/env node
/**
 * Dedicated Privatklinik Bethanien crawler runner.
 *
 * Uses the standard crawler template with the Privatklinik Bethanien parser.
 * All fetch/parse logic lives in ./lib/privatklinik-bethanien-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPrivatklinikBethanienJobs,
  isPrivatklinikBethanienJob,
  isTrustedDomain,
  PRIVATKLINIK_BETHANIEN_KEY,
  PRIVATKLINIK_BETHANIEN_COMPANY_NAME,
} from './lib/privatklinik-bethanien-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PRIVATKLINIK_BETHANIEN_KEY,
  companyLabel: PRIVATKLINIK_BETHANIEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPrivatklinikBethanienJobs,
  isCompanyJob: isPrivatklinikBethanienJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Privatklinik Bethanien crawler failed: ${err?.message || err}`);
  process.exit(1);
});
