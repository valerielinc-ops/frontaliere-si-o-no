#!/usr/bin/env node
/**
 * Dedicated AnswerConsulting SA crawler runner.
 *
 * Uses the standard crawler template with the AnswerConsulting parser.
 * All fetch/parse logic lives in ./lib/answerconsulting-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAnswerConsultingJobs,
  isAnswerConsultingJob,
  isTrustedDomain,
  ANSWERCONSULTING_KEY,
  ANSWERCONSULTING_COMPANY_NAME,
} from './lib/answerconsulting-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ANSWERCONSULTING_KEY,
  companyLabel: ANSWERCONSULTING_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAnswerConsultingJobs,
  isCompanyJob: isAnswerConsultingJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ AnswerConsulting crawler failed: ${err?.message || err}`);
  process.exit(1);
});
