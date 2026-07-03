#!/usr/bin/env node
/**
 * Dedicated Edmond de Rothschild crawler runner.
 *
 * Uses the standard crawler template with the Edmond de Rothschild parser.
 * All fetch/parse logic lives in ./lib/edmond-de-rothschild-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEdmondDeRothschildJobs,
  isEdmondDeRothschildJob,
  isTrustedDomain,
  EDMOND_DE_ROTHSCHILD_KEY,
  EDMOND_DE_ROTHSCHILD_COMPANY_NAME,
} from './lib/edmond-de-rothschild-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EDMOND_DE_ROTHSCHILD_KEY,
  companyLabel: EDMOND_DE_ROTHSCHILD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEdmondDeRothschildJobs,
  isCompanyJob: isEdmondDeRothschildJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Edmond de Rothschild crawler failed: ${err?.message || err}`);
  process.exit(1);
});
