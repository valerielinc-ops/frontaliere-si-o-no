#!/usr/bin/env node
/**
 * Dedicated Mistral AI crawler runner.
 *
 * Uses the standard crawler template with the Mistral AI parser.
 * All fetch/parse logic lives in ./lib/mistral-ai-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMistralAiJobs,
  isMistralAiJob,
  isTrustedDomain,
  MISTRAL_AI_KEY,
  MISTRAL_AI_COMPANY_NAME,
} from './lib/mistral-ai-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MISTRAL_AI_KEY,
  companyLabel: MISTRAL_AI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMistralAiJobs,
  isCompanyJob: isMistralAiJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Mistral AI crawler failed: ${err?.message || err}`);
  process.exit(1);
});
