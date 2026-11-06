#!/usr/bin/env node
/**
 * Dedicated AvantGarten crawler runner.
 *
 * Uses the standard crawler template with the AvantGarten parser.
 * All fetch/parse logic lives in ./lib/avantgarten-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAvantgartenChJobs,
  isAvantgartenChJob,
  isTrustedDomain,
  AVANTGARTEN_CH_KEY,
  AVANTGARTEN_CH_COMPANY_NAME,
} from './lib/avantgarten-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AVANTGARTEN_CH_KEY,
  companyLabel: AVANTGARTEN_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAvantgartenChJobs,
  isCompanyJob: isAvantgartenChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ AvantGarten crawler failed: ${err?.message || err}`);
  process.exit(1);
});
