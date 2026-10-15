#!/usr/bin/env node
/**
 * Dedicated ETAVIS crawler runner.
 *
 * ETAVIS publishes a national, multi-subsidiary Swiss board; each vacancy's
 * canton is derived from its own city across all 26 cantons.
 * Uses the standard crawler template with the ETAVIS parser.
 * All fetch/parse logic lives in ./lib/etavis-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEtavisJobs,
  isEtavisJob,
  isTrustedDomain,
  ETAVIS_KEY,
  ETAVIS_COMPANY_NAME,
} from './lib/etavis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ETAVIS_KEY,
  companyLabel: ETAVIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEtavisJobs,
  isCompanyJob: isEtavisJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ETAVIS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
