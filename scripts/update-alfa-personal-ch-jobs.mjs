#!/usr/bin/env node
/**
 * Dedicated Alfa Personal GmbH crawler runner.
 *
 * Uses the standard crawler template with the Alfa Personal GmbH parser.
 * All fetch/parse logic lives in ./lib/alfa-personal-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAlfaPersonalChJobs,
  isAlfaPersonalChJob,
  isTrustedDomain,
  ALFA_PERSONAL_CH_KEY,
  ALFA_PERSONAL_CH_COMPANY_NAME,
} from './lib/alfa-personal-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ALFA_PERSONAL_CH_KEY,
  companyLabel: ALFA_PERSONAL_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAlfaPersonalChJobs,
  isCompanyJob: isAlfaPersonalChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Alfa Personal GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
