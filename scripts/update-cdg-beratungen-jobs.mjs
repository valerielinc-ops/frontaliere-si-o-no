#!/usr/bin/env node
/**
 * Dedicated cdg Beratungen AG crawler runner.
 *
 * Uses the standard crawler template with the cdg Beratungen AG parser.
 * All fetch/parse logic lives in ./lib/cdg-beratungen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCdgBeratungenJobs,
  isCdgBeratungenJob,
  isTrustedDomain,
  CDG_BERATUNGEN_KEY,
  CDG_BERATUNGEN_COMPANY_NAME,
} from './lib/cdg-beratungen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CDG_BERATUNGEN_KEY,
  companyLabel: CDG_BERATUNGEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCdgBeratungenJobs,
  isCompanyJob: isCdgBeratungenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ cdg Beratungen AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
