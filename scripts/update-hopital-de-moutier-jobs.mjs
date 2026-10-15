#!/usr/bin/env node
/**
 * Dedicated Hôpital de Moutier crawler runner.
 *
 * Uses the standard crawler template with the Hôpital de Moutier parser.
 * All fetch/parse logic lives in ./lib/hopital-de-moutier-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHopitalDeMoutierJobs,
  isHopitalDeMoutierJob,
  isTrustedDomain,
  HOPITAL_DE_MOUTIER_KEY,
  HOPITAL_DE_MOUTIER_COMPANY_NAME,
} from './lib/hopital-de-moutier-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOPITAL_DE_MOUTIER_KEY,
  companyLabel: HOPITAL_DE_MOUTIER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHopitalDeMoutierJobs,
  isCompanyJob: isHopitalDeMoutierJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Hôpital de Moutier crawler failed: ${err?.message || err}`);
  process.exit(1);
});
