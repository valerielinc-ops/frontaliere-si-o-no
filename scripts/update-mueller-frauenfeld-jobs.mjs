#!/usr/bin/env node
/**
 * Dedicated mueller-frauenfeld crawler runner.
 *
 * Uses the standard crawler template with the mueller-frauenfeld parser.
 * All fetch/parse logic lives in ./lib/mueller-frauenfeld-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMuellerFrauenfeldJobs,
  isMuellerFrauenfeldJob,
  isTrustedDomain,
  MUELLER_FRAUENFELD_KEY,
  MUELLER_FRAUENFELD_COMPANY_NAME,
} from './lib/mueller-frauenfeld-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MUELLER_FRAUENFELD_KEY,
  companyLabel: MUELLER_FRAUENFELD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMuellerFrauenfeldJobs,
  isCompanyJob: isMuellerFrauenfeldJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ mueller-frauenfeld crawler failed: ${err?.message || err}`);
  process.exit(1);
});
