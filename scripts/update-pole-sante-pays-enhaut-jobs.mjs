#!/usr/bin/env node
/**
 * Dedicated Pôle Santé Pays-d'Enhaut crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPoleSantePaysEnhautJobs,
  isPoleSantePaysEnhautJob,
  isTrustedDomain,
  POLE_SANTE_PAYS_ENHAUT_KEY,
  POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME,
} from './lib/pole-sante-pays-enhaut-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: POLE_SANTE_PAYS_ENHAUT_KEY,
  companyLabel: POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPoleSantePaysEnhautJobs,
  isCompanyJob: isPoleSantePaysEnhautJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ PSPE crawler failed: ${err?.message || err}`);
  process.exit(1);
});
