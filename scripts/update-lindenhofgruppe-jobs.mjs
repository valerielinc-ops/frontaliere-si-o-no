#!/usr/bin/env node
/**
 * Dedicated Lindenhofgruppe crawler runner.
 *
 * Uses the standard crawler template with the Lindenhofgruppe parser.
 * All fetch/parse logic lives in ./lib/lindenhofgruppe-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLindenhofgruppeJobs,
  isLindenhofgruppeJob,
  isTrustedDomain,
  LINDENHOFGRUPPE_KEY,
  LINDENHOFGRUPPE_COMPANY_NAME,
} from './lib/lindenhofgruppe-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LINDENHOFGRUPPE_KEY,
  companyLabel: LINDENHOFGRUPPE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLindenhofgruppeJobs,
  isCompanyJob: isLindenhofgruppeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Lindenhofgruppe crawler failed: ${err?.message || err}`);
  process.exit(1);
});
