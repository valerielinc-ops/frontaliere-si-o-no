#!/usr/bin/env node
/**
 * Dedicated SOPHiA GENETICS crawler runner.
 *
 * Uses the standard crawler template with the SOPHiA GENETICS parser.
 * All fetch/parse logic lives in ./lib/sophia-genetics-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSophiaGeneticsJobs,
  isSophiaGeneticsJob,
  isTrustedDomain,
  SOPHIA_GENETICS_KEY,
  SOPHIA_GENETICS_COMPANY_NAME,
} from './lib/sophia-genetics-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SOPHIA_GENETICS_KEY,
  companyLabel: SOPHIA_GENETICS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSophiaGeneticsJobs,
  isCompanyJob: isSophiaGeneticsJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ SOPHiA GENETICS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
