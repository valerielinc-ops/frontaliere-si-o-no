#!/usr/bin/env node
/**
 * Dedicated Volksschule Stadt Luzern crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVolksschuleLuzernJobs,
  isVolksschuleLuzernJob,
  isTrustedDomain,
  VOLKSSCHULE_LUZERN_KEY,
  VOLKSSCHULE_LUZERN_COMPANY_NAME,
} from './lib/volksschule-luzern-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VOLKSSCHULE_LUZERN_KEY,
  companyLabel: VOLKSSCHULE_LUZERN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVolksschuleLuzernJobs,
  isCompanyJob: isVolksschuleLuzernJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Volksschule Luzern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
