#!/usr/bin/env node
/**
 * Dedicated MediaMarkt crawler runner.
 *
 * Uses the standard crawler template with the MediaMarkt parser.
 * All fetch/parse logic lives in ./lib/mediamarkt-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMediamarktJobs,
  isMediamarktJob,
  isTrustedDomain,
  MEDIAMARKT_KEY,
  MEDIAMARKT_COMPANY_NAME,
} from './lib/mediamarkt-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MEDIAMARKT_KEY,
  companyLabel: MEDIAMARKT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMediamarktJobs,
  isCompanyJob: isMediamarktJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ MediaMarkt crawler failed: ${err?.message || err}`);
  process.exit(1);
});
