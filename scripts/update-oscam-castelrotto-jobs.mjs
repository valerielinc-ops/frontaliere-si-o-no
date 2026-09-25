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
} from './lib/oscam-castelrotto-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OSCAM_CASTELROTTO_KEY,
  companyLabel: OSCAM_CASTELROTTO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOscamCastelrottoJobs,
  isCompanyJob: isOscamCastelrottoJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ OSCAM Castelrotto crawler failed: ${err?.message || err}`);
  process.exit(1);
});
