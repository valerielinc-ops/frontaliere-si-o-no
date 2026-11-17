#!/usr/bin/env node
/**
 * Dedicated Careanesth AG crawler runner.
 *
 * Uses the standard crawler template with the Careanesth AG parser.
 * All fetch/parse logic lives in ./lib/careanesth-com-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCareanesthComJobs,
  isCareanesthComJob,
  isTrustedDomain,
  CAREANESTH_COM_KEY,
  CAREANESTH_COM_COMPANY_NAME,
} from './lib/careanesth-com-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CAREANESTH_COM_KEY,
  companyLabel: CAREANESTH_COM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCareanesthComJobs,
  isCompanyJob: isCareanesthComJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Careanesth AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
