#!/usr/bin/env node
/**
 * Dedicated Heineken Switzerland crawler runner.
 *
 * Uses the standard crawler template with the Heineken Switzerland parser.
 * All fetch/parse logic lives in ./lib/heineken-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHeinekenChJobs,
  isHeinekenChJob,
  isTrustedDomain,
  HEINEKEN_CH_KEY,
  HEINEKEN_CH_COMPANY_NAME,
} from './lib/heineken-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HEINEKEN_CH_KEY,
  companyLabel: HEINEKEN_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHeinekenChJobs,
  isCompanyJob: isHeinekenChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Heineken Switzerland crawler failed: ${err?.message || err}`);
  process.exit(1);
});
