#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { withSourceLangRelabelFlags } from './lib/source-lang-relabel.mjs';
import {
  fetchAllBucherSuterJobs,
  isBucherSuterJob,
  isTrustedDomain,
  BUCHER_SUTER_KEY,
  BUCHER_SUTER_COMPANY_NAME,
} from './lib/bucher-suter-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BUCHER_SUTER_KEY,
  companyLabel: BUCHER_SUTER_COMPANY_NAME,
  root: ROOT,
  // The parser now reads the language from the body (issue 5253); jobs whose
  // stored sourceLang changed get their stale non-source slots retranslated.
  fetchJobs: withSourceLangRelabelFlags(fetchAllBucherSuterJobs, BUCHER_SUTER_KEY),
  isCompanyJob: isBucherSuterJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Bucher + Suter AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
