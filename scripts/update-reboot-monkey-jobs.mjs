#!/usr/bin/env node
/**
 * Dedicated Reboot Monkey crawler runner.
 *
 * Uses the standard crawler template with the Reboot Monkey parser.
 * All fetch/parse logic lives in ./lib/reboot-monkey-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRebootMonkeyJobs,
  isRebootMonkeyJob,
  isTrustedDomain,
  REBOOT_MONKEY_KEY,
  REBOOT_MONKEY_COMPANY_NAME,
} from './lib/reboot-monkey-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: REBOOT_MONKEY_KEY,
  companyLabel: REBOOT_MONKEY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRebootMonkeyJobs,
  isCompanyJob: isRebootMonkeyJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Reboot Monkey crawler failed: ${err?.message || err}`);
  process.exit(1);
});
