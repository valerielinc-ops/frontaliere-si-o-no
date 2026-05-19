#!/usr/bin/env node
/**
 * Dedicated Viva Luzern crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVivaLuzernJobs,
  isVivaLuzernJob,
  isTrustedDomain,
  VIVA_LUZERN_KEY,
  VIVA_LUZERN_COMPANY_NAME,
} from './lib/viva-luzern-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VIVA_LUZERN_KEY,
  companyLabel: VIVA_LUZERN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVivaLuzernJobs,
  isCompanyJob: isVivaLuzernJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Viva Luzern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
