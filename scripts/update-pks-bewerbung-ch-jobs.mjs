#!/usr/bin/env node
/**
 * Dedicated pks-bewerbung crawler runner.
 *
 * Uses the standard crawler template with the pks-bewerbung parser.
 * All fetch/parse logic lives in ./lib/pks-bewerbung-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPksBewerbungChJobs,
  isPksBewerbungChJob,
  isTrustedDomain,
  PKS_BEWERBUNG_CH_KEY,
  PKS_BEWERBUNG_CH_COMPANY_NAME,
} from './lib/pks-bewerbung-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PKS_BEWERBUNG_CH_KEY,
  companyLabel: PKS_BEWERBUNG_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPksBewerbungChJobs,
  isCompanyJob: isPksBewerbungChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ pks-bewerbung crawler failed: ${err?.message || err}`);
  process.exit(1);
});
