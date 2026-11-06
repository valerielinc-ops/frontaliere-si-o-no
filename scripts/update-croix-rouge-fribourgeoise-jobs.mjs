#!/usr/bin/env node
/**
 * Dedicated Croix-Rouge fribourgeoise crawler runner.
 *
 * Uses the standard crawler template with the Croix-Rouge fribourgeoise
 * parser. All fetch/parse logic lives in
 * ./lib/croix-rouge-fribourgeoise-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCroixRougeFribourgeoiseJobs,
  isCroixRougeFribourgeoiseJob,
  isTrustedDomain,
  CROIX_ROUGE_FRIBOURGEOISE_KEY,
  CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME,
} from './lib/croix-rouge-fribourgeoise-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CROIX_ROUGE_FRIBOURGEOISE_KEY,
  companyLabel: CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCroixRougeFribourgeoiseJobs,
  isCompanyJob: isCroixRougeFribourgeoiseJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Croix-Rouge fribourgeoise crawler failed: ${err?.message || err}`);
  process.exit(1);
});
