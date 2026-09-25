#!/usr/bin/env node
/**
 * Dedicated SRG SSR crawler runner.
 *
 * Uses the standard crawler template with the SRG SSR parser.
 * All fetch/parse logic lives in ./lib/srg-ssr-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSrgSsrJobs,
  isSrgSsrJob,
  isTrustedDomain,
  SRG_SSR_KEY,
  SRG_SSR_COMPANY_NAME,
} from './lib/srg-ssr-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SRG_SSR_KEY,
  companyLabel: SRG_SSR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSrgSsrJobs,
  isCompanyJob: isSrgSsrJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SRG SSR crawler failed: ${err?.message || err}`);
  process.exit(1);
});
