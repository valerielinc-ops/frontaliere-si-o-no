#!/usr/bin/env node
/**
 * Dedicated OSCAM Castelrotto crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOscamCastelrottoJobs,
  isOscamCastelrottoJob,
  isTrustedDomain,
  OSCAM_CASTELROTTO_KEY,
  OSCAM_CASTELROTTO_COMPANY_NAME,
  OSCAM_CASTELROTTO_FABRICATED_DESCRIPTION_RE,
  oscamCastelrottoMatchKey,
} from './lib/oscam-castelrotto-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OSCAM_CASTELROTTO_KEY,
  companyLabel: OSCAM_CASTELROTTO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOscamCastelrottoJobs,
  isCompanyJob: isOscamCastelrottoJob,
  isTrustedDomain,
  matchKey: oscamCastelrottoMatchKey,
  defaultSourceLang: 'it',
  // Jobs stored with the parser's former wrapper around the bando are cleaned
  // before the merge, with the translations made from it.
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, OSCAM_CASTELROTTO_FABRICATED_DESCRIPTION_RE, OSCAM_CASTELROTTO_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ OSCAM Castelrotto crawler failed: ${err?.message || err}`);
  process.exit(1);
});
