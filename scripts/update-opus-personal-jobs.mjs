#!/usr/bin/env node
/**
 * Dedicated Opus Personal AG, Zweigniederlassung Altdorf crawler runner.
 *
 * Uses the standard crawler template with the Opus Personal AG, Zweigniederlassung Altdorf parser.
 * All fetch/parse logic lives in ./lib/opus-personal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOpusPersonalJobs,
  isOpusPersonalJob,
  isTrustedDomain,
  OPUS_PERSONAL_KEY,
  OPUS_PERSONAL_COMPANY_NAME,
} from './lib/opus-personal-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OPUS_PERSONAL_KEY,
  companyLabel: OPUS_PERSONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOpusPersonalJobs,
  isCompanyJob: isOpusPersonalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Opus Personal AG, Zweigniederlassung Altdorf crawler failed: ${err?.message || err}`);
  process.exit(1);
});
