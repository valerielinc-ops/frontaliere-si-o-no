#!/usr/bin/env node
/**
 * Dedicated Privatklinik Hohenegg crawler runner.
 *
 * Uses the standard crawler template with the Hohenegg parser.
 * All fetch/parse logic lives in ./lib/privatklinik-hohenegg-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPrivatklinikHoheneggJobs,
  isPrivatklinikHoheneggJob,
  isTrustedDomain,
  PRIVATKLINIK_HOHENEGG_KEY,
  PRIVATKLINIK_HOHENEGG_COMPANY_NAME,
} from './lib/privatklinik-hohenegg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PRIVATKLINIK_HOHENEGG_KEY,
  companyLabel: PRIVATKLINIK_HOHENEGG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPrivatklinikHoheneggJobs,
  isCompanyJob: isPrivatklinikHoheneggJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Privatklinik Hohenegg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
