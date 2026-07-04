#!/usr/bin/env node
/**
 * Dedicated Lindt & Sprüngli crawler runner.
 *
 * Uses the standard crawler template with the Lindt & Sprüngli parser.
 * All fetch/parse logic lives in ./lib/lindt-spruengli-job-parser.mjs.
 *
 * NOT the same company as the 'spruengli' crawler (Confiserie Sprüngli AG,
 * Zürich) — unaffiliated, see issue #3337 and the module doc comment in
 * lib/lindt-spruengli-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLindtSpruengliJobs,
  isLindtSpruengliJob,
  isTrustedDomain,
  LINDT_SPRUENGLI_KEY,
  LINDT_SPRUENGLI_COMPANY_NAME,
} from './lib/lindt-spruengli-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LINDT_SPRUENGLI_KEY,
  companyLabel: LINDT_SPRUENGLI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLindtSpruengliJobs,
  isCompanyJob: isLindtSpruengliJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Lindt & Sprüngli crawler failed: ${err?.message || err}`);
  process.exit(1);
});
