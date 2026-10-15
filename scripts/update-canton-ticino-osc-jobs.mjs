#!/usr/bin/env node
/**
 * Dedicated Canton Ticino OSC / DSS crawler runner.
 *
 * Aggregator-style: pulls only health-relevant concorsi from concorsi.ti.ch
 * (filtered to "Dipartimento della sanità e della socialità" or OSC topics).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCantonTicinoOscJobs,
  isCantonTicinoOscJob,
  isTrustedDomain,
  CANTON_TICINO_OSC_KEY,
  CANTON_TICINO_OSC_COMPANY_NAME,
} from './lib/canton-ticino-osc-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CANTON_TICINO_OSC_KEY,
  companyLabel: CANTON_TICINO_OSC_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCantonTicinoOscJobs,
  isCompanyJob: isCantonTicinoOscJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Canton Ticino OSC crawler failed: ${err?.message || err}`);
  process.exit(1);
});
