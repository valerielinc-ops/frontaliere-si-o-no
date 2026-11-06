#!/usr/bin/env node
/**
 * Dedicated tl (Transports publics de la région lausannoise) crawler runner.
 *
 * Uses the standard crawler template with the tl parser.
 * All fetch/parse logic lives in ./lib/tl-lausanne-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTlLausanneJobs,
  isTlLausanneJob,
  isTrustedDomain,
  TL_LAUSANNE_KEY,
  TL_LAUSANNE_COMPANY_NAME,
} from './lib/tl-lausanne-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TL_LAUSANNE_KEY,
  companyLabel: TL_LAUSANNE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTlLausanneJobs,
  isCompanyJob: isTlLausanneJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ tl (Lausanne) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
