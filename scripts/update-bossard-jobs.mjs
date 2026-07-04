#!/usr/bin/env node
/**
 * Dedicated Bossard Group crawler runner.
 *
 * Uses the standard crawler template with the Bossard parser.
 * All fetch/parse logic lives in ./lib/bossard-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBossardJobs,
  isBossardJob,
  isTrustedDomain,
  BOSSARD_KEY,
  BOSSARD_COMPANY_NAME,
} from './lib/bossard-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BOSSARD_KEY,
  companyLabel: BOSSARD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBossardJobs,
  isCompanyJob: isBossardJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bossard crawler failed: ${err?.message || err}`);
  process.exit(1);
});
