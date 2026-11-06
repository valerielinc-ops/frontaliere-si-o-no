#!/usr/bin/env node
/**
 * Dedicated Luzerner Psychiatrie (LUPS) crawler runner.
 *
 * Uses the standard crawler template with the LUPS parser
 * (Prospective.ch careercenter tenant 1001516, SSR HTML — the v1 medium
 * JSON endpoint returns 400 for this tenant, so the parser scrapes the
 * careercenter HTML + per-detail JSON-LD JobPosting).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLupsJobs,
  isLupsJob,
  isTrustedDomain,
  LUPS_KEY,
  LUPS_COMPANY_NAME,
} from './lib/lups-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LUPS_KEY,
  companyLabel: LUPS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLupsJobs,
  isCompanyJob: isLupsJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Luzerner Psychiatrie (LUPS) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
