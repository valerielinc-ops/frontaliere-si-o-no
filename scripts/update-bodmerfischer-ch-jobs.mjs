#!/usr/bin/env node
/**
 * Dedicated BodmerFischer AG – Rechtsanwälte crawler runner.
 *
 * Uses the standard crawler template with the BodmerFischer AG – Rechtsanwälte parser.
 * All fetch/parse logic lives in ./lib/bodmerfischer-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBodmerfischerChJobs,
  isBodmerfischerChJob,
  isTrustedDomain,
  BODMERFISCHER_CH_KEY,
  BODMERFISCHER_CH_COMPANY_NAME,
} from './lib/bodmerfischer-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BODMERFISCHER_CH_KEY,
  companyLabel: BODMERFISCHER_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBodmerfischerChJobs,
  isCompanyJob: isBodmerfischerChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ BodmerFischer AG – Rechtsanwälte crawler failed: ${err?.message || err}`);
  process.exit(1);
});
