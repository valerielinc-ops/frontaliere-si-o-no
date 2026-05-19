#!/usr/bin/env node
/**
 * Dedicated ipw (Integrierte Psychiatrie Winterthur) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllIpwJobs,
  isIpwJob,
  isTrustedDomain,
  IPW_KEY,
  IPW_COMPANY_NAME,
} from './lib/ipw-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IPW_KEY,
  companyLabel: IPW_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIpwJobs,
  isCompanyJob: isIpwJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ipw crawler failed: ${err?.message || err}`);
  process.exit(1);
});
