#!/usr/bin/env node
/**
 * Dedicated Komax crawler runner.
 *
 * Uses the standard crawler template with the Komax parser.
 * All fetch/parse logic lives in ./lib/komax-group-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKomaxGroupJobs,
  isKomaxJob,
  isTrustedDomain,
  KOMAX_KEY,
  KOMAX_COMPANY_NAME,
} from './lib/komax-group-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KOMAX_KEY,
  companyLabel: KOMAX_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKomaxGroupJobs,
  isCompanyJob: isKomaxJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Komax crawler failed: ${err?.message || err}`);
  process.exit(1);
});
