#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Dedicated Swiss Life crawler runner.
 *
 * Uses the standard crawler template with the Swiss Life parser.
 * All fetch/parse logic lives in ./lib/swiss-life-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSwissLifeJobs,
  isSwissLifeJob,
  isTrustedDomain,
  SWISS_LIFE_KEY,
  SWISS_LIFE_COMPANY_NAME,
} from './lib/swiss-life-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const isDirectRun = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isDirectRun) {
  runStandardCrawlerPipeline({
    companyKey: SWISS_LIFE_KEY,
    companyLabel: SWISS_LIFE_COMPANY_NAME,
    root: ROOT,
    fetchJobs: fetchAllSwissLifeJobs,
    isCompanyJob: isSwissLifeJob,
    isTrustedDomain,
    defaultSourceLang: 'de',
  }).catch((err) => {
    console.error(`❌ Swiss Life crawler failed: ${err?.message || err}`);
    process.exit(1);
  });
}
