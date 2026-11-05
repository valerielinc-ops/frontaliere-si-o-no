#!/usr/bin/env node
/**
 * Dedicated Caisse des médecins crawler runner.
 *
 * Uses the standard crawler template with the Caisse des médecins parser.
 * All fetch/parse logic lives in ./lib/caisse-des-medecins-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCaisseDesMedecinsChJobs,
  isCaisseDesMedecinsChJob,
  isTrustedDomain,
  CAISSE_DES_MEDECINS_CH_KEY,
  CAISSE_DES_MEDECINS_CH_COMPANY_NAME,
} from './lib/caisse-des-medecins-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CAISSE_DES_MEDECINS_CH_KEY,
  companyLabel: CAISSE_DES_MEDECINS_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCaisseDesMedecinsChJobs,
  isCompanyJob: isCaisseDesMedecinsChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Caisse des médecins crawler failed: ${err?.message || err}`);
  process.exit(1);
});
