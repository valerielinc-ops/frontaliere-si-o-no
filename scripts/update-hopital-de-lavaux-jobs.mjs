#!/usr/bin/env node
/**
 * Dedicated Hôpital de Lavaux crawler runner.
 *
 * Uses the standard crawler template with the Hôpital de Lavaux parser.
 * All fetch/parse logic lives in ./lib/hopital-de-lavaux-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHopitalDeLavauxJobs,
  isHopitalDeLavauxJob,
  isTrustedDomain,
  HOPITAL_DE_LAVAUX_KEY,
  HOPITAL_DE_LAVAUX_COMPANY_NAME,
} from './lib/hopital-de-lavaux-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOPITAL_DE_LAVAUX_KEY,
  companyLabel: HOPITAL_DE_LAVAUX_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHopitalDeLavauxJobs,
  isCompanyJob: isHopitalDeLavauxJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Hôpital de Lavaux crawler failed: ${err?.message || err}`);
  process.exit(1);
});
