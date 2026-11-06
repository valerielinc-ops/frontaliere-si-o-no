#!/usr/bin/env node
/**
 * Dedicated Gruppo Ospedaliero Moncucco crawler runner.
 *
 * Uses the standard crawler template with the Gruppo Ospedaliero Moncucco parser.
 * All fetch/parse logic lives in ./lib/moncucco-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { withSourceLangRelabelFlags } from './lib/source-lang-relabel.mjs';
import {
  fetchAllMoncuccoJobs,
  isMoncuccoJob,
  isTrustedDomain,
  MONCUCCO_KEY,
  MONCUCCO_COMPANY_NAME,
  MONCUCCO_FABRICATED_DESCRIPTION_RE,
} from './lib/moncucco-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MONCUCCO_KEY,
  companyLabel: MONCUCCO_COMPANY_NAME,
  root: ROOT,
  // The parser now reads the language from the body (issue 5253); jobs whose
  // stored sourceLang changed get their stale non-source slots retranslated.
  fetchJobs: withSourceLangRelabelFlags(fetchAllMoncuccoJobs, MONCUCCO_KEY),
  isCompanyJob: isMoncuccoJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, MONCUCCO_FABRICATED_DESCRIPTION_RE, MONCUCCO_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Gruppo Ospedaliero Moncucco crawler failed: ${err?.message || err}`);
  process.exit(1);
});
