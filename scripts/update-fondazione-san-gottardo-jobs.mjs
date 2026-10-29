#!/usr/bin/env node
/**
 * Dedicated Fondazione San Gottardo crawler runner.
 *
 * Uses the standard crawler template with the Fondazione San Gottardo parser.
 * All fetch/parse logic lives in ./lib/fondazione-san-gottardo-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFondazioneSanGottardoJobs,
  isFondazioneSanGottardoJob,
  isTrustedDomain,
  FONDAZIONE_SAN_GOTTARDO_KEY,
  FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME,
} from './lib/fondazione-san-gottardo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FONDAZIONE_SAN_GOTTARDO_KEY,
  companyLabel: FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFondazioneSanGottardoJobs,
  isCompanyJob: isFondazioneSanGottardoJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Fondazione San Gottardo crawler failed: ${err?.message || err}`);
  process.exit(1);
});
