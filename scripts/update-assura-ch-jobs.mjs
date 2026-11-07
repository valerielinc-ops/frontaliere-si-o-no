#!/usr/bin/env node
/**
 * Dedicated Assura, l’assicurazione malattie al suo fianco crawler runner.
 *
 * Uses the standard crawler template with the Assura, l’assicurazione malattie al suo fianco parser.
 * All fetch/parse logic lives in ./lib/assura-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAssuraChJobs,
  isAssuraChJob,
  isTrustedDomain,
  ASSURA_CH_KEY,
  ASSURA_CH_COMPANY_NAME,
} from './lib/assura-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ASSURA_CH_KEY,
  companyLabel: ASSURA_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAssuraChJobs,
  isCompanyJob: isAssuraChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Assura, l’assicurazione malattie al suo fianco crawler failed: ${err?.message || err}`);
  process.exit(1);
});
