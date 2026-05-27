#!/usr/bin/env node
/**
 * Dedicated Sanatorium Kilchberg crawler runner.
 *
 * Uses the standard crawler template with the Sanatorium Kilchberg parser.
 * All fetch/parse logic lives in ./lib/sanatorium-kilchberg-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSanatoriumKilchbergJobs,
  isSanatoriumKilchbergJob,
  isTrustedDomain,
  SANATORIUM_KILCHBERG_KEY,
  SANATORIUM_KILCHBERG_COMPANY_NAME,
} from './lib/sanatorium-kilchberg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SANATORIUM_KILCHBERG_KEY,
  companyLabel: SANATORIUM_KILCHBERG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSanatoriumKilchbergJobs,
  isCompanyJob: isSanatoriumKilchbergJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Sanatorium Kilchberg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
