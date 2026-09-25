#!/usr/bin/env node
/**
 * Dedicated Hôpital de La Tour (Meyrin) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHopitalLaTourJobs,
  isHopitalLaTourJob,
  isTrustedDomain,
  HOPITAL_LA_TOUR_KEY,
  HOPITAL_LA_TOUR_COMPANY_NAME,
} from './lib/hopital-la-tour-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOPITAL_LA_TOUR_KEY,
  companyLabel: HOPITAL_LA_TOUR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHopitalLaTourJobs,
  isCompanyJob: isHopitalLaTourJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Hôpital de La Tour crawler failed: ${err?.message || err}`);
  process.exit(1);
});
