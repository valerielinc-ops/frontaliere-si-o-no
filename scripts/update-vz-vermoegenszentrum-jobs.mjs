#!/usr/bin/env node
/**
 * Dedicated VZ VermögensZentrum crawler runner.
 *
 * Uses the standard crawler template with the VZ VermögensZentrum parser.
 * All fetch/parse logic lives in ./lib/vz-vermoegenszentrum-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVzVermoegenszentrumJobs,
  isVzVermoegenszentrumJob,
  isTrustedDomain,
  VZ_VERMOEGENSZENTRUM_KEY,
  VZ_VERMOEGENSZENTRUM_COMPANY_NAME,
} from './lib/vz-vermoegenszentrum-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VZ_VERMOEGENSZENTRUM_KEY,
  companyLabel: VZ_VERMOEGENSZENTRUM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVzVermoegenszentrumJobs,
  isCompanyJob: isVzVermoegenszentrumJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ VZ VermögensZentrum crawler failed: ${err?.message || err}`);
  process.exit(1);
});
