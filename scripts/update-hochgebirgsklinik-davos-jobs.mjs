#!/usr/bin/env node
/**
 * Dedicated Hochgebirgsklinik Davos crawler runner.
 *
 * Uses the standard crawler template with the Hochgebirgsklinik Davos parser.
 * All fetch/parse logic lives in ./lib/hochgebirgsklinik-davos-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHochgebirgsklinikDavosJobs,
  isHochgebirgsklinikDavosJob,
  isTrustedDomain,
  HOCHGEBIRGSKLINIK_DAVOS_KEY,
  HOCHGEBIRGSKLINIK_DAVOS_COMPANY_NAME,
} from './lib/hochgebirgsklinik-davos-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOCHGEBIRGSKLINIK_DAVOS_KEY,
  companyLabel: HOCHGEBIRGSKLINIK_DAVOS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHochgebirgsklinikDavosJobs,
  isCompanyJob: isHochgebirgsklinikDavosJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Hochgebirgsklinik Davos crawler failed: ${err?.message || err}`);
  process.exit(1);
});
