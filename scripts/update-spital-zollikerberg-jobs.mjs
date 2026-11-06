#!/usr/bin/env node
/**
 * Dedicated Spital Zollikerberg crawler runner.
 *
 * Uses the standard crawler template with the Spital Zollikerberg parser
 * (Gesundheitswelt Zollikerberg Next.js SSR → pi-asp.de detail pages).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalZollikerbergJobs,
  isSpitalZollikerbergJob,
  isTrustedDomain,
  SPITAL_ZOLLIKERBERG_KEY,
  SPITAL_ZOLLIKERBERG_COMPANY_NAME,
} from './lib/spital-zollikerberg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_ZOLLIKERBERG_KEY,
  companyLabel: SPITAL_ZOLLIKERBERG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalZollikerbergJobs,
  isCompanyJob: isSpitalZollikerbergJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Zollikerberg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
