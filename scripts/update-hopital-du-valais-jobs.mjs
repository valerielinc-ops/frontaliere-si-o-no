#!/usr/bin/env node
/**
 * Dedicated Hôpital du Valais (HVS) crawler runner.
 *
 * HVS is the main hospital group in Canton Valais, with sites in
 * Sion, Sierre, Martigny, Brig, Monthey, and other locations.
 * The career portal runs on ServiceNow UXF with a public API.
 *
 * Uses the standard crawler template with the HVS ServiceNow parser.
 * All fetch/parse logic lives in ./lib/hopital-du-valais-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHvsJobs,
  isHvsJob,
  isTrustedDomain,
  HVS_KEY,
  HVS_COMPANY_NAME,
} from './lib/hopital-du-valais-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HVS_KEY,
  companyLabel: HVS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHvsJobs,
  isCompanyJob: isHvsJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ HVS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
