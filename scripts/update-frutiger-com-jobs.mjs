#!/usr/bin/env node
/**
 * Dedicated Frutiger AG crawler runner.
 *
 * Uses the standard crawler template with the Frutiger AG parser.
 * All fetch/parse logic lives in ./lib/frutiger-com-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFrutigerComJobs,
  isFrutigerComJob,
  isTrustedDomain,
  FRUTIGER_COM_KEY,
  FRUTIGER_COM_COMPANY_NAME,
} from './lib/frutiger-com-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FRUTIGER_COM_KEY,
  companyLabel: FRUTIGER_COM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFrutigerComJobs,
  isCompanyJob: isFrutigerComJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Frutiger AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
