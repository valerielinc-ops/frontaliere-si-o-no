#!/usr/bin/env node
/**
 * Dedicated Weisse Arena Gruppe crawler runner.
 *
 * Uses the standard crawler template with the Weisse Arena Gruppe parser.
 * All fetch/parse logic lives in ./lib/weisse-arena-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllWeisseArenaJobs,
  isWeisseArenaJob,
  isTrustedDomain,
  WEISSE_ARENA_KEY,
  WEISSE_ARENA_COMPANY_NAME,
} from './lib/weisse-arena-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: WEISSE_ARENA_KEY,
  companyLabel: WEISSE_ARENA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllWeisseArenaJobs,
  isCompanyJob: isWeisseArenaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Weisse Arena Gruppe crawler failed: ${err?.message || err}`);
  process.exit(1);
});
