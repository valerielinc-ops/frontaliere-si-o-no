#!/usr/bin/env node
/**
 * Dedicated Privatklinik Obach crawler runner.
 *
 * Uses the standard crawler template with the Privatklinik Obach parser.
 * All fetch/parse logic lives in ./lib/privatklinik-obach-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPrivatklinikObachJobs,
  isPrivatklinikObachJob,
  isTrustedDomain,
  PRIVATKLINIK_OBACH_KEY,
  PRIVATKLINIK_OBACH_COMPANY_NAME,
} from './lib/privatklinik-obach-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PRIVATKLINIK_OBACH_KEY,
  companyLabel: PRIVATKLINIK_OBACH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPrivatklinikObachJobs,
  isCompanyJob: isPrivatklinikObachJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Privatklinik Obach crawler failed: ${err?.message || err}`);
  process.exit(1);
});
