#!/usr/bin/env node
/**
 * Dedicated CSS Versicherung crawler runner.
 *
 * Uses the standard crawler template with the CSS Versicherung parser.
 * All fetch/parse logic lives in ./lib/css-versicherung-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCssVersicherungJobs,
  isCssVersicherungJob,
  isTrustedDomain,
  CSS_VERSICHERUNG_KEY,
  CSS_VERSICHERUNG_COMPANY_NAME,
} from './lib/css-versicherung-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CSS_VERSICHERUNG_KEY,
  companyLabel: CSS_VERSICHERUNG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCssVersicherungJobs,
  isCompanyJob: isCssVersicherungJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ CSS Versicherung crawler failed: ${err?.message || err}`);
  process.exit(1);
});
