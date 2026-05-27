#!/usr/bin/env node
/**
 * Dedicated Matterhorn Gotthard Bahn crawler runner.
 *
 * Uses the standard crawler template with the Matterhorn Gotthard Bahn parser.
 * All fetch/parse logic lives in ./lib/matterhorn-gotthard-bahn-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMatterhornGotthardBahnJobs,
  isMatterhornGotthardBahnJob,
  isTrustedDomain,
  MATTERHORN_GOTTHARD_BAHN_KEY,
  MATTERHORN_GOTTHARD_BAHN_COMPANY_NAME,
} from './lib/matterhorn-gotthard-bahn-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MATTERHORN_GOTTHARD_BAHN_KEY,
  companyLabel: MATTERHORN_GOTTHARD_BAHN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMatterhornGotthardBahnJobs,
  isCompanyJob: isMatterhornGotthardBahnJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Matterhorn Gotthard Bahn crawler failed: ${err?.message || err}`);
  process.exit(1);
});
