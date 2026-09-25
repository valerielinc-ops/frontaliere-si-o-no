#!/usr/bin/env node
/**
 * Dedicated Sodexo (Suisse) SA crawler runner.
 *
 * Uses the standard crawler template with the Sodexo parser. All fetch/parse
 * logic lives in ./lib/sodexo-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSodexoJobs,
  isSodexoJob,
  isTrustedDomain,
  SODEXO_KEY,
  SODEXO_COMPANY_NAME,
} from './lib/sodexo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SODEXO_KEY,
  companyLabel: SODEXO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSodexoJobs,
  isCompanyJob: isSodexoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Sodexo crawler failed: ${err?.message || err}`);
  process.exit(1);
});
