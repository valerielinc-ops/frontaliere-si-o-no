#!/usr/bin/env node
/**
 * Dedicated Groupement Hospitalier de l'Ouest Lémanique (GHOL) crawler runner.
 *
 * Source: https://www.ghol.ch/ (Jalios JCMS → 302 → Beehire ATS).
 * Backed by the public Beehire campaigns API — no browser automation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGholJobs,
  isGholJob,
  isTrustedDomain,
  GHOL_KEY,
  GHOL_COMPANY_NAME,
} from './lib/ghol-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GHOL_KEY,
  companyLabel: GHOL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGholJobs,
  isCompanyJob: isGholJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ GHOL crawler failed: ${err?.message || err}`);
  process.exit(1);
});
