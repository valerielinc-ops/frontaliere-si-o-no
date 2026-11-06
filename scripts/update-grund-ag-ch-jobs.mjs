#!/usr/bin/env node
/**
 * Dedicated Grund AG Fahrzeuge crawler runner.
 *
 * Uses the standard crawler template with the Grund AG Fahrzeuge parser.
 * All fetch/parse logic lives in ./lib/grund-ag-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGrundAgChJobs,
  isGrundAgChJob,
  isTrustedDomain,
  GRUND_AG_CH_KEY,
  GRUND_AG_CH_COMPANY_NAME,
} from './lib/grund-ag-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GRUND_AG_CH_KEY,
  companyLabel: GRUND_AG_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGrundAgChJobs,
  isCompanyJob: isGrundAgChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Grund AG Fahrzeuge crawler failed: ${err?.message || err}`);
  process.exit(1);
});
