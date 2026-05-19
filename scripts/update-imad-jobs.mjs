#!/usr/bin/env node
/**
 * Dedicated imad (Genève home-care) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllImadJobs,
  isImadJob,
  isTrustedDomain,
  IMAD_KEY,
  IMAD_COMPANY_NAME,
} from './lib/imad-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IMAD_KEY,
  companyLabel: IMAD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllImadJobs,
  isCompanyJob: isImadJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ imad crawler failed: ${err?.message || err}`);
  process.exit(1);
});
