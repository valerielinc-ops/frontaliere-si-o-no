#!/usr/bin/env node
/**
 * Dedicated Spitäler Schaffhausen crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitaelerSchaffhausenJobs,
  isSpitaelerSchaffhausenJob,
  isTrustedDomain,
  SPITAELER_SCHAFFHAUSEN_KEY,
  SPITAELER_SCHAFFHAUSEN_COMPANY_NAME,
} from './lib/spitaeler-schaffhausen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAELER_SCHAFFHAUSEN_KEY,
  companyLabel: SPITAELER_SCHAFFHAUSEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitaelerSchaffhausenJobs,
  isCompanyJob: isSpitaelerSchaffhausenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spitäler Schaffhausen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
