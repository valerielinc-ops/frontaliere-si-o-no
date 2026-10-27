#!/usr/bin/env node
/**
 * Dedicated Einrichtung & Innenarchitektur – Designberatung | teo jakob crawler runner.
 *
 * Uses the standard crawler template with the Einrichtung & Innenarchitektur – Designberatung | teo jakob parser.
 * All fetch/parse logic lives in ./lib/teo-jakob-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTeoJakobJobs,
  isTeoJakobJob,
  isTrustedDomain,
  TEO_JAKOB_KEY,
  TEO_JAKOB_COMPANY_NAME,
} from './lib/teo-jakob-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TEO_JAKOB_KEY,
  companyLabel: TEO_JAKOB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTeoJakobJobs,
  isCompanyJob: isTeoJakobJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Einrichtung & Innenarchitektur – Designberatung | teo jakob crawler failed: ${err?.message || err}`);
  process.exit(1);
});
