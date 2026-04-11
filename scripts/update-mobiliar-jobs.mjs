#!/usr/bin/env node
/**
 * Dedicated die Mobiliar crawler runner.
 *
 * Uses the standard crawler template with the die Mobiliar parser.
 * All fetch/parse logic lives in ./lib/mobiliar-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMobiliarJobs,
  isMobiliarJob,
  isTrustedDomain,
  MOBILIAR_KEY,
  MOBILIAR_COMPANY_NAME,
} from './lib/mobiliar-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MOBILIAR_KEY,
  companyLabel: MOBILIAR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMobiliarJobs,
  isCompanyJob: isMobiliarJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ die Mobiliar crawler failed: ${err?.message || err}`);
  process.exit(1);
});
