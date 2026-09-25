#!/usr/bin/env node
/**
 * Dedicated LALIVE crawler runner.
 *
 * Uses the standard crawler template with the LALIVE parser.
 * All fetch/parse logic lives in ./lib/lalive-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLaliveJobs,
  isLaliveJob,
  isTrustedDomain,
  LALIVE_KEY,
  LALIVE_COMPANY_NAME,
} from './lib/lalive-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LALIVE_KEY,
  companyLabel: LALIVE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLaliveJobs,
  isCompanyJob: isLaliveJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ LALIVE crawler failed: ${err?.message || err}`);
  process.exit(1);
});
