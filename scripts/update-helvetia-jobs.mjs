#!/usr/bin/env node
/**
 * Dedicated Helvetia Versicherungen crawler runner.
 *
 * Uses the standard crawler template with the Helvetia Versicherungen parser.
 * All fetch/parse logic lives in ./lib/helvetia-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHelvetiaJobs,
  isHelvetiaJob,
  isTrustedDomain,
  HELVETIA_KEY,
  HELVETIA_COMPANY_NAME,
} from './lib/helvetia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HELVETIA_KEY,
  companyLabel: HELVETIA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHelvetiaJobs,
  isCompanyJob: isHelvetiaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Helvetia Versicherungen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
