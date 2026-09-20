#!/usr/bin/env node
/**
 * Dedicated & im Bethesda Spital crawler runner.
 *
 * Uses the standard crawler template with the & im Bethesda Spital parser.
 * All fetch/parse logic lives in ./lib/im-bethesda-spital-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllImBethesdaSpitalJobs,
  isImBethesdaSpitalJob,
  isTrustedDomain,
  IM_BETHESDA_SPITAL_KEY,
  IM_BETHESDA_SPITAL_COMPANY_NAME,
} from './lib/im-bethesda-spital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IM_BETHESDA_SPITAL_KEY,
  companyLabel: IM_BETHESDA_SPITAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllImBethesdaSpitalJobs,
  isCompanyJob: isImBethesdaSpitalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ & im Bethesda Spital crawler failed: ${err?.message || err}`);
  process.exit(1);
});
