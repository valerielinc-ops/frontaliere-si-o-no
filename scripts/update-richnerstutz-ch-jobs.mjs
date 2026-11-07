#!/usr/bin/env node
/**
 * Dedicated Richnerstutz AG crawler runner.
 *
 * Uses the standard crawler template with the Richnerstutz AG parser.
 * All fetch/parse logic lives in ./lib/richnerstutz-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRichnerstutzChJobs,
  isRichnerstutzChJob,
  isTrustedDomain,
  RICHNERSTUTZ_CH_KEY,
  RICHNERSTUTZ_CH_COMPANY_NAME,
} from './lib/richnerstutz-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RICHNERSTUTZ_CH_KEY,
  companyLabel: RICHNERSTUTZ_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRichnerstutzChJobs,
  isCompanyJob: isRichnerstutzChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Richnerstutz AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
