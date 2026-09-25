#!/usr/bin/env node
/**
 * Dedicated HOCH Health Ostschweiz crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHochHealthJobs,
  isHochHealthJob,
  isTrustedDomain,
  HOCH_HEALTH_KEY,
  HOCH_HEALTH_COMPANY_NAME,
} from './lib/hoch-health-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOCH_HEALTH_KEY,
  companyLabel: HOCH_HEALTH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHochHealthJobs,
  isCompanyJob: isHochHealthJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ HOCH Health crawler failed: ${err?.message || err}`);
  process.exit(1);
});
