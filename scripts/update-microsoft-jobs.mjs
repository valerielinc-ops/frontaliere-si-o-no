#!/usr/bin/env node
/**
 * Dedicated Microsoft crawler runner.
 *
 * Uses the standard crawler template with the Microsoft parser.
 * All fetch/parse logic lives in ./lib/microsoft-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMicrosoftJobs,
  isMicrosoftJob,
  isTrustedDomain,
  MICROSOFT_KEY,
  MICROSOFT_COMPANY_NAME,
} from './lib/microsoft-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MICROSOFT_KEY,
  companyLabel: MICROSOFT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMicrosoftJobs,
  isCompanyJob: isMicrosoftJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Microsoft crawler failed: ${err?.message || err}`);
  process.exit(1);
});
