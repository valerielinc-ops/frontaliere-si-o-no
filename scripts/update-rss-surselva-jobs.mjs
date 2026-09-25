#!/usr/bin/env node
/**
 * Dedicated Regionalspital Surselva crawler runner.
 *
 * Uses the standard crawler template with the Regionalspital Surselva parser.
 * All fetch/parse logic lives in ./lib/rss-surselva-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRssSurselvaJobs,
  isRssSurselvaJob,
  isTrustedDomain,
  RSS_SURSELVA_KEY,
  RSS_SURSELVA_COMPANY_NAME,
} from './lib/rss-surselva-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RSS_SURSELVA_KEY,
  companyLabel: RSS_SURSELVA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRssSurselvaJobs,
  isCompanyJob: isRssSurselvaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Regionalspital Surselva crawler failed: ${err?.message || err}`);
  process.exit(1);
});
