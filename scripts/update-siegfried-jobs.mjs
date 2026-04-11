#!/usr/bin/env node
/**
 * Dedicated Siegfried crawler runner.
 *
 * Uses the standard crawler template with the Siegfried parser.
 * All fetch/parse logic lives in ./lib/siegfried-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSiegfriedJobs,
  isSiegfriedJob,
  isTrustedDomain,
  SIEGFRIED_KEY,
  SIEGFRIED_COMPANY_NAME,
} from './lib/siegfried-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SIEGFRIED_KEY,
  companyLabel: SIEGFRIED_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSiegfriedJobs,
  isCompanyJob: isSiegfriedJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Siegfried crawler failed: ${err?.message || err}`);
  process.exit(1);
});
