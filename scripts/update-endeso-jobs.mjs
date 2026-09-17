#!/usr/bin/env node
/**
 * Dedicated endeso GmbH crawler runner.
 *
 * Uses the standard crawler template with the endeso GmbH parser.
 * All fetch/parse logic lives in ./lib/endeso-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEndesoJobs,
  isEndesoJob,
  isTrustedDomain,
  ENDESO_KEY,
  ENDESO_COMPANY_NAME,
} from './lib/endeso-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ENDESO_KEY,
  companyLabel: ENDESO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEndesoJobs,
  isCompanyJob: isEndesoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ endeso GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
