#!/usr/bin/env node
/**
 * Dedicated GZO Spital Wetzikon crawler runner.
 *
 * Uses the standard crawler template with the GZO Wetzikon parser
 * (publicjobs.ch widget — kdNr 104453).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGzoWetzikonJobs,
  isGzoWetzikonJob,
  isTrustedDomain,
  GZO_WETZIKON_KEY,
  GZO_WETZIKON_COMPANY_NAME,
} from './lib/gzo-wetzikon-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GZO_WETZIKON_KEY,
  companyLabel: GZO_WETZIKON_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGzoWetzikonJobs,
  isCompanyJob: isGzoWetzikonJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ GZO Wetzikon crawler failed: ${err?.message || err}`);
  process.exit(1);
});
