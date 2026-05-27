#!/usr/bin/env node
/**
 * Dedicated Chicco d'Oro crawler runner.
 *
 * Uses the standard crawler template with the Chicco d'Oro parser.
 * All fetch/parse logic lives in ./lib/chicco-doro-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllChiccoDoroJobs,
  isChiccoDoroJob,
  isTrustedDomain,
  CHICCO_DORO_KEY,
  CHICCO_DORO_COMPANY_NAME,
} from './lib/chicco-doro-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CHICCO_DORO_KEY,
  companyLabel: CHICCO_DORO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllChiccoDoroJobs,
  isCompanyJob: isChiccoDoroJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Chicco d'Oro crawler failed: ${err?.message || err}`);
  process.exit(1);
});
